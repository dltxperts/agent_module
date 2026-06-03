import { Injectable } from "@nestjs/common";
import type { ChatMessage, StreamEvent } from "./types";
import { RunEventLogService } from "../runtime/run-event-log.service";
import { RunStoreService } from "../runtime/run-store.service";
import { SessionStoreService } from "../runtime/session-store.service";
import { StartupMcpConfigService } from "../runtime/startup-mcp-config.service";
import { AgentService } from "./service";

function disabled(): boolean {
  const value = process.env.AGENT_RUNNER_DISABLED?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

@Injectable()
export class AgentRunner {
  constructor(
    private readonly runs: RunStoreService,
    private readonly sessions: SessionStoreService,
    private readonly events: RunEventLogService,
    private readonly mcp: StartupMcpConfigService,
    private readonly agent: AgentService,
  ) {}

  start(runId: string): void {
    if (disabled()) return;
    void this.execute(runId);
  }

  private async execute(runId: string): Promise<void> {
    try {
      const run = await this.runs.markRunning(runId);
      const session = await this.sessions.get(run.session_id);
      const mcpServers = this.mcp.getMany(session.mcp_server_ids);
      let fullContent = "";
      let completed = false;

      // INV-5: first turn for this session, or an engine switch since
      // the last completed run, must bootstrap fresh (+ cross-engine
      // purge); a same-engine continuation resumes the CLI session.
      const previousEngine = session.last_engine ?? null;
      const cacheMode = previousEngine === session.engine ? "resume" : "replay";

      // Stage 7: on resume the CLI session already holds the transcript,
      // so send only the new message. On replay the fresh session has
      // no history — reconstruct it from prior completed runs.
      const messages: ChatMessage[] =
        cacheMode === "resume"
          ? [run.input.message]
          : [...(await this.reconstructHistory(run.session_id, run.id)), run.input.message];

      for await (const event of this.agent.chat({
        messages,
        engine: session.engine,
        model: session.model,
        systemPrompt: session.system_prompt,
        cwd: session.cwd,
        permissionMode: session.permission_mode,
        runId: run.id,
        sessionId: session.engine_session_id,
        mcpServers,
        cacheMode,
        previousEngine,
      })) {
        if (event.type === "error") {
          await this.runs.markFailed(run.id, event.message);
          await this.append(run.id, event);
          return;
        }
        if (event.type === "done") {
          fullContent = event.full_content;
          await this.runs.markCompleted(run.id, fullContent);
          completed = true;
        }
        await this.append(run.id, event);
      }

      if (!completed) await this.runs.markCompleted(run.id, fullContent);
      // INV-5: record the engine that produced this turn so the next
      // run can decide resume vs replay.
      await this.sessions.setLastEngine(session.id, session.engine);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.events.append(runId, { type: "error", message });
      await this.runs.markFailed(runId, message);
    }
  }

  /** Rebuild the conversation transcript from prior completed runs of
   *  this session (user input + assistant output), excluding the
   *  current run. Oldest first. */
  private async reconstructHistory(
    sessionId: string,
    currentRunId: string,
  ): Promise<ChatMessage[]> {
    const prior = await this.runs.listForSession(sessionId);
    return prior
      .filter((r) => r.id !== currentRunId && r.status === "completed")
      .flatMap((r) => {
        const turn: ChatMessage[] = [r.input.message];
        if (r.output) {
          turn.push({ role: "assistant", content: r.output.full_content });
        }
        return turn;
      });
  }

  private async append(runId: string, event: StreamEvent): Promise<void> {
    switch (event.type) {
      case "engine_resolved":
        await this.events.append(runId, { type: "engine_resolved", engine: event.engine });
        return;
      case "delta":
        await this.events.append(runId, { type: "delta", content: event.content });
        return;
      case "tool_call":
        await this.events.append(runId, {
          type: "tool_call",
          id: event.id,
          name: event.name,
          args: event.args,
        });
        return;
      case "tool_result":
        await this.events.append(runId, {
          type: "tool_result",
          id: event.id,
          name: event.name,
          result: event.result,
        });
        return;
      case "warning":
        await this.events.append(runId, {
          type: "warning",
          code: event.code,
          message: event.message,
        });
        return;
      case "error":
        await this.events.append(runId, { type: "error", message: event.message });
        return;
      case "done":
        await this.events.append(runId, { type: "done", full_content: event.full_content });
        return;
    }
  }
}
