/**
 * ClaudeEngine — runs Claude Code CLI with MCP tools.
 *
 * Two transport modes, gated by `CLAUDE_ENGINE_MODE`:
 *
 *  - `"stream-json"` (when an `engineSessionId` is present): obtain a
 *    long-lived child process from `ClaudeProcessRegistry`, push each
 *    turn through a `ClaudeStreamClient`, iterate raw events until
 *    `result/*`, and map them via the shared `mapRawToStreamEvent`
 *    helper. INV-STREAM-1 / -3 / -4 / -15.
 *
 *  - default (legacy): spawn one `claude` per turn with a `--prompt`
 *    argument, parse JSONL stdout, exit after the reply. Bit-identical
 *    to behavior before this plan landed.
 *
 * Uses Claude Code's own subscription auth (no `ANTHROPIC_API_KEY`
 * required). Connects to the backend MCP via the stdio proxy so
 * Claude Code can discover and call all backend tools natively.
 *
 * Plans:
 *  - docs/plans/agent-persistent-sessions.md (R11 + cross-engine purge)
 *  - docs/plans/claude-engine-stream-json.md (this refactor)
 */

import { spawn, type ChildProcess } from "child_process";
import { existsSync } from "fs";
import type { AgentEngine, EngineRequest, StreamEvent } from "../types";
import type {
  ClaudeEngineDeps,
  ClaudeEngineMode,
  ClaudeStreamClient,
  StreamJsonArgs,
} from "./types";
import {
  buildClaudeArgs,
  claudePermissionArgs,
  claudePreSpawnCleanup,
  defaultClaudeSessionPath,
} from "./session";
import { selectMessagesForCacheMode } from "../prompt";
import { mapRawToStreamEvent } from "./events";
import { getDefaultClaudeRegistry } from "./registry";
import { createClaudeStreamClient } from "./stream";
import {
  buildClaudeMcpConfig,
  buildClaudeMcpToolScope,
} from "../mcp";

function resolveMode(d: ClaudeEngineDeps): ClaudeEngineMode {
  if (d.mode) return d.mode;
  // Stage 7: stream-json is now the default. Set
  // `CLAUDE_ENGINE_MODE=legacy` to fall back to per-turn spawn.
  return process.env.CLAUDE_ENGINE_MODE === "legacy"
    ? "legacy"
    : "stream-json";
}

// Default registry comes from claude-process-registry where the env-
// driven knobs (CLAUDE_PROCESS_POOL_SIZE, CLAUDE_PROCESS_IDLE_MS) +
// production idle sweeper live.

export class ClaudeEngine implements AgentEngine {
  readonly name = "claude";

  // engineSessionId → ClaudeStreamClient. Cached so consecutive turns
  // on the same session reuse one client (and thus one child process).
  // INV-STREAM-1.
  private readonly clients = new Map<string, ClaudeStreamClient>();

  constructor(private readonly deps: ClaudeEngineDeps = {}) {}

  async *stream(request: EngineRequest): AsyncIterable<StreamEvent> {
    const mode = resolveMode(this.deps);
    const sessionId = request.engineSessionId ?? null;

    // Stream-json requires a session id (registry key + per-turn
    // client cache key). Without one we fall through to legacy.
    if (mode === "stream-json" && sessionId) {
      yield* this.streamViaStreamJson(request, sessionId);
      return;
    }

    yield* this.streamViaLegacy(request);
  }

  // ── stream-json path (Stage 3) ─────────────────────────────────────

  private async *streamViaStreamJson(
    request: EngineRequest,
    sessionId: string,
  ): AsyncIterable<StreamEvent> {
    // INV-STREAM-2: subscription must NOT be silently overridden by
    // an API key. Flag-and-continue.
    if (process.env.ANTHROPIC_API_KEY) {
      yield {
        type: "warning",
        code: "claude_api_key_set",
        message:
          "ANTHROPIC_API_KEY is set; subscription auth may be overridden by the CLI.",
      };
    }

    // INV-STREAM-7 / -14: on a replay we must also drop any
    // long-lived child this engine is holding for the same session.
    // Without this, a cross-engine switch keeps a stale process
    // alive that would respond from the wrong conversation state on
    // the next turn.
    const registry = this.deps.registry ?? getDefaultClaudeRegistry();
    if (request.cacheMode === "replay") {
      await registry.purge(sessionId);
      this.clients.delete(sessionId);
    }

    // Pre-spawn cleanup (purge / resume decision). Shared with legacy.
    await claudePreSpawnCleanup({
      sessionId,
      cacheMode: request.cacheMode,
      previousEngine: request.previousEngine,
      cwd: request.cwd,
    });

    const preparedMessages = selectMessagesForCacheMode(
      request.messages,
      request.cacheMode,
    );

    // INV-STREAM-11: MCP config goes in via --mcp-config at spawn,
    // not per-turn. R11 still owns the --resume vs --session-id
    // decision via `existsSync` on the rollout file.
    const mcpConfig = buildClaudeMcpConfig({
      fixedServers: request.fixedMcpServers,
    });
    const mcpTools = buildClaudeMcpToolScope(request.fixedMcpServers);
    const model = request.model ?? process.env.CLAUDE_MODEL;
    const resumeSession = existsSync(
      defaultClaudeSessionPath(sessionId, request.cwd),
    );

    const handle = registry.acquire(sessionId, {
      args: buildStreamJsonArgs({
        systemPrompt: request.systemPrompt,
        maxSteps: request.maxSteps,
        mcpConfig,
        mcpTools,
        model,
        permissionMode: request.permissionMode,
        engineSessionId: sessionId,
        resumeSession,
      }),
      cwd: request.cwd,
    });

    let client = this.clients.get(sessionId);
    if (!client) {
      const create = this.deps.createClient ?? createClaudeStreamClient;
      client = create(handle.child);
      this.clients.set(sessionId, client);
    }

    const fullPrompt = preparedMessages
      .map((m) =>
        m.role === "user" ? m.content : `[assistant]: ${m.content}`,
      )
      .join("\n\n");

    await client.send(fullPrompt);

    let fullContent = "";
    for await (const raw of client.events()) {
      if (raw.type === "error") {
        yield {
          type: "error",
          message: String(raw.message ?? "claude child error"),
        };
        this.clients.delete(sessionId);
        return;
      }

      if (raw.type === "system" && raw.subtype === "init") {
        const id = raw.session_id;
        if (typeof id === "string" && id !== sessionId) {
          yield {
            type: "warning",
            code: "claude_session_id_mismatch",
            message: `expected session_id=${sessionId}, binary reported ${id}`,
          };
        }
      }

      const mapped = mapRawToStreamEvent(
        raw as Record<string, unknown>,
        (t) => {
          fullContent += t;
        },
      );
      if (mapped) yield mapped;

      if (raw.type === "result") break;
    }

    yield { type: "done", full_content: fullContent };
  }

  // ── legacy path (one process per turn) ─────────────────────────────

  private async *streamViaLegacy(
    request: EngineRequest,
  ): AsyncIterable<StreamEvent> {
    const preparedMessages = selectMessagesForCacheMode(
      request.messages,
      request.cacheMode,
    );
    const fullPrompt = preparedMessages
      .map((m) =>
        m.role === "user" ? m.content : `[assistant]: ${m.content}`,
      )
      .join("\n\n");

    const mcpConfig = buildClaudeMcpConfig({
      fixedServers: request.fixedMcpServers,
    });
    const mcpTools = buildClaudeMcpToolScope(request.fixedMcpServers);

    const model = request.model ?? process.env.CLAUDE_MODEL;
    const sessionId = request.engineSessionId ?? null;
    await claudePreSpawnCleanup({
      sessionId,
      cacheMode: request.cacheMode,
      previousEngine: request.previousEngine,
      cwd: request.cwd,
    });

    const resumeSession = sessionId
      ? existsSync(defaultClaudeSessionPath(sessionId, request.cwd))
      : false;

    const args = buildClaudeArgs({
      fullPrompt,
      systemPrompt: request.systemPrompt,
      maxSteps: request.maxSteps,
      mcpConfig,
      mcpTools,
      model,
      permissionMode: request.permissionMode,
      engineSessionId: sessionId,
      resumeSession,
    });

    const child = spawn("claude", args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
      cwd: request.cwd,
    });
    child.stdin.end();

    let fullContent = "";
    let eventCount = 0;
    try {
      for await (const line of legacyStdoutLines(child)) {
        eventCount++;
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(line);
        } catch {
          console.warn(`[ClaudeEngine] unparseable line: ${line.slice(0, 80)}`);
          continue;
        }
        const ev = mapRawToStreamEvent(parsed, (t) => {
          fullContent += t;
        });
        if (ev) {
          console.log(
            `[ClaudeEngine] event #${eventCount}: type=${ev.type}${
              ev.type === "delta" ? ` len=${ev.content.length}` : ""
            }`,
          );
          yield ev;
        }
      }
      console.log(
        `[ClaudeEngine] stream done: ${eventCount} events, fullContent=${fullContent.length} chars`,
      );
      yield { type: "done", full_content: fullContent };
    } catch (err: unknown) {
      console.error(
        `[ClaudeEngine] stream error after ${eventCount} events:`,
        err,
      );
      yield {
        type: "error",
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

function buildStreamJsonArgs(params: StreamJsonArgs): string[] {
  const args = [
    "--print",
    "--verbose",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
  ];
  // INV-3: omit --system-prompt when the session sets none.
  if (params.systemPrompt) args.push("--system-prompt", params.systemPrompt);
  args.push(
    "--max-turns",
    String(Math.min(params.maxSteps, 30)),
    "--mcp-config",
    params.mcpConfig,
    "--strict-mcp-config",
    // INV-4: permission/tool flags derived from the session's
    // permission_mode (shared with buildClaudeArgs). In --print mode
    // these flags are what let claude EXECUTE tool calls without an
    // (impossible, no-TTY) permission prompt.
    ...claudePermissionArgs(params.permissionMode, params.mcpTools ?? "mcp__*"),
  );
  // INV-2: only pass --model when one was resolved.
  if (params.model) args.push("--model", params.model);
  if (params.resumeSession) {
    args.push("--resume", params.engineSessionId);
  } else {
    args.push("--session-id", params.engineSessionId);
  }
  return args;
}

async function* legacyStdoutLines(
  child: ChildProcess,
): AsyncIterable<string> {
  child.stderr?.on("data", (chunk: Buffer) => {
    const text = chunk.toString().trim();
    if (text) console.error("[ClaudeEngine stderr]", text.slice(0, 200));
  });
  let buffer = "";
  for await (const chunk of child.stdout!) {
    buffer += chunk.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const t = line.trim();
      if (t) yield t;
    }
  }
  const t = buffer.trim();
  if (t) yield t;
}
