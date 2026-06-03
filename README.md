# Agent Runtime

A small, reusable **NestJS** service that runs **Claude Code** / **Codex** CLI
agents as **persistent sessions** on behalf of arbitrary backends. It exposes a
plain REST API for sessions, runs (with streaming), files, and the
startup-configured MCP servers each agent can use.

Engines authenticate via the Claude / Codex CLIs' own subscription auth — no API
keys required (the `claude` and `codex` binaries must be on `PATH`).

## Run

```bash
bun install
cp .env.example .env
bun run start          # bun src/index.ts → listens on AGENT_PORT (default 3002)
```

Dev (watch): `bun run dev`. Typecheck: `bun run typecheck`. Tests: `bun test`.

## Concepts

- **Session** — a long-lived agent context bound to a working directory,
  engine, model, system prompt, permission mode, and a set of MCP servers.
  Each session maps to one persistent CLI session (Claude `--session-id` /
  Codex app-server thread).
- **Run** — one turn within a session. Created via REST; the runtime executes it
  in the background and streams events you can poll or read over SSE.
- **Persistent sessions** — consecutive runs on the same engine **resume** the
  CLI session (the CLI holds the transcript). The first run, or a run after the
  session's engine changed, **replays**: the runtime purges stale CLI state,
  bootstraps fresh, and reconstructs the transcript from prior runs.

## REST API

All routes are under `/v1`.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/v1/health` | Liveness + version |
| GET | `/v1/engines` | List enabled engines + transport |
| GET | `/v1/mcp/servers` | List startup-configured MCP servers |
| GET | `/v1/mcp/servers/:id` | One MCP server summary |
| POST | `/v1/sessions` | Create a session |
| GET | `/v1/sessions` | List sessions |
| GET | `/v1/sessions/:id` | Get a session |
| PATCH | `/v1/sessions/:id` | Update a session |
| POST | `/v1/sessions/:id/reset` | Drop persistent CLI state (fresh bootstrap next run) |
| DELETE | `/v1/sessions/:id` | Delete a session |
| POST | `/v1/sessions/:id/runs` | Start a run (returns `run_id`) |
| POST | `/v1/sessions/:id/runs/stream` | Start a run and stream events (SSE) |
| GET | `/v1/runs/:id` | Get run status / output |
| GET | `/v1/runs/:id/events` | Long-poll run events (`?cursor=&timeout_ms=&limit=`) |
| POST | `/v1/files` | Upload a file (multipart `file`) |
| GET | `/v1/files/:id` | Download a file |
| GET | `/v1/files/:id/metadata` | File metadata |
| DELETE | `/v1/files/:id` | Delete a file |

### Create a session

```jsonc
POST /v1/sessions
{
  "engine": "claude",              // "claude" | "codex"
  "cwd": "/abs/path/to/workdir",   // required — the agent runs HERE
  "model": "claude-opus-4-8",      // optional; omitted → CLI default
  "system_prompt": "You are…",     // optional; omitted → no system prompt
  "permission_mode": "restricted", // "restricted" (default) | "full"
  "mcp_server_ids": ["filesystem"], // ids from the startup MCP config
  "title": "…",                    // optional
  "metadata": { }                  // optional
}
```

`permission_mode`:

- `restricted` (default) — agent may only call the configured MCP tools; shell
  and file mutation are denied, no permission prompts (Claude `dontAsk` +
  `--allowedTools mcp__*`; Codex `--sandbox read-only`).
- `full` — full host access (Claude `bypassPermissions`; Codex
  `danger-full-access`). Use only in trusted / sandboxed environments.

### Start and follow a run

```bash
# fire-and-poll
curl -XPOST $URL/v1/sessions/$SID/runs -d '{"message":{"role":"user","content":"hi"}}'
curl "$URL/v1/runs/$RUN/events?cursor=0&timeout_ms=30000"

# or stream (SSE)
curl -XPOST $URL/v1/sessions/$SID/runs/stream -d '{"message":{"role":"user","content":"hi"}}'
```

Event types: `engine_resolved`, `delta`, `tool_call`, `tool_result`, `warning`,
`done`, `error`.

## Startup MCP servers

MCP servers are configured once at startup (not per request) in
`$AGENT_MCP_CONFIG` (default `$AGENT_HOME/mcp-servers.json`). Sessions reference
them by `id` via `mcp_server_ids`; the runtime builds native Claude/Codex MCP
config from the matching entries. A session with no servers runs with no MCP.

```jsonc
{
  "servers": [
    {
      "id": "filesystem",
      "name": "Filesystem",
      "enabled": true,
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/data"],
      "env": { "FOO": "bar" }
    },
    {
      "id": "docs",
      "name": "Docs",
      "enabled": true,
      "transport": "http",
      "url": "https://mcp.example.com/mcp",
      "headers": { "Authorization": "Bearer …" }
    }
  ]
}
```

## Storage

State lives under `$AGENT_HOME` (default `~/.agent-runtime`):
`sessions/`, `runs/` (run JSON + `<run>.events.jsonl`), `files/`.

## Environment

| Var | Default | Purpose |
| --- | --- | --- |
| `AGENT_PORT` | `3002` | HTTP port |
| `AGENT_HOME` | `~/.agent-runtime` | State directory |
| `AGENT_MCP_CONFIG` | `$AGENT_HOME/mcp-servers.json` | Startup MCP config path |
| `DEFAULT_ENGINE` | — | Orders `/v1/engines` (the run engine is per-session) |
| `CLAUDE_ENGINE_MODE` | `stream-json` | `stream-json` (persistent) or `legacy` (per-turn spawn) |
| `CODEX_ENGINE_MODE` | `app-server` | `app-server` (persistent) or `legacy` (`codex exec`) |
| `CLAUDE_MODEL` | — | Fallback model when a session sets none |
| `AGENT_SKILLS_DIR` | — | If set, surface installed skills from `<dir>/<id>/SKILL.md` |
| `CLAUDE_PROCESS_POOL_SIZE` | `8` | Max concurrent persistent claude processes |
| `CLAUDE_PROCESS_IDLE_MS` | — | If set, idle claude processes are swept |
| `CODEX_BIN` | `codex` | Codex binary |
| `AGENT_RUNNER_DISABLED` | — | If truthy, runs are created but not executed |

> Changing a session's `model` / `permission_mode` / `cwd` mid-session takes
> effect on the next **fresh** session — call `POST /v1/sessions/:id/reset`
> (or switch engine) to drop the cached CLI process so the new config applies.

## Deploy

Container build via `Dockerfile` (Bun). Railway config in `railway.toml`
(`startCommand = "bun src/index.ts"`). Railway injects env vars directly.
