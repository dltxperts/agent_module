/**
 * @test-id: tst_runtime_api_contract_001
 * @scenario: scn_runtime_session_mcp_001
 * @covers: src/app.module.ts
 * @deterministic: yes
 *
 * Runtime API contract: fixed startup MCPs, fixed sessions, run event polling.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import { AppModule } from "../app.module";

let app: INestApplication;
let agentHome: string;
let mcpConfigPath: string;

async function requestJson(path: string, init?: RequestInit): Promise<Response> {
  const url = await app.getUrl();
  return fetch(`${url}${path}`, {
    ...init,
    headers: {
      ...(init?.body && !(init.body instanceof FormData)
        ? { "Content-Type": "application/json" }
        : {}),
      ...(init?.headers ?? {}),
    },
  });
}

beforeEach(async () => {
  agentHome = await mkdtemp(join(tmpdir(), "agent-runtime-test-"));
  mcpConfigPath = join(agentHome, "mcp-servers.json");
  await writeFile(
    mcpConfigPath,
    JSON.stringify({
      servers: [
        {
          id: "filesystem",
          name: "Filesystem",
          enabled: true,
          transport: "stdio",
          command: "node",
          args: ["fake-mcp.js"],
        },
        {
          id: "disabled",
          name: "Disabled",
          enabled: false,
          transport: "stdio",
          command: "node",
          args: ["disabled.js"],
        },
      ],
    }),
  );

  process.env.AGENT_HOME = agentHome;
  process.env.AGENT_MCP_CONFIG = mcpConfigPath;
  process.env.AGENT_RUNNER_DISABLED = "1";

  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  app = moduleRef.createNestApplication();
  await app.listen(0);
});

afterEach(async () => {
  await app?.close();
  await rm(agentHome, { recursive: true, force: true });
  delete process.env.AGENT_HOME;
  delete process.env.AGENT_MCP_CONFIG;
  delete process.env.AGENT_RUNNER_DISABLED;
});

describe("standalone runtime API contract", () => {
  test("tst_runtime_api_health_001 returns runtime health", async () => {
    const response = await requestJson("/v1/health");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok", version: "0.1.0" });
  });

  test("tst_runtime_api_engines_001 omits builtin by default", async () => {
    const response = await requestJson("/v1/engines");
    expect(response.status).toBe(200);
    const body = await response.json() as { engines: Array<{ id: string }> };
    expect(body.engines.map((engine) => engine.id)).toEqual(["claude", "codex"]);
  });

  test("tst_runtime_api_mcp_001 lists startup configured MCP servers", async () => {
    const response = await requestJson("/v1/mcp/servers");
    expect(response.status).toBe(200);
    const body = await response.json() as {
      servers: Array<{ id: string; name: string; enabled: boolean; transport: string }>;
    };
    expect(body.servers).toEqual([
      { id: "filesystem", name: "Filesystem", enabled: true, transport: "stdio" },
      { id: "disabled", name: "Disabled", enabled: false, transport: "stdio" },
    ]);
  });

  test("tst_runtime_api_mcp_003 rejects REST mutation of MCP servers", async () => {
    const create = await requestJson("/v1/mcp/servers", {
      method: "POST",
      body: JSON.stringify({ id: "new" }),
    });
    expect(create.status).toBe(404);

    const patch = await requestJson("/v1/mcp/servers/filesystem", {
      method: "PATCH",
      body: JSON.stringify({ enabled: false }),
    });
    expect(patch.status).toBe(404);

    const del = await requestJson("/v1/mcp/servers/filesystem", { method: "DELETE" });
    expect(del.status).toBe(404);
  });

  test("tst_runtime_api_sessions_001 creates fixed-id session bound to startup MCP IDs", async () => {
    const response = await requestJson("/v1/sessions", {
      method: "POST",
      body: JSON.stringify({
        id: "fixed-session",
        engine: "codex",
        cwd: "/tmp/project",
        mcp_server_ids: ["filesystem"],
      }),
    });
    expect(response.status).toBe(201);
    const body = await response.json() as { id: string; engine: string; mcp_server_ids: string[] };
    expect(body.id).toBe("fixed-session");
    expect(body.engine).toBe("codex");
    expect(body.mcp_server_ids).toEqual(["filesystem"]);
  });

  test("tst_runtime_api_sessions_006 rejects unknown MCP IDs", async () => {
    const response = await requestJson("/v1/sessions", {
      method: "POST",
      body: JSON.stringify({
        id: "bad-session",
        engine: "codex",
        cwd: "/tmp/project",
        mcp_server_ids: ["missing"],
      }),
    });
    expect(response.status).toBe(400);
  });

  test("tst_runtime_api_runs_long_poll_002 returns empty result after timeout", async () => {
    const session = await requestJson("/v1/sessions", {
      method: "POST",
      body: JSON.stringify({
        id: "poll-session",
        engine: "codex",
        cwd: "/tmp/project",
        mcp_server_ids: ["filesystem"],
      }),
    });
    expect(session.status).toBe(201);

    const run = await requestJson("/v1/sessions/poll-session/runs", {
      method: "POST",
      body: JSON.stringify({
        message: { role: "user", content: "hello" },
      }),
    });
    expect(run.status).toBe(201);
    const runBody = await run.json() as { run_id: string };

    const events = await requestJson(
      `/v1/runs/${runBody.run_id}/events?cursor=0&timeout_ms=5&limit=10`,
    );
    expect(events.status).toBe(200);
    expect(await events.json()).toEqual({
      run_id: runBody.run_id,
      next_cursor: 0,
      done: false,
      events: [],
    });
  });

  test("tst_runtime_api_files_001 uploads metadata and downloads bytes", async () => {
    const form = new FormData();
    form.append(
      "file",
      new Blob(["hello runtime"], { type: "text/plain" }),
      "hello.txt",
    );

    const upload = await requestJson("/v1/files", {
      method: "POST",
      body: form,
      headers: {},
    });
    expect(upload.status).toBe(201);
    const metadata = await upload.json() as {
      id: string;
      name: string;
      mime_type: string;
      size: number;
      sha256: string;
    };
    expect(metadata.name).toBe("hello.txt");
    expect(metadata.mime_type).toBe("text/plain");
    expect(metadata.size).toBe(13);
    expect(metadata.sha256.length).toBe(64);

    const meta = await requestJson(`/v1/files/${metadata.id}/metadata`);
    expect(meta.status).toBe(200);
    expect(await meta.json()).toMatchObject({
      id: metadata.id,
      name: "hello.txt",
      mime_type: "text/plain",
      size: 13,
    });

    const download = await requestJson(`/v1/files/${metadata.id}`);
    expect(download.status).toBe(200);
    expect(await download.text()).toBe("hello runtime");
  });
});
