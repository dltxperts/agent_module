import type { EngineMcpServer } from "./types";

/**
 * Build native Claude / Codex MCP config from the session's
 * startup-configured MCP servers (`mcp-servers.json` → session
 * `mcp_server_ids`). This is the ONLY MCP source: there is no legacy
 * single-URL HTTP proxy. A session with no enabled servers runs with
 * an empty MCP set (INV-8).
 */

interface McpConfigInput {
  fixedServers?: EngineMcpServer[];
}

type NativeMcpConfig = Record<string, unknown>;

function enabledFixedServers(input: McpConfigInput): EngineMcpServer[] {
  return (input.fixedServers ?? []).filter((server) => server.enabled);
}

function toClaudeServerConfig(server: EngineMcpServer): NativeMcpConfig {
  if (server.transport === "stdio") {
    return {
      command: server.command,
      args: server.args,
      ...(server.env ? { env: server.env } : {}),
      ...(server.cwd ? { cwd: server.cwd } : {}),
    };
  }
  return {
    type: "http",
    url: server.url,
    ...(server.headers ? { headers: server.headers } : {}),
  };
}

function toCodexServerConfig(server: EngineMcpServer): NativeMcpConfig {
  if (server.transport === "stdio") {
    return {
      command: server.command,
      args: server.args,
      ...(server.env ? { env: server.env } : {}),
      ...(server.cwd ? { cwd: server.cwd } : {}),
    };
  }
  return {
    url: server.url,
    ...(server.headers ? { headers: server.headers } : {}),
  };
}

export function buildClaudeMcpConfig(input: McpConfigInput): string {
  const fixedServers = enabledFixedServers(input);
  return JSON.stringify({
    mcpServers: Object.fromEntries(
      fixedServers.map((server) => [server.id, toClaudeServerConfig(server)]),
    ),
  });
}

/** Tool scope for claude `--allowedTools` / `--tools`. All MCP tools
 *  from the configured servers, regardless of server id. */
export function buildClaudeMcpToolScope(
  _fixedServers: EngineMcpServer[] | undefined,
): string {
  return "mcp__*";
}

export function buildCodexMcpServerConfig(
  input: McpConfigInput,
): Record<string, NativeMcpConfig> {
  const fixedServers = enabledFixedServers(input);
  return Object.fromEntries(
    fixedServers.map((server) => [server.id, toCodexServerConfig(server)]),
  );
}

/**
 * Build the `codex mcp add <name> ...` argv for a single fixed server,
 * used by the legacy `codex exec` path (the app-server path passes MCP
 * via thread/start config instead). stdio → `-- <command> <args>`;
 * http → `--url <url>`. Env vars become `--env K=V` (stdio only).
 */
export function codexMcpAddArgs(server: EngineMcpServer): string[] {
  if (server.transport === "stdio") {
    const env = server.env
      ? Object.entries(server.env).flatMap(([k, v]) => ["--env", `${k}=${v}`])
      : [];
    return ["mcp", "add", server.id, ...env, "--", server.command, ...server.args];
  }
  return ["mcp", "add", server.id, "--url", server.url];
}
