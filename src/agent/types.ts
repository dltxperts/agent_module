/**
 * Pluggable agent engine interface.
 *
 * Claude and Codex implement AgentEngine.
 * AgentService delegates runtime turns to one selected engine.
 */

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface UIContext {
  activeModule?: string;
  selectedEntityId?: string;
  selectedEntityName?: string;
  selectedChatId?: string;
  selectedChatName?: string;
  episodeId?: string;
  replyToEntityId?: string;
}

export type EngineMcpServer =
  | {
      id: string;
      name: string;
      enabled: boolean;
      transport: "stdio";
      command: string;
      args: string[];
      env?: Record<string, string>;
      cwd?: string;
    }
  | {
      id: string;
      name: string;
      enabled: boolean;
      transport: "http";
      url: string;
      headers?: Record<string, string>;
    };

export interface EngineRequest {
  messages: ChatMessage[];
  systemPrompt: string;
  maxSteps: number;
  temperature?: number;
  model?: string;
  context?: Record<string, unknown>;
  /** Opaque per-turn correlation id (the run id). */
  turnId?: string | null;
  /** Persistent CLI session id. Engines that support session resume
   *  pass this as `--session-id <uuid>` (claude) or as the codex
   *  `threads.id` lookup key. Absent for ad-hoc turns without a
   *  session. INV-SESSION-1. */
  engineSessionId?: string | null;
  /** Cache directive computed by the backend from the engine that
   *  produced the episode's last non-NULL row vs the engine requested
   *  for this turn.
   *
   *  - `"resume"`: engine unchanged; the CLI session already holds
   *    the transcript. `messages` carries only the latest user turn.
   *  - `"replay"`: first turn for this engine on this episode (or
   *    engine switch); the engine layer must purge any stale CLI
   *    session and bootstrap fresh. `messages` carries the full
   *    reconstructed transcript.
   *
   *  Absent for ad-hoc chats (no episode). Plan: INV-SESSION-7. */
  cacheMode?: "replay" | "resume";
  /** Engine that produced the episode's last non-NULL row, as
   *  observed by the backend before this turn ran. When this
   *  differs from the current engine AND `cacheMode === "replay"`,
   *  the engine layer must also purge the previous engine's CLI
   *  session under `engineSessionId` before bootstrapping its own
   *  — see `purge.ts`. Plan: R1 / INV-SESSION-9. */
  previousEngine?: string | null;
  /** Startup-configured MCP servers bound to this session. Engines
   *  build native Claude/Codex MCP config from these entries — this is
   *  the only MCP source (INV-8). */
  fixedMcpServers?: EngineMcpServer[];
  /** Session working directory. Engines spawn the CLI here AND resolve
   *  the per-session rollout path under it (INV-1). */
  cwd?: string;
  /** Session permission/sandbox model mapped onto engine CLI flags
   *  (INV-4). `"restricted"` (default): MCP-only / read-only sandbox,
   *  no prompts. `"full"`: bypass all permissions. */
  permissionMode?: "restricted" | "full";
}

export type StreamEvent =
  | { type: "delta"; content: string }
  | { type: "tool_call"; id: string; name: string; args: unknown }
  | { type: "tool_result"; id: string; name: string; result: unknown }
  /** Emitted before engine output so persisted run events record the
   *  engine that produced the row. */
  | { type: "engine_resolved"; engine: string }
  /** Non-fatal degradation signal (e.g. codex's resume path failed and
   *  we fell through to a fresh session). The engine still produces a
   *  response; `code` is a stable classifier for analytics / e2e. */
  | { type: "warning"; code: string; message: string }
  | { type: "done"; full_content: string }
  | { type: "error"; message: string };

export interface AgentEngine {
  readonly name: string;
  stream(request: EngineRequest): AsyncIterable<StreamEvent>;
}
