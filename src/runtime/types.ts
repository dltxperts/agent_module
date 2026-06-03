import { z } from "zod";

export const ENGINE_IDS = ["claude", "codex"] as const;
export type EngineId = (typeof ENGINE_IDS)[number];

export const PERMISSION_MODES = ["restricted", "full"] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

export const McpServerSchema = z.discriminatedUnion("transport", [
  z.object({
    id: z.string().min(1).regex(/^[a-zA-Z0-9_-]+$/),
    name: z.string().min(1),
    enabled: z.boolean().default(true),
    transport: z.literal("stdio"),
    command: z.string().min(1),
    args: z.array(z.string()).default([]),
    env: z.record(z.string()).optional(),
    cwd: z.string().optional(),
  }),
  z.object({
    id: z.string().min(1).regex(/^[a-zA-Z0-9_-]+$/),
    name: z.string().min(1),
    enabled: z.boolean().default(true),
    transport: z.literal("http"),
    url: z.string().url(),
    headers: z.record(z.string()).optional(),
  }),
]);

export const StartupMcpConfigSchema = z.object({
  servers: z.array(McpServerSchema).default([]),
});

export type McpServer = z.infer<typeof McpServerSchema>;

export const CreateSessionSchema = z.object({
  id: z.string().min(1).regex(/^[a-zA-Z0-9_.-]+$/).optional(),
  title: z.string().optional(),
  engine: z.enum(ENGINE_IDS),
  model: z.string().optional(),
  cwd: z.string().min(1),
  system_prompt: z.string().optional(),
  permission_mode: z.enum(PERMISSION_MODES).default("restricted"),
  mcp_server_ids: z.array(z.string().min(1)).default([]),
  metadata: z.record(z.unknown()).optional(),
});

export const PatchSessionSchema = z.object({
  title: z.string().optional(),
  engine: z.enum(ENGINE_IDS).optional(),
  model: z.string().nullable().optional(),
  cwd: z.string().min(1).optional(),
  system_prompt: z.string().nullable().optional(),
  permission_mode: z.enum(PERMISSION_MODES).optional(),
  mcp_server_ids: z.array(z.string().min(1)).optional(),
  metadata: z.record(z.unknown()).optional(),
});

export type CreateSessionInput = z.infer<typeof CreateSessionSchema>;
export type PatchSessionInput = z.infer<typeof PatchSessionSchema>;

export interface AgentSession {
  id: string;
  /** Stable UUID minted at creation, used as the engine's CLI session
   *  id (claude `--session-id` / codex thread id). The user-facing
   *  `id` may be any string, but the CLIs require a valid UUID, so we
   *  keep a separate one. */
  engine_session_id: string;
  title?: string;
  engine: EngineId;
  model?: string;
  cwd: string;
  system_prompt?: string;
  permission_mode: PermissionMode;
  mcp_server_ids: string[];
  metadata?: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  last_run_id?: string;
  /** Engine that produced this session's most recent completed run.
   *  Drives the cacheMode/previousEngine decision (INV-5): a turn whose
   *  engine differs from `last_engine` (or the first turn, when unset)
   *  runs in `replay` + cross-engine purge; otherwise `resume`. */
  last_engine?: EngineId;
}

export const CreateRunSchema = z.object({
  message: z.object({
    role: z.enum(["user", "assistant"]),
    content: z.string(),
  }),
  attachment_ids: z.array(z.string().min(1)).optional(),
});

export type CreateRunInput = z.infer<typeof CreateRunSchema>;

export interface Run {
  id: string;
  session_id: string;
  engine: EngineId;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  input: CreateRunInput;
  output?: { full_content: string };
  created_at: string;
  started_at?: string;
  completed_at?: string;
  error?: string;
}

export type RunEvent =
  | { seq: number; run_id: string; type: "engine_resolved"; engine: string; ts: string }
  | { seq: number; run_id: string; type: "delta"; content: string; ts: string }
  | { seq: number; run_id: string; type: "tool_call"; id: string; name: string; args: unknown; ts: string }
  | { seq: number; run_id: string; type: "tool_result"; id: string; name: string; result: unknown; ts: string }
  | { seq: number; run_id: string; type: "warning"; code: string; message: string; ts: string }
  | { seq: number; run_id: string; type: "error"; message: string; ts: string }
  | { seq: number; run_id: string; type: "done"; full_content: string; ts: string };

export type RunEventPayload = RunEvent extends infer Event
  ? Event extends RunEvent
    ? Omit<Event, "seq" | "run_id" | "ts">
    : never
  : never;
