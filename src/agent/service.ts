import { Injectable } from "@nestjs/common";
import { ClaudeEngine } from "./claude/claude";
import { CodexEngine, codexModeFromEnv } from "./codex/codex";
import type {
  AgentEngine,
  ChatMessage,
  EngineMcpServer,
  StreamEvent,
  UIContext,
} from "./types";
import { buildSeedContext } from "../prompts/context";
import { formatSkillsSection, loadInstalledSkills } from "../prompts/skills";
import { purgeAllEngineState } from "./purge";
import { getDefaultClaudeRegistry } from "./claude/registry";
import { getDefaultCodexRegistry } from "./codex/registry";
import type { AgentSession } from "../runtime/types";

export interface EngineSummary {
  id: string;
  enabled: true;
  session_mode: "persistent";
  transport: "cli" | "app-server";
}

// INV-7: re-export the single codex mode resolver so the startup
// factory and the engine can never disagree on the default.
export const codexMode = codexModeFromEnv;

export function createEngines(env: NodeJS.ProcessEnv): AgentEngine[] {
  return [
    new ClaudeEngine(),
    new CodexEngine({ mode: codexMode(env) }),
  ];
}

export function orderEngines(
  engines: AgentEngine[],
  defaultName: string | undefined,
): AgentEngine[] {
  if (!defaultName) return engines;

  const selected = engines.find((engine) => engine.name === defaultName);
  if (!selected) {
    throw new Error(
      `DEFAULT_ENGINE=${defaultName} is not enabled. Enabled engines: ${engines.map((engine) => engine.name).join(", ")}`,
    );
  }

  return [
    selected,
    ...engines.filter((engine) => engine.name !== defaultName),
  ];
}

function sanitizeModel(engineName: string, model?: string): string | undefined {
  if (!model) return undefined;
  if (engineName === "claude" && !model.startsWith("claude")) return undefined;
  return model;
}

export function injectSeedContext(messages: ChatMessage[], seedContext: string): ChatMessage[] {
  if (!seedContext || messages.length === 0) return messages;

  const result = [...messages];
  for (let i = result.length - 1; i >= 0; i--) {
    if (result[i].role === "user") {
      result[i] = { ...result[i], content: seedContext + result[i].content };
      break;
    }
  }
  return result;
}

@Injectable()
export class AgentService {
  private readonly engines: Map<string, AgentEngine>;

  constructor() {
    this.engines = new Map(
      orderEngines(createEngines(process.env), process.env.DEFAULT_ENGINE)
        .map((engine) => [engine.name, engine]),
    );
  }

  /** INV-6: drop all persistent CLI state for a session so the next
   *  run bootstraps fresh with the current session config. */
  async resetSession(session: AgentSession): Promise<void> {
    await purgeAllEngineState(session.engine_session_id, {
      claudeRegistry: getDefaultClaudeRegistry(),
      codexRegistry: getDefaultCodexRegistry(),
      cwd: session.cwd,
    });
  }

  listEngines(): EngineSummary[] {
    return Array.from(this.engines.values()).map((engine) => ({
      id: engine.name,
      enabled: true,
      session_mode: "persistent",
      transport: engine.name === "codex" && codexMode(process.env) === "app-server"
        ? "app-server"
        : "cli",
    }));
  }

  async *chat(input: {
    messages: ChatMessage[];
    context?: UIContext;
    engine: string;
    model?: string;
    systemPrompt?: string;
    cwd?: string;
    permissionMode?: "restricted" | "full";
    runId: string;
    sessionId: string;
    mcpServers: EngineMcpServer[];
    cacheMode?: "replay" | "resume";
    previousEngine?: string | null;
  }): AsyncIterable<StreamEvent> {
    const engine = this.engines.get(input.engine);
    if (!engine) {
      yield { type: "error", message: `Unknown engine: ${input.engine}` };
      return;
    }

    // INV-3: the system prompt comes from the session, not a hardcoded
    // app-specific persona. Installed skills (when an AGENT_SKILLS_DIR
    // is configured) are appended as discovery hints.
    const skills = formatSkillsSection(loadInstalledSkills());
    const systemPrompt = [input.systemPrompt ?? "", skills]
      .map((s) => s.trim())
      .filter(Boolean)
      .join("\n\n");
    const messages = injectSeedContext(input.messages, buildSeedContext(input.context));

    yield { type: "engine_resolved", engine: engine.name };
    yield* engine.stream({
      messages,
      systemPrompt,
      maxSteps: 12,
      model: sanitizeModel(engine.name, input.model),
      cwd: input.cwd,
      permissionMode: input.permissionMode,
      turnId: input.runId,
      engineSessionId: input.sessionId,
      cacheMode: input.cacheMode,
      previousEngine: input.previousEngine ?? null,
      fixedMcpServers: input.mcpServers,
    });
  }
}
