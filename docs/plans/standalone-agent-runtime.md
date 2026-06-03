# Standalone Agent Runtime Product Plan

## 0. Product Decision

We are not building a Magnis sidecar anymore.

We are building a standalone **Agent Runtime**:

- persistent Claude/Codex sessions;
- fixed startup MCP server configuration;
- fixed session IDs;
- file/image attachment storage;
- streamable runs;
- no required Magnis backend;
- no builtin/Vercel AI engine on startup.

Recommended framework decision:

- **Move HTTP API to NestJS** for product-grade controllers, DTO validation, dependency injection, modules, lifecycle hooks, OpenAPI docs, and testability.
- Keep current Claude/Codex engine code as runtime libraries.
- Keep Bun as the runtime initially if NestJS works cleanly under Bun; otherwise use Node for the API process and keep existing engine code TypeScript-compatible.

Why NestJS:

- The product now has real API surface and persistent state, not just a small Hono sidecar.
- We need clear modules: sessions, startup MCP config, files, runs, engines.
- We need API docs and DTO validation.
- Long polling and SSE are easier to expose cleanly as separate controllers over the same run event log.

What we are not doing:

- No Magnis `BACKEND_URL`.
- No public `engine_session_id`, `cache_mode`, `previous_engine`.
- No hidden fallback to builtin.
- No REST API for creating, patching, or deleting MCP servers in v1.
- No UI in this stage.
- No auth in v1 unless explicitly added later.

## 1. Core Design

### Objects

#### McpServer

A server-side MCP entry loaded at runtime startup. It is read-only through the
public API in v1. To change MCP servers, edit startup config and restart the
runtime.

```ts
type McpServer =
  | {
      id: string;
      name: string;
      enabled: boolean;
      transport: "stdio";
      command: string;
      args: string[];
      env?: Record<string, string>;
      cwd?: string;
      created_at: string;
      updated_at: string;
    }
  | {
      id: string;
      name: string;
      enabled: boolean;
      transport: "http";
      url: string;
      headers?: Record<string, string>;
      created_at: string;
      updated_at: string;
    };
```

#### Session

A fixed persistent agent session.

```ts
type AgentSession = {
  id: string;
  title?: string;
  engine: "claude" | "codex";
  model?: string;
  cwd: string;
  system_prompt?: string;
  mcp_server_ids: string[];
  metadata?: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  last_run_id?: string;
};
```

Binding rule:

- The public `session.id` is also the internal engine session key.
- Claude uses it for `--session-id` / `--resume`.
- Codex app-server uses it as registry thread key.
- Codex legacy uses it as `threads.id`.

#### Run

One user turn against one session.

```ts
type Run = {
  id: string;
  session_id: string;
  engine: "claude" | "codex";
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  input: {
    message: AgentMessage;
    attachment_ids?: string[];
  };
  output?: {
    full_content: string;
  };
  created_at: string;
  started_at?: string;
  completed_at?: string;
  error?: string;
};
```

#### RunEvent

Events are persisted in order so SSE, WebSocket, and long polling can all read the same stream.

```ts
type RunEvent =
  | { seq: number; run_id: string; type: "engine_resolved"; engine: string; ts: string }
  | { seq: number; run_id: string; type: "delta"; content: string; ts: string }
  | { seq: number; run_id: string; type: "tool_call"; id: string; name: string; args: unknown; ts: string }
  | { seq: number; run_id: string; type: "tool_result"; id: string; name: string; result: unknown; ts: string }
  | { seq: number; run_id: string; type: "warning"; code: string; message: string; ts: string }
  | { seq: number; run_id: string; type: "error"; message: string; ts: string }
  | { seq: number; run_id: string; type: "done"; full_content: string; ts: string };
```

#### FileObject

Runtime-owned uploaded file.

```ts
type FileObject = {
  id: string;
  name: string;
  mime_type: string;
  size: number;
  sha256: string;
  storage_path: string;
  created_at: string;
};
```

## 2. Public API

Base path:

```text
/v1
```

### Health And Engines

```http
GET /v1/health
```

Response:

```json
{
  "status": "ok",
  "version": "0.1.0"
}
```

```http
GET /v1/engines
```

Response:

```json
{
  "engines": [
    {
      "id": "claude",
      "enabled": true,
      "session_mode": "persistent",
      "transport": "cli"
    },
    {
      "id": "codex",
      "enabled": true,
      "session_mode": "persistent",
      "transport": "app-server"
    }
  ]
}
```

### MCP Servers

MCP servers are loaded from startup config and exposed read-only. To change the
available MCPs, the operator edits the server-side config and restarts the
runtime.

List configured servers:

```http
GET /v1/mcp/servers
```

Response:

```json
{
  "servers": [
    {
      "id": "filesystem",
      "name": "Filesystem",
      "enabled": true,
      "transport": "stdio"
    },
    {
      "id": "linear",
      "name": "Linear",
      "enabled": true,
      "transport": "http"
    }
  ]
}
```

Get configured server metadata:

```http
GET /v1/mcp/servers/:id
```

Test one configured server:

```http
POST /v1/mcp/servers/:id/test
```

Response:

```json
{
  "ok": true,
  "tools_count": 12,
  "tools": ["read_file", "write_file"]
}
```

There is intentionally no:

- `POST /v1/mcp/servers`
- `PATCH /v1/mcp/servers/:id`
- `DELETE /v1/mcp/servers/:id`

MCP config changes are an operator action, not a runtime API action, in v1.

### Sessions

Create session with fixed ID:

```http
POST /v1/sessions
```

```json
{
  "id": "marketing-agent",
  "title": "Marketing Agent",
  "engine": "codex",
  "cwd": "/home/marketing/Coding/agent",
  "system_prompt": "You are a pragmatic coding agent.",
  "mcp_server_ids": ["filesystem"],
  "model": "optional",
  "metadata": {
    "project": "standalone-agent"
  }
}
```

Response:

```json
{
  "id": "marketing-agent",
  "engine": "codex",
  "cwd": "/home/marketing/Coding/agent",
  "mcp_server_ids": ["filesystem"],
  "created_at": "2026-06-03T10:00:00.000Z",
  "updated_at": "2026-06-03T10:00:00.000Z"
}
```

Create session with generated ID:

```json
{
  "engine": "claude",
  "cwd": "/home/marketing/Coding/agent",
  "mcp_server_ids": ["filesystem"]
}
```

List:

```http
GET /v1/sessions
```

Get:

```http
GET /v1/sessions/:id
```

Patch session MCP binding:

```http
PATCH /v1/sessions/:id
```

```json
{
  "mcp_server_ids": ["filesystem", "linear"]
}
```

Reset session:

```http
POST /v1/sessions/:id/reset
```

Behavior:

- Keeps session metadata.
- Purges Claude/Codex persistent artifacts for this session.
- Next run starts from a clean engine conversation.

Delete session:

```http
DELETE /v1/sessions/:id
```

Behavior:

- Removes session metadata.
- Purges engine artifacts.
- Does not delete globally registered MCP servers.

### Files

Upload:

```http
POST /v1/files
Content-Type: multipart/form-data
```

Fields:

- `file`: binary file
- `name`: optional override

Response:

```json
{
  "id": "file_01J...",
  "name": "screenshot.png",
  "mime_type": "image/png",
  "size": 123456,
  "sha256": "..."
}
```

Download:

```http
GET /v1/files/:id
```

Metadata:

```http
GET /v1/files/:id/metadata
```

Delete:

```http
DELETE /v1/files/:id
```

### Runs And Messages

Create run, no immediate stream:

```http
POST /v1/sessions/:id/runs
```

```json
{
  "message": {
    "role": "user",
    "content": "Inspect the repo and tell me what to change."
  },
  "attachment_ids": ["file_01J..."]
}
```

Response:

```json
{
  "run_id": "run_01J...",
  "session_id": "marketing-agent",
  "status": "queued"
}
```

Create run and stream with SSE:

```http
POST /v1/sessions/:id/runs/stream
```

Request body same as `POST /runs`.

SSE output:

```text
data: {"seq":1,"type":"engine_resolved","engine":"codex"}
data: {"seq":2,"type":"delta","content":"I will inspect..."}
data: {"seq":3,"type":"tool_call","id":"...","name":"read_file","args":{}}
data: {"seq":4,"type":"tool_result","id":"...","name":"read_file","result":{}}
data: {"seq":5,"type":"done","full_content":"..."}
```

Get run:

```http
GET /v1/runs/:run_id
```

Cancel run:

```http
POST /v1/runs/:run_id/cancel
```

### Long Polling

Yes, we should support it.

Long polling reads from the same persisted `RunEvent` log as SSE.

```http
GET /v1/runs/:run_id/events?cursor=0&timeout_ms=30000&limit=100
```

Response when events are available:

```json
{
  "run_id": "run_01J...",
  "next_cursor": 5,
  "done": false,
  "events": [
    { "seq": 1, "type": "engine_resolved", "engine": "codex" },
    { "seq": 2, "type": "delta", "content": "..." }
  ]
}
```

Response after timeout with no events:

```json
{
  "run_id": "run_01J...",
  "next_cursor": 5,
  "done": false,
  "events": []
}
```

When complete:

```json
{
  "run_id": "run_01J...",
  "next_cursor": 9,
  "done": true,
  "events": [
    { "seq": 9, "type": "done", "full_content": "..." }
  ]
}
```

Why long polling:

- Works behind conservative proxies.
- Simple client implementation.
- Allows reconnect/resume by cursor.
- Avoids losing stream events if the client disconnects.

We should still keep SSE because it is better for interactive UI.

WebSocket can be Stage 2, not v1.

## 3. Session Binding Design

The client binds everything to a session at creation time:

```json
{
  "id": "my-fixed-session",
  "engine": "codex",
  "cwd": "/repo",
  "mcp_server_ids": ["filesystem", "github"]
}
```

The `mcp_server_ids` values must already exist in startup config. The REST API
does not create MCP servers.

Runtime behavior:

1. Store session metadata in `AGENT_HOME/sessions/my-fixed-session.json`.
2. Store selected MCP server IDs on the session.
3. On each run:
   - load session;
   - resolve enabled startup MCP servers referenced by the session;
   - build engine MCP config;
   - pass `session.id` internally as engine session ID;
   - stream engine output into run event log.

No public `cache_mode`.

Runtime decides:

- normal run: resume existing engine session;
- reset endpoint: purge artifacts, next run starts clean;
- engine change in `PATCH /sessions/:id`: purge old engine artifacts before next run.

## 4. MCP Design

MCP servers are fixed at process start.

Startup config source:

```text
AGENT_MCP_CONFIG=/path/to/mcp-servers.json
```

If `AGENT_MCP_CONFIG` is unset, runtime reads:

```text
AGENT_HOME/mcp-servers.json
```

Example startup config:

```json
{
  "servers": [
    {
      "id": "filesystem",
      "name": "Filesystem",
      "enabled": true,
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/home/marketing/Coding/agent"]
    },
    {
      "id": "linear",
      "name": "Linear",
      "enabled": true,
      "transport": "http",
      "url": "http://localhost:8787/mcp",
      "headers": {
        "Authorization": "Bearer token"
      }
    }
  ]
}
```

Runtime validates this file during startup. Invalid config fails startup with a
clear error. There is no REST mutation path in v1.

### Stdio MCP

Claude/Codex config can include stdio MCP directly:

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/repo"],
      "env": {}
    }
  }
}
```

### HTTP MCP

Claude/Codex prefer stdio MCP config. For HTTP servers we create a stdio bridge:

```json
{
  "mcpServers": {
    "linear": {
      "command": "node",
      "args": [
        "/path/to/mcp-http-stdio-proxy.mjs",
        "--server-id",
        "linear"
      ]
    }
  }
}
```

The proxy:

- reads server config from the validated startup MCP config snapshot;
- forwards JSON-RPC to the configured HTTP URL;
- attaches only that server's headers;
- logs to `AGENT_HOME/logs/mcp-proxy-linear.log`.

## 5. Storage Design

Default:

```text
AGENT_HOME=~/.agent-runtime
```

Layout:

```text
~/.agent-runtime/
  config.json
  mcp-servers.json        # optional startup config when AGENT_MCP_CONFIG is unset
  sessions/
    <session-id>.json
  runs/
    <run-id>.json
    <run-id>.events.jsonl
  files/
    metadata/
      <file-id>.json
    blobs/
      <file-id>
  logs/
```

Use atomic writes:

- write `*.tmp`;
- `fsync` if practical;
- rename into place.

No database in v1. JSON files are sufficient for local-first product. We can move to SQLite later if query complexity grows.

## 6. NestJS Implementation Design

Modules:

```text
src/app.module.ts
src/main.ts

src/modules/health/
src/modules/engines/
src/modules/mcp/
src/modules/sessions/
src/modules/runs/
src/modules/files/

src/runtime/
src/engines/
```

NestJS controllers:

- `HealthController`
- `EnginesController`
- `McpServersController` (read-only list/get/test)
- `SessionsController`
- `RunsController`
- `FilesController`

Services:

- `RuntimeConfigService`
- `StartupMcpConfigService`
- `SessionStoreService`
- `RunStoreService`
- `FileStoreService`
- `EngineRunnerService`
- `McpConfigService`
- `RunEventLogService`

DTO validation:

- Use `zod` initially because project already has it.
- Either wrap Zod manually in controllers or later move to `class-validator`.
- Do not introduce both validation systems unless necessary.

Streaming in NestJS:

- SSE: Nest supports `@Sse()`, but we may prefer raw `Response` for exact event format and backpressure control.
- Long polling: normal `GET` controller that waits on `RunEventLogService.waitForEvents(runId, cursor, timeoutMs)`.
- Cancel: controller calls `EngineRunnerService.cancel(runId)`.

## 7. Migration From Current Code

Keep:

- `src/engines/claude*`
- `src/engines/codex*`
- `src/engines/cross-engine-purge.ts`
- event mappers
- persistent-session helpers
- startup opt-in policy for builtin

Replace:

- Hono `server/controller.ts` with NestJS controllers.
- Magnis-shaped `AgentService` with runtime `EngineRunnerService`.
- `BACKEND_URL`-based MCP endpoint with per-session MCP config.
- `attachments.ts` Magnis `file.get` flow with runtime file store.

Gate or remove:

- old `/chat/stream` route;
- old `mcp-client.ts` direct Magnis HTTP client;
- `auth_token`, `contextEnvelope`, `user_id`.

## 8. Invariants

`INV-1`: Runtime starts without `BACKEND_URL`.

`INV-2`: `builtin` is not in `/v1/engines` unless `ENABLE_BUILTIN_ENGINE=1`.

`INV-3`: Public session API accepts client-supplied fixed IDs.

`INV-4`: The public session ID is the internal Claude/Codex persistent session key.

`INV-5`: Session MCP binding is stored on the session and used for every run.

`INV-6`: Disabled MCP servers never appear in generated engine MCP config.

`INV-7`: HTTP MCP headers never leak between servers.

`INV-8`: Run events are persisted with monotonic `seq`.

`INV-9`: SSE and long polling read from the same run event log.

`INV-10`: Long polling with a stale cursor returns all events after that cursor, up to limit.

`INV-11`: Long polling with no new events waits up to `timeout_ms` and returns an empty event list.

`INV-12`: Reset purges engine artifacts but keeps session metadata.

`INV-13`: Delete purges engine artifacts and removes session metadata.

`INV-14`: File attachments are resolved only from runtime file store.

`INV-15`: Non-image attachments are not silently read into prompts in v1.

## 9. Tests

API tests:

- `tst_runtime_api_health_001`: `GET /v1/health`.
- `tst_runtime_api_engines_001`: no builtin by default.
- `tst_runtime_api_mcp_001`: list startup-configured MCP servers.
- `tst_runtime_api_mcp_002`: get one startup-configured MCP server.
- `tst_runtime_api_mcp_003`: create/patch/delete MCP routes do not exist.
- `tst_runtime_api_mcp_004`: test one configured MCP server.
- `tst_runtime_api_sessions_001`: create fixed-ID session.
- `tst_runtime_api_sessions_002`: create generated-ID session.
- `tst_runtime_api_sessions_003`: patch MCP binding.
- `tst_runtime_api_sessions_004`: reset keeps metadata.
- `tst_runtime_api_sessions_005`: delete removes metadata.
- `tst_runtime_api_files_001`: upload/download/delete file.
- `tst_runtime_api_runs_001`: create run.
- `tst_runtime_api_runs_sse_001`: stream emits `engine_resolved` first.
- `tst_runtime_api_runs_long_poll_001`: long poll returns available events.
- `tst_runtime_api_runs_long_poll_002`: long poll waits and returns empty on timeout.
- `tst_runtime_api_runs_long_poll_003`: long poll returns `done=true` after completion.

Runtime tests:

- `tst_runtime_store_json_001`: atomic JSON write/read.
- `tst_runtime_mcp_startup_001`: valid startup MCP config loads.
- `tst_runtime_mcp_startup_002`: invalid startup MCP config fails startup validation.
- `tst_runtime_mcp_config_001`: stdio config generation.
- `tst_runtime_mcp_config_002`: HTTP proxy config generation.
- `tst_runtime_mcp_config_003`: disabled startup servers excluded.
- `tst_runtime_run_event_log_001`: monotonic seq append.
- `tst_runtime_run_event_log_002`: wait by cursor.
- `tst_runtime_engine_runner_001`: session ID passed as internal engine session key.
- `tst_runtime_engine_runner_002`: reset purges Claude/Codex artifacts.
- `tst_runtime_attachment_001`: image file materialized for CLI prompt.
- `tst_runtime_attachment_002`: non-image summarized only.

Existing tests to keep:

- Claude session helper tests.
- Codex session helper tests.
- Codex app-server tests.
- Startup engine tests.

## 10. Implementation Stages

Stage 1: NestJS skeleton

- Add NestJS dependencies.
- Add `src/main.ts`, `AppModule`, health and engines modules.
- Keep old engine files untouched.
- Tests: health, engines.

Stage 2: Storage foundation

- Add config service and JSON stores.
- Add `AGENT_HOME`.
- Add session/run/file stores.
- Tests: store tests.

Stage 3: Startup MCP config

- Implement `AGENT_MCP_CONFIG` / `AGENT_HOME/mcp-servers.json` loading.
- Validate config at startup.
- Implement read-only `/v1/mcp/servers`, `/v1/mcp/servers/:id`, and `/v1/mcp/servers/:id/test`.
- Explicitly do not implement create/patch/delete routes.
- Tests: startup MCP config and read-only MCP API tests.

Stage 4: Session API

- Implement `/v1/sessions`.
- Fixed IDs.
- Patch MCP binding.
- Tests: session API.

Stage 5: Run event log and long polling

- Implement run store and event log.
- Implement long polling.
- Tests: long polling behavior.

Stage 6: Engine runner

- Connect sessions to Claude/Codex engines.
- Generate engine MCP config from startup servers referenced by session IDs.
- Remove public Magnis fields.
- Tests with fake engine first, then existing engine tests.

Stage 7: SSE stream endpoint

- Implement `POST /v1/sessions/:id/runs/stream`.
- Write events to log and stream simultaneously.
- Tests: SSE event order.

Stage 8: Files and attachments

- Implement `/v1/files`.
- Replace Magnis attachment lookup.
- Tests: file and attachment tests.

Stage 9: Reset/delete lifecycle

- Wire reset/delete to purge engine artifacts.
- Tests: purge lifecycle.

Stage 10: Docs and smoke

- Rewrite README.
- Add `docs/api.md`.
- Add example curl flows.
- Smoke with temp `AGENT_HOME`.

## 11. Example End-To-End Flow

Create startup MCP config:

```bash
cat > /tmp/agent-mcps.json <<'JSON'
{
  "servers": [
    {
      "id": "filesystem",
      "name": "Filesystem",
      "enabled": true,
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/home/marketing/Coding/agent"]
    }
  ]
}
JSON
```

Start runtime with fixed MCPs:

```bash
AGENT_MCP_CONFIG=/tmp/agent-mcps.json bun run start
```

Create fixed session:

```bash
curl -X POST localhost:3002/v1/sessions \
  -H 'Content-Type: application/json' \
  -d '{
    "id": "agent-product-session",
    "engine": "codex",
    "cwd": "/home/marketing/Coding/agent",
    "mcp_server_ids": ["filesystem"],
    "system_prompt": "You are a pragmatic coding agent."
  }'
```

Start run:

```bash
curl -X POST localhost:3002/v1/sessions/agent-product-session/runs \
  -H 'Content-Type: application/json' \
  -d '{
    "message": {
      "role": "user",
      "content": "Inspect the project and summarize the API."
    }
  }'
```

Read via long polling:

```bash
curl 'localhost:3002/v1/runs/run_01J/events?cursor=0&timeout_ms=30000'
```

Or stream directly:

```bash
curl -N -X POST localhost:3002/v1/sessions/agent-product-session/runs/stream \
  -H 'Content-Type: application/json' \
  -d '{
    "message": {
      "role": "user",
      "content": "Inspect the project and summarize the API."
    }
  }'
```

## 12. Verification

After each stage:

```bash
bun run typecheck
bun run test
```

NestJS API smoke:

```bash
AGENT_HOME="$(mktemp -d)" AGENT_PORT=3002 bun run start
curl localhost:3002/v1/health
curl localhost:3002/v1/engines
```

No implementation is complete until:

- API docs match controllers.
- Long polling works by cursor.
- SSE works from the same event log.
- Runtime can start with no `BACKEND_URL`.
- Runtime loads MCP servers only from startup config.
- REST cannot create, patch, or delete MCP servers.
- Session reset/delete purges engine artifacts.
