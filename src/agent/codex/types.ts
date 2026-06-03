export type CodexEngineMode = "legacy" | "app-server";

export interface CodexEngineDeps {
  /** Override the transport mode. Default: from `CODEX_ENGINE_MODE`. */
  mode?: CodexEngineMode;
  /** Injected for tests; defaults to the process-wide singleton. */
  registry?: CodexAppServerRegistry;
}

export interface ServerRequest {
  id: number | string;
  method: string;
  params?: unknown;
}

export interface CodexAppServerClient {
  request<T = unknown>(method: string, params?: unknown): Promise<T>;
  notifications(): AsyncIterable<JsonRpcNotification>;
  onServerRequest(handler: (req: ServerRequest) => void): void;
  respond(id: number | string, result: unknown): void;
  onClose(cb: () => void): void;
  close(): Promise<void>;
}

export interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}

export interface NotificationConsumer {
  queue: JsonRpcNotification[];
  waiter: ((result: IteratorResult<JsonRpcNotification>) => void) | null;
  done: boolean;
}

export interface EnsureThreadResult {
  client: CodexAppServerClient;
  threadId: string;
}

export interface CodexAppServerRegistry {
  ensureThread(
    sessionId: string,
    threadStartParams?: ThreadStartParams,
  ): Promise<EnsureThreadResult>;
  dropThread(sessionId: string): void;
  markProcessDead(): void;
  shutdown(): Promise<void>;
}

export interface CodexRegistryDeps {
  spawnClient?: () => CodexAppServerClient;
  initializeParams?: InitializeParams;
}

export interface CodexServerRequestLike {
  method: string;
}

export type JsonRpcId = number | string;

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface JsonRpcNotification {
  jsonrpc?: "2.0";
  method: string;
  params?: unknown;
}

export type IncomingMessage = JsonRpcResponse | JsonRpcNotification;

export interface ClientInfo {
  name: string;
  version: string;
}

export interface InitializeParams {
  clientInfo: ClientInfo;
  capabilities?: Record<string, unknown> | null;
}

export interface ThreadStartParams {
  approvalPolicy?: "untrusted" | "on-request" | "on-failure" | "never" | null;
  sandbox?: "read-only" | "workspace-write" | "danger-full-access" | null;
  model?: string | null;
  cwd?: string | null;
  config?: Record<string, unknown> | null;
}

export interface ThreadResumeParams {
  threadId: string;
}

export interface TextUserInput {
  type: "text";
  text: string;
  text_elements: [];
}

export type UserInput = TextUserInput;

export interface TurnStartParams {
  threadId: string;
  input: UserInput[];
  approvalPolicy?: "untrusted" | "on-request" | "on-failure" | "never" | null;
  model?: string | null;
}

export interface Thread {
  id: string;
  sessionId?: string;
}

export interface ThreadStartResult {
  thread: Thread;
}

export interface AgentMessageDeltaParams {
  threadId: string;
  turnId: string;
  itemId: string;
  delta: string;
}

export type ThreadItem =
  | {
      type: "mcpToolCall";
      id: string;
      server: string;
      tool: string;
      arguments: unknown;
      status: string;
      result?: unknown;
      error?: unknown;
    }
  | {
      type: "dynamicToolCall";
      id: string;
      tool: string;
      arguments: unknown;
      status: string;
      success?: boolean | null;
    }
  | { type: string; id: string };

export interface ItemLifecycleParams {
  item: ThreadItem;
  threadId: string;
  turnId: string;
}

export interface WarningParams {
  message?: string;
  code?: string;
}

export interface ErrorParams {
  message?: string;
  code?: number | string;
}

export interface CodexPreSpawnInput {
  sessionId: string | null;
  cacheMode: "resume" | "replay" | undefined;
  previousEngine: string | null | undefined;
  cwd: string;
  codexBin: string;
}

export type CodexAttemptDecision =
  | "success"
  | "retry_with_bootstrap"
  | "fall_through"
  | "fatal";

export interface CodexAttemptOutcome {
  attempt: number;
  hasSessionId: boolean;
  streamErrored: boolean;
  producedEvents: boolean;
  exitCode: number | null;
  stderr: string;
}

export const NOTIF = {
  turnCompleted: "turn/completed",
  agentMessageDelta: "item/agentMessage/delta",
  itemStarted: "item/started",
  itemCompleted: "item/completed",
  warning: "warning",
  error: "error",
} as const;
