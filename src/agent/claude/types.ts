import type { ChildProcess, SpawnOptions } from "child_process";

export type ClaudeEngineMode = "legacy" | "stream-json";

export interface ClaudeEngineDeps {
  /** Override the transport mode. Default: from `CLAUDE_ENGINE_MODE`. */
  mode?: ClaudeEngineMode;
  /** Injected for tests; defaults to a module-level singleton. */
  registry?: ClaudeProcessRegistry;
  /** Wraps a ChildProcess into a stream client. Test-overridable. */
  createClient?: (child: ChildProcess) => ClaudeStreamClient;
}

export interface StreamJsonArgs {
  systemPrompt: string;
  maxSteps: number;
  mcpConfig: string;
  mcpTools?: string;
  model?: string;
  permissionMode?: "restricted" | "full";
  engineSessionId: string;
  resumeSession: boolean;
}

export interface RawClaudeEvent {
  type: string;
  subtype?: string;
  [key: string]: unknown;
}

export interface ClaudeStreamClient {
  /** Write a user-turn envelope to stdin. Awaits 'drain' on backpressure. */
  send(content: string): Promise<void>;
  /**
   * Stream of events emitted by the child. One stream per client; the
   * caller iterates with `for await` and is expected to `break` at
   * each `result/*` event to mark a turn boundary. After a child
   * exit/error the stream emits a single `{type:"error"}` and ends.
   */
  events(): AsyncIterable<RawClaudeEvent>;
  /** End stdin so the child shuts down cleanly. Idempotent. */
  close(): Promise<void>;
}

export interface PendingRead {
  resolve: (value: IteratorResult<RawClaudeEvent>) => void;
}

export type SpawnFn = (
  command: string,
  args: readonly string[],
  options?: SpawnOptions,
) => ChildProcess;

export interface SpawnConfig {
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export interface ProcessHandle {
  readonly sessionId: string;
  readonly child: ChildProcess;
}

export interface ClaudeProcessRegistry {
  acquire(sessionId: string, config: SpawnConfig): ProcessHandle;
  has(sessionId: string): boolean;
  purge(sessionId: string): Promise<void>;
  sweepIdle(): void;
}

export interface ClaudeRegistryDeps {
  spawn?: SpawnFn;
  now?: () => number;
  capacity?: number;
  killGraceMs?: number;
  idleMs?: number;
}

export interface ClaudeRegistryEntry {
  sessionId: string;
  child: ChildProcess;
  lastUsedAt: number;
  handle: ProcessHandle;
}

export interface ClaudePreSpawnInput {
  sessionId: string | null;
  cacheMode: "resume" | "replay" | undefined;
  previousEngine: string | null | undefined;
  /** Session working directory; used to resolve the rollout path so a
   *  replay purge targets the same file claude will spawn under (INV-1). */
  cwd?: string;
}

export interface ClaudeArgsInput {
  fullPrompt: string;
  systemPrompt: string;
  maxSteps: number;
  mcpConfig: string;
  mcpTools?: string;
  model?: string;
  permissionMode?: "restricted" | "full";
  engineSessionId?: string | null;
  resumeSession?: boolean;
}
