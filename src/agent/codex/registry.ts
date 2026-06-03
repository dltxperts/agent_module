/**
 * CodexAppServerRegistry — process-wide singleton owning ONE
 * `codex app-server` child + its JSON-RPC client, plus a
 * session→threadId map.
 *
 * Unlike the claude side (one process per session), codex app-server
 * hosts N threads in ONE process, so the registry holds a single
 * client and mints a thread per session (INV-CODEX-AS-1/2).
 *
 * Thread ids persist across a process death (codex stores threads on
 * disk); after `markProcessDead()` the next `ensureThread()` respawns,
 * re-initializes, and `thread/resume`s the cached thread id
 * (INV-CODEX-AS-9).
 *
 * Plan: docs/plans/codex-engine-app-server.md Stage 2.
 */

import { spawn } from "child_process";
import { createCodexAppServerClient } from "./app-client";
import { autoApproveResult } from "./approval";
import type {
  CodexAppServerClient,
  CodexAppServerRegistry,
  EnsureThreadResult,
  CodexRegistryDeps,
  InitializeParams,
  ThreadResumeParams,
  ThreadStartParams,
  ThreadStartResult,
} from "./types";

const DEFAULT_INITIALIZE: InitializeParams = {
  clientInfo: { name: "agent-runtime", version: "1.0.0" },
  capabilities: null,
};

function defaultSpawnClient(): CodexAppServerClient {
  const bin = process.env.CODEX_BIN ?? "codex";
  const child = spawn(bin, ["app-server", "--listen", "stdio://"], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env },
  });
  return createCodexAppServerClient(child);
}

export function createCodexAppServerRegistry(
  deps: CodexRegistryDeps = {},
): CodexAppServerRegistry {
  const spawnClient = deps.spawnClient ?? defaultSpawnClient;
  const initializeParams = deps.initializeParams ?? DEFAULT_INITIALIZE;

  let client: CodexAppServerClient | null = null;
  let initialized = false;
  // In-flight client bring-up; dedupes concurrent ensureThread so two
  // sessions starting at once don't both spawn a process (Codex #1).
  let clientInitInFlight: Promise<CodexAppServerClient> | null = null;
  // Persists across process death (codex stores threads on disk).
  const threadIds = new Map<string, string>();
  // Threads resumed/started in the CURRENT process generation. Cleared
  // on markProcessDead so the next ensureThread re-resumes.
  const liveThreads = new Set<string>();
  // In-flight per-session thread bring-up; dedupes concurrent
  // ensureThread for the SAME session so thread/start fires once.
  const threadInFlight = new Map<string, Promise<EnsureThreadResult>>();

  function resetProcess(): void {
    client = null;
    initialized = false;
    clientInitInFlight = null;
    liveThreads.clear();
  }

  async function ensureClient(): Promise<CodexAppServerClient> {
    if (client && initialized) return client;
    if (clientInitInFlight) return clientInitInFlight;
    clientInitInFlight = (async () => {
      const c = spawnClient();
      // Idle-death recovery (Codex #3): when the child dies, drop the
      // singleton so the next ensureThread respawns + thread/resume's.
      c.onClose(() => {
        if (client === c) resetProcess();
      });
      // Auto-answer server→client requests (MCP elicitation + approvals)
      // so MCP tool calls don't hang the turn waiting for a reply.
      // Live dogfood finding — see codex-server-request-policy.
      c.onServerRequest((req) => {
        c.respond(req.id, autoApproveResult(req));
      });
      await c.request("initialize", initializeParams);
      client = c;
      initialized = true;
      return c;
    })();
    try {
      return await clientInitInFlight;
    } finally {
      clientInitInFlight = null;
    }
  }

  return {
    ensureThread(
      sessionId: string,
      threadStartParams?: ThreadStartParams,
    ): Promise<EnsureThreadResult> {
      const inFlight = threadInFlight.get(sessionId);
      if (inFlight) return inFlight;
      const p = (async (): Promise<EnsureThreadResult> => {
        const c = await ensureClient();
        const existing = threadIds.get(sessionId);

        if (existing && liveThreads.has(sessionId)) {
          return { client: c, threadId: existing };
        }

        if (existing) {
          // Known thread but a fresh process generation — resume it.
          const resumeParams: ThreadResumeParams = { threadId: existing };
          await c.request("thread/resume", resumeParams);
          liveThreads.add(sessionId);
          return { client: c, threadId: existing };
        }

        // First turn for this session — mint a thread.
        const result = (await c.request(
          "thread/start",
          threadStartParams ?? {},
        )) as ThreadStartResult;
        const threadId = result.thread.id;
        threadIds.set(sessionId, threadId);
        liveThreads.add(sessionId);
        return { client: c, threadId };
      })();
      threadInFlight.set(sessionId, p);
      // Clear the in-flight entry on settle. Use then(onF, onR) rather
      // than `void p.finally(...)`: .finally() returns a NEW promise
      // that re-rejects on failure, and voiding it leaves an unhandled
      // rejection that crashes Bun even though the caller handles `p`.
      // Both arms swallow into a void cleanup so this chain resolves;
      // the caller's own `p` reference still carries the rejection.
      const clearInFlight = () => {
        threadInFlight.delete(sessionId);
      };
      p.then(clearInFlight, clearInFlight);
      return p;
    },

    dropThread(sessionId: string): void {
      threadIds.delete(sessionId);
      liveThreads.delete(sessionId);
    },

    markProcessDead(): void {
      resetProcess();
    },

    async shutdown(): Promise<void> {
      if (client) {
        await client.close();
        client = null;
        initialized = false;
      }
      liveThreads.clear();
    },
  };
}

// Process-wide singleton, used when no registry is injected. Env knob
// CODEX_BIN is read by defaultSpawnClient.
let defaultRegistry: CodexAppServerRegistry | null = null;
export function getDefaultCodexRegistry(): CodexAppServerRegistry {
  if (!defaultRegistry) defaultRegistry = createCodexAppServerRegistry();
  return defaultRegistry;
}
