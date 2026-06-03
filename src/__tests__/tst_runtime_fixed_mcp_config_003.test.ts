/**
 * @test-id: tst_runtime_fixed_mcp_config_003
 * @scenario: scn_runtime_fixed_mcp_config_001
 * @covers: src/agent/mcp.ts
 * @deterministic: yes
 *
 * Fixed startup MCP config is converted to Claude/Codex native config
 * without relying on a Magnis MCP proxy URL.
 */

import { describe, expect, test } from "bun:test";

import {
  buildClaudeMcpConfig,
  buildClaudeMcpToolScope,
  buildCodexMcpServerConfig,
} from "../agent/mcp";
import type { EngineMcpServer } from "../agent/types";

const fixedServers: EngineMcpServer[] = [
  {
    id: "filesystem",
    name: "Filesystem",
    enabled: true,
    transport: "stdio",
    command: "node",
    args: ["filesystem.js"],
    env: { ROOT: "/tmp/project" },
    cwd: "/tmp/project",
  },
  {
    id: "docs",
    name: "Docs",
    enabled: true,
    transport: "http",
    url: "https://mcp.example.test/mcp",
    headers: { Authorization: "Bearer static-token" },
  },
];

describe("fixed startup MCP engine config", () => {
  test("tst_runtime_fixed_mcp_config_001 builds Claude config from fixed servers", () => {
    expect(buildClaudeMcpConfig({ fixedServers })).toEqual(JSON.stringify({
      mcpServers: {
        filesystem: {
          command: "node",
          args: ["filesystem.js"],
          env: { ROOT: "/tmp/project" },
          cwd: "/tmp/project",
        },
        docs: {
          type: "http",
          url: "https://mcp.example.test/mcp",
          headers: { Authorization: "Bearer static-token" },
        },
      },
    }));
    expect(buildClaudeMcpToolScope(fixedServers)).toBe("mcp__*");
  });

  test("tst_runtime_fixed_mcp_config_002 builds Codex app-server config from fixed servers", () => {
    expect(buildCodexMcpServerConfig({ fixedServers })).toEqual({
      filesystem: {
        command: "node",
        args: ["filesystem.js"],
        env: { ROOT: "/tmp/project" },
        cwd: "/tmp/project",
      },
      docs: {
        url: "https://mcp.example.test/mcp",
        headers: { Authorization: "Bearer static-token" },
      },
    });
  });

  test("tst_runtime_fixed_mcp_config_003 empty servers yield empty MCP config (INV-8)", () => {
    // No legacy majordomo proxy fallback: a session with no enabled
    // MCP servers runs with an empty MCP set.
    expect(JSON.parse(buildClaudeMcpConfig({ fixedServers: [] }))).toEqual({
      mcpServers: {},
    });
    expect(buildCodexMcpServerConfig({ fixedServers: [] })).toEqual({});
    expect(buildClaudeMcpToolScope([])).toBe("mcp__*");
  });
});
