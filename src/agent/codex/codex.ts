/**
 * CodexEngine — runs OpenAI Codex CLI with MCP tools.
 *
 * Two transport modes, gated by `CODEX_ENGINE_MODE`:
 *
 *  - `"app-server"` (when an `engineSessionId` is present): drive a
 *    long-lived `codex app-server --listen stdio://` process via the
 *    JSON-RPC registry/client; one thread per session, one turn/start
 *    per turn, notifications mapped by `codex-event-mapper`.
 *    INV-CODEX-AS-1/4/12/14.
 *
 *  - default (legacy): spawn `codex exec resume` per turn with the R5
 *    fall-through. Bit-identical to behavior before this plan landed.
 *
 * Uses Codex CLI's own subscription auth (no OPENAI_API_KEY needed).
 * Connects to backend MCP via the stdio proxy for tool discovery.
 *
 * Plans:
 *  - docs/plans/agent-persistent-sessions.md (legacy resume + R5)
 *  - docs/plans/codex-engine-app-server.md (this refactor)
 */

import { spawn, type ChildProcess } from "child_process";
import type { AgentEngine, EngineRequest, StreamEvent } from "../types";
import type {
  CodexEngineDeps,
  CodexEngineMode,
  ThreadStartParams,
  TurnStartParams,
} from "./types";
import {
  bootstrapSession,
  buildCodexExecArgs,
  classifyCodexAttempt,
  codexPreSpawnLifecycle,
  defaultCodexHome,
  purgeSession,
  readCodexCliVersion,
} from "./session";
import { selectMessagesForCacheMode } from "../prompt";
import { mapCodexNotification } from "./events";
import { getDefaultCodexRegistry } from "./registry";
import { buildCodexMcpServerConfig, codexMcpAddArgs } from "../mcp";

// Lazy env reads so tests can swap `CODEX_BIN` between calls without
// re-importing the module. Module-level
// `const` would freeze the values at import time and silently
// invoke the real codex from CI when tests aim at a fake.
const codexBin = () => process.env.CODEX_BIN ?? "codex";

/**
 * Single source of truth for the codex transport default (INV-7).
 * The durable path is app-server; only an explicit
 * `CODEX_ENGINE_MODE=legacy` opts back into per-turn `codex exec`.
 * Both the engine (`resolveCodexMode`) and the startup factory
 * (`service.codexMode`) delegate here so they can never disagree.
 */
export function codexModeFromEnv(env: NodeJS.ProcessEnv): CodexEngineMode {
  return env.CODEX_ENGINE_MODE === "legacy" ? "legacy" : "app-server";
}

export function resolveCodexMode(d: CodexEngineDeps): CodexEngineMode {
  return d.mode ?? codexModeFromEnv(process.env);
}

export class CodexEngine implements AgentEngine {
  readonly name = "codex";

  constructor(private readonly deps: CodexEngineDeps = {}) {}

  async *stream(request: EngineRequest): AsyncIterable<StreamEvent> {
    const mode = resolveCodexMode(this.deps);
    const sessionId = request.engineSessionId ?? null;
    // app-server requires a session id (registry thread key). Without
    // one we fall through to the legacy exec path.
    if (mode === "app-server" && sessionId) {
      yield* this.streamViaAppServer(request, sessionId);
      return;
    }
    yield* this.streamViaLegacyExec(request);
  }

  // ── app-server path (Stage 4) ──────────────────────────────────────

  private async *streamViaAppServer(
    request: EngineRequest,
    sessionId: string,
  ): AsyncIterable<StreamEvent> {
    // INV-CODEX-AS-3: don't silently override subscription auth.
    if (process.env.OPENAI_API_KEY) {
      yield {
        type: "warning",
        code: "codex_api_key_set",
        message:
          "OPENAI_API_KEY is set; codex subscription auth may be overridden.",
      };
    }

    const registry = this.deps.registry ?? getDefaultCodexRegistry();

    // INV-CODEX-AS-7: on a replay (engine switch / first turn for codex
    // on this episode) discard the cached thread + cross-engine purge,
    // so the next turn mints a fresh thread.
    //
    // NB: we do NOT call codexPreSpawnLifecycle here — that helper
    // bootstraps the exec-path `$CODEX_HOME/state_5.sqlite` `threads`
    // row, which the app-server path does not use (it tracks threads
    // via JSON-RPC thread/start). Calling it would (a) be dead work and
    // (b) hit the real codex sqlite, breaking hermetic test runs. We
    // only need the cross-engine cleanup of the PREVIOUS engine.
    if (request.cacheMode === "replay") {
      registry.dropThread(sessionId);
      const { purgePreviousEngineSession } = await import(
        "../purge"
      );
      const { getDefaultClaudeRegistry } = await import(
        "../claude/registry"
      );
      try {
        await purgePreviousEngineSession(request.previousEngine, sessionId, {
          claudeRegistry: getDefaultClaudeRegistry(),
          codexRegistry: registry,
          cwd: request.cwd,
        });
      } catch (err) {
        console.warn(
          `[CodexEngine app-server] cross-engine purge for ${sessionId} (prev=${request.previousEngine}) failed; continuing:`,
          err,
        );
      }
    }

    const preparedMessages = selectMessagesForCacheMode(
      request.messages,
      request.cacheMode,
    );
    const turnText = [
      request.systemPrompt,
      "",
      ...preparedMessages.map((m) =>
        m.role === "user" ? m.content : `[assistant]: ${m.content}`,
      ),
    ].join("\n");

    // INV-CODEX-AS-11: MCP config + approval/sandbox go in at
    // thread/start.
    // INV-4: sandbox derived from the session's permission_mode.
    // INV-1/2: thread bound to the session cwd + model.
    const threadStartParams: ThreadStartParams = {
      approvalPolicy: "never",
      sandbox: request.permissionMode === "full" ? "danger-full-access" : "read-only",
      ...(request.cwd ? { cwd: request.cwd } : {}),
      ...(request.model ? { model: request.model } : {}),
      config: {
        mcp_servers: buildCodexMcpServerConfig({
          fixedServers: request.fixedMcpServers,
        }),
      },
    };

    let client;
    let threadId;
    try {
      const ensured = await registry.ensureThread(sessionId, threadStartParams);
      client = ensured.client;
      threadId = ensured.threadId;
    } catch (err: unknown) {
      registry.markProcessDead();
      yield {
        type: "error",
        message: err instanceof Error ? err.message : String(err),
      };
      return;
    }

    // Subscribe BEFORE turn/start so no early notification is missed.
    const notifs = client.notifications()[Symbol.asyncIterator]();

    const turnParams: TurnStartParams = {
      threadId,
      input: [{ type: "text", text: turnText, text_elements: [] }],
      approvalPolicy: "never",
    };

    let fullContent = "";
    // Single try/finally around BOTH turn/start AND the drain loop so
    // the shared client's notification consumer is released on every
    // exit path — including a turn/start rejection (Codex round-2
    // finding A). INV-CODEX-AS-2 broadcast Set would otherwise leak.
    try {
      try {
        await client.request("turn/start", turnParams);
      } catch (err: unknown) {
        registry.markProcessDead();
        yield {
          type: "error",
          message: err instanceof Error ? err.message : String(err),
        };
        return;
      }

      for (;;) {
        const { value, done } = await notifs.next();
        if (done) {
          // Stream ended before turn/completed → process died.
          registry.markProcessDead();
          yield { type: "error", message: "codex app-server stream ended mid-turn" };
          return;
        }
        const params = (value.params ?? {}) as { threadId?: string };
        // Only this thread's notifications matter (one process
        // multiplexes many threads).
        if (params.threadId && params.threadId !== threadId) continue;

        const mapped = mapCodexNotification(value);
        if (mapped) {
          if (mapped.type === "delta") fullContent += mapped.content;
          yield mapped;
        }
        if (value.method === "turn/completed" && params.threadId === threadId) {
          break;
        }
      }
    } finally {
      await notifs.return?.(undefined as never);
    }

    yield { type: "done", full_content: fullContent };
  }

  // ── legacy path (one codex exec per turn) ──────────────────────────

  private async *streamViaLegacyExec(
    request: EngineRequest,
  ): AsyncIterable<StreamEvent> {
    // R7 BLOCK 2 / INV-SESSION-7: select transcript for the resume
    // path. The R5 fall-through below ALWAYS uses the full transcript
    // (built separately via `buildPromptForMessages`) so a failed
    // resume rebuilds the conversation from scratch rather than from
    // the trimmed single-message resume prompt.
    const preparedMessages = selectMessagesForCacheMode(
      request.messages,
      request.cacheMode,
    );
    const buildPromptForMessages = (msgs: { role: string; content: string }[]) =>
      [
        request.systemPrompt,
        "",
        ...msgs.map((m) =>
          m.role === "user" ? m.content : `[assistant]: ${m.content}`,
        ),
      ].join("\n");
    const fullPrompt = buildPromptForMessages(preparedMessages);

    // Register the session's startup-configured MCP servers for this
    // run, then clean them up in `finally`. The app-server path (the
    // default) passes MCP via thread/start config instead; this global
    // `codex mcp add`/`remove` dance is the legacy fallback only.
    const fixedServers = (request.fixedMcpServers ?? []).filter((s) => s.enabled);
    // Persistent CLI session lifecycle (Stage 6 + R10): delegate to
    // `codexPreSpawnLifecycle` so the dispatch logic is testable
    // without spawning a real codex CLI. Plan:
    // docs/plans/agent-persistent-sessions.md (INV-SESSION-1,
    // INV-SESSION-4, INV-SESSION-9, R10).
    const sessionId = request.engineSessionId ?? null;
    await codexPreSpawnLifecycle({
      sessionId,
      cacheMode: request.cacheMode,
      previousEngine: request.previousEngine,
      cwd: request.cwd ?? process.cwd(),
      codexBin: codexBin(),
    });

    try {
      // Register each configured MCP server (best-effort: tolerate
      // "already exists" from a concurrent run under the same id).
      for (const server of fixedServers) {
        await this.exec(codexBin(), codexMcpAddArgs(server)).catch(() => {});
      }

      // Attempt loop (INV-SESSION-5): try `exec resume <uuid>`; on a
      // missing-rollout failure (codex finds the threads row but the
      // .jsonl is gone), purge + re-bootstrap and try once more.
      // If both resume attempts fail, R5 fall-through: ONE final
      // non-resume `codex exec <prompt>` so the user still gets a
      // response (degraded — codex starts a fresh session with
      // whatever transcript we have).
      let fullContent = "";
      let attempt = 0;
      let resumeStderr = "";
      let resumeExhausted = false;

      while (attempt < 2) {
        const stderrBuf: string[] = [];
        const execArgs = buildCodexExecArgs({
          fullPrompt,
          engineSessionId: sessionId,
          model: request.model,
          permissionMode: request.permissionMode,
        });
        const child = spawn(codexBin(), execArgs, {
          stdio: ["pipe", "pipe", "pipe"],
          env: this.buildRestrictedEnv(),
          cwd: request.cwd,
        });
        // Settle on exit OR spawn error (e.g. ENOENT for a missing
        // codex binary emits 'error', not 'exit'). Attached BEFORE any
        // await so the listener can't miss an early event.
        const childSettled = new Promise<number | null>((resolve) => {
          if (child.exitCode != null) {
            resolve(child.exitCode);
            return;
          }
          child.once("exit", (code) => resolve(code));
          child.once("error", () => resolve(null));
        });
        child.stdin?.end();
        child.stderr?.on("data", (chunk: Buffer) =>
          stderrBuf.push(chunk.toString()),
        );

        let producedEvents = false;
        let streamErrored = false;
        try {
          for await (const ev of this.parseStream(child, (text) => {
            fullContent += text;
          })) {
            producedEvents = true;
            yield ev;
          }
        } catch (err: unknown) {
          streamErrored = true;
          yield {
            type: "error",
            message: err instanceof Error ? err.message : String(err),
          };
        }

        // Wait for the child to fully exit so `exitCode` is set.
        const exitCode = await childSettled;

        const stderrText = stderrBuf.join("");
        resumeStderr = stderrText;

        // Dispatch on the observable outcome — the decision logic
        // lives in `classifyCodexAttempt` so it can be unit-tested
        // without spawning a real codex (see
        // tst_agent_unit_codex_attempt_decision_001..006).
        const decision = classifyCodexAttempt({
          attempt,
          hasSessionId: sessionId != null,
          streamErrored,
          producedEvents,
          exitCode,
          stderr: stderrText,
        });

        if (decision === "fatal") {
          return;
        }
        if (decision === "success") {
          yield { type: "done", full_content: fullContent };
          return;
        }
        if (decision === "retry_with_bootstrap" && sessionId) {
          console.warn(
            `[CodexEngine] resume failed for ${sessionId} (missing rollout); purging + bootstrapping + retrying once`,
          );
          try {
            const codexHome = defaultCodexHome();
            await purgeSession(codexHome, sessionId);
            await bootstrapSession({
              codexHome,
              uuid: sessionId,
              cwd: request.cwd ?? process.cwd(),
              cliVersion: readCodexCliVersion(codexBin()),
            });
          } catch (err) {
            console.warn(
              `[CodexEngine] re-bootstrap raised; falling through to replay-from-messages:`,
              err,
            );
            resumeExhausted = true;
            break;
          }
          attempt++;
          continue;
        }

        // `decision === "fall_through"` — resume path is exhausted.
        // Drop into R5 fall-through below.
        resumeExhausted = true;
        break;
      }

      if (resumeExhausted && sessionId) {
        // R5 / INV-SESSION-5: emit a single warning event AND run a
        // plain `codex exec <prompt>` so codex starts a fresh session
        // and we still produce a response. The warning event reaches
        // the user as a typed `warning` SSE entry so the frontend can
        // surface "session lost, replaying" instead of silently
        // degrading. The fallback prompt is rebuilt from the FULL
        // transcript (`request.messages`) — NOT the trimmed
        // resume-mode prompt — so context is preserved even though
        // the CLI session itself is fresh.
        // Plan: docs/plans/agent-persistent-sessions.md INV-SESSION-5.
        console.warn(
          `[CodexEngine] resume path exhausted for ${sessionId}; falling through to replay-from-messages. Last stderr: ${resumeStderr.slice(0, 200)}`,
        );
        yield {
          type: "warning",
          code: "codex_session_replay",
          message:
            "Codex session unavailable — replaying conversation in a fresh session. Some CLI-level state (tool memoization, prior reasoning traces) is reset.",
        };

        // R5 fall-through rebuilds from the FULL transcript, not the
        // trimmed resume slice.
        const fbFullPrompt = buildPromptForMessages(request.messages);

        const fbStderrBuf: string[] = [];
        const fbArgs = buildCodexExecArgs({
          fullPrompt: fbFullPrompt,
          model: request.model,
          permissionMode: request.permissionMode,
        });
        const fbChild = spawn(codexBin(), fbArgs, {
          stdio: ["pipe", "pipe", "pipe"],
          env: this.buildRestrictedEnv(),
          cwd: request.cwd,
        });
        const fbSettled = new Promise<number | null>((resolve) => {
          if (fbChild.exitCode != null) {
            resolve(fbChild.exitCode);
            return;
          }
          fbChild.once("exit", (code) => resolve(code));
          fbChild.once("error", () => resolve(null));
        });
        fbChild.stdin?.end();
        fbChild.stderr?.on("data", (chunk: Buffer) =>
          fbStderrBuf.push(chunk.toString()),
        );

        let fbProducedEvents = false;
        try {
          for await (const ev of this.parseStream(fbChild, (text) => {
            fullContent += text;
          })) {
            fbProducedEvents = true;
            yield ev;
          }
        } catch (err: unknown) {
          yield {
            type: "error",
            message: err instanceof Error ? err.message : String(err),
          };
          return;
        }

        const fbExitCode = await fbSettled;

        if (fbExitCode === 0 || fbProducedEvents) {
          yield { type: "done", full_content: fullContent };
          return;
        }

        yield {
          type: "error",
          message: `codex fallback exec failed (exit=${fbExitCode}): ${fbStderrBuf.join("").slice(0, 500)}. Original resume stderr: ${resumeStderr.slice(0, 200)}`,
        };
        return;
      }

      // Resume exhausted without a sessionId (shouldn't normally
      // happen) → surface the last error so callers see something.
      yield {
        type: "error",
        message: `codex exec failed: ${resumeStderr.slice(0, 500)}`,
      };
    } finally {
      // Clean up MCP server registrations.
      for (const server of fixedServers) {
        await this.exec(codexBin(), ["mcp", "remove", server.id]).catch(() => {});
      }
    }
  }

  private buildRestrictedEnv(): NodeJS.ProcessEnv {
    return {
      HOME: process.env.HOME,
      PATH: process.env.PATH,
      USER: process.env.USER,
      LOGNAME: process.env.LOGNAME,
      SHELL: process.env.SHELL,
      TMPDIR: process.env.TMPDIR,
      TERM: process.env.TERM,
      COLORTERM: process.env.COLORTERM,
      LANG: process.env.LANG,
      LC_ALL: process.env.LC_ALL,
      LC_CTYPE: process.env.LC_CTYPE,
      NO_COLOR: process.env.NO_COLOR,
      FORCE_COLOR: process.env.FORCE_COLOR,
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
      OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
      OPENAI_ORG_ID: process.env.OPENAI_ORG_ID,
      OPENAI_PROJECT_ID: process.env.OPENAI_PROJECT_ID,
      CODEX_HOME: process.env.CODEX_HOME,
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
      XDG_CACHE_HOME: process.env.XDG_CACHE_HOME,
      XDG_STATE_HOME: process.env.XDG_STATE_HOME,
    };
  }

  private exec(cmd: string, args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(cmd, args, { stdio: "pipe" });
      child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`${cmd} exit ${code}`)));
      child.on("error", reject);
    });
  }

  private async *parseStream(
    child: ChildProcess,
    onText: (text: string) => void,
  ): AsyncIterable<StreamEvent> {
    // Drain stderr without blocking the generator
    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text) console.error("[CodexEngine stderr]", text.slice(0, 200));
    });

    let buffer = "";

    for await (const chunk of child.stdout!) {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.trim()) continue;
        for (const ev of this.parseLines(line.trim(), onText)) yield ev;
      }
    }

    if (buffer.trim()) {
      for (const ev of this.parseLines(buffer.trim(), onText)) yield ev;
    }
  }

  private parseLines(
    line: string,
    onText: (text: string) => void,
  ): StreamEvent[] {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line);
    } catch {
      return [];
    }

    const type = event.type as string | undefined;
    const item = event.item as Record<string, unknown> | undefined;
    if (!item) return [];

    console.log(`[CodexEngine] ${type} item.type=${item.type} id=${item.id} tool=${(item as Record<string,unknown>).tool ?? "-"} result=${item.result != null} error=${item.error != null}`);

    // item.started: emit tool_call when MCP tool begins
    if (type === "item.started" && item.type === "mcp_tool_call") {
      const toolName = `${item.tool as string}`;
      return [{
        type: "tool_call",
        id: (item.id as string) ?? "",
        name: toolName,
        args: item.arguments ?? {},
      }];
    }

    // item.completed: agent text or MCP tool result
    if (type === "item.completed") {
      if (item.type === "agent_message" && typeof item.text === "string") {
        onText(item.text);
        return [{ type: "delta", content: item.text }];
      }

      if (item.type === "mcp_tool_call") {
        const id = (item.id as string) ?? "";
        const toolName = (item.tool as string) ?? "";

        // result is { content: [{type:"text", text:"..."}], structured_content } or null
        const resultObj = item.result as Record<string, unknown> | null;
        const contentArr = resultObj?.content as Array<Record<string, unknown>> | undefined;

        if (contentArr && Array.isArray(contentArr)) {
          const textParts = contentArr
            .filter((c) => c.type === "text" && typeof c.text === "string")
            .map((c) => c.text as string);
          const raw = textParts.join("");
          let parsed: unknown;
          try {
            parsed = JSON.parse(raw);
          } catch {
            parsed = { text: raw.slice(0, 2000) };
          }
          return [{ type: "tool_result" as const, id, name: toolName, result: parsed }];
        }

        if (item.error) {
          const errMsg = (item.error as Record<string, unknown>)?.message ?? String(item.error);
          return [{ type: "tool_result" as const, id, name: toolName, result: { error: errMsg } }];
        }

        return [];
      }
    }

    return [];
  }
}
