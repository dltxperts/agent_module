/**
 * @test-id: tst_runtime_run_execution_002
 * @scenario: scn_runtime_run_execution_001
 * @covers: src/agent/runner.ts
 * @deterministic: yes
 *
 * Runtime run execution: creating a run starts the injected runner,
 * persists stream events, and exposes them through long polling + SSE.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Test } from "@nestjs/testing";
import { Injectable, type INestApplication } from "@nestjs/common";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import { AppModule } from "../app.module";
import { AgentRunner } from "../agent/runner";
import { RunEventLogService } from "../runtime/run-event-log.service";
import { RunStoreService } from "../runtime/run-store.service";

let app: INestApplication;
let agentHome: string;

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

@Injectable()
class FakeAgentRunner {
  constructor(
    private readonly runs: RunStoreService,
    private readonly events: RunEventLogService,
  ) {}

  start(runId: string): void {
    void this.execute(runId);
  }

  private async execute(runId: string): Promise<void> {
    await this.runs.markRunning(runId);
    await this.events.append(runId, { type: "engine_resolved", engine: "codex" });
    await this.events.append(runId, { type: "delta", content: "hello" });
    await this.runs.markCompleted(runId, "hello");
    await this.events.append(runId, { type: "done", full_content: "hello" });
  }
}

beforeEach(async () => {
  agentHome = await mkdtemp(join(tmpdir(), "agent-runtime-run-test-"));
  await writeFile(
    join(agentHome, "mcp-servers.json"),
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
      ],
    }),
  );

  process.env.AGENT_HOME = agentHome;
  process.env.AGENT_MCP_CONFIG = join(agentHome, "mcp-servers.json");
  delete process.env.AGENT_RUNNER_DISABLED;

  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  })
    .overrideProvider(AgentRunner)
    .useClass(FakeAgentRunner)
    .compile();

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

describe("runtime run execution", () => {
  test("tst_runtime_run_execution_long_poll_001 persists runner events", async () => {
    await requestJson("/v1/sessions", {
      method: "POST",
      body: JSON.stringify({
        id: "exec-session",
        engine: "codex",
        cwd: "/tmp/project",
        mcp_server_ids: ["filesystem"],
      }),
    });

    const created = await requestJson("/v1/sessions/exec-session/runs", {
      method: "POST",
      body: JSON.stringify({ message: { role: "user", content: "hello" } }),
    });
    expect(created.status).toBe(201);
    const createdBody = await created.json() as { run_id: string; status: string };
    expect(createdBody.status).toBe("queued");

    let cursor = 0;
    let done = false;
    const collected: Array<{ type: string; content?: string; full_content?: string }> = [];
    while (!done) {
      const events = await requestJson(
        `/v1/runs/${createdBody.run_id}/events?cursor=${cursor}&timeout_ms=1000&limit=10`,
      );
      expect(events.status).toBe(200);
      const eventBody = await events.json() as {
        done: boolean;
        next_cursor: number;
        events: Array<{ type: string; content?: string; full_content?: string }>;
      };
      cursor = eventBody.next_cursor;
      done = eventBody.done;
      collected.push(...eventBody.events);
    }

    expect(cursor).toBe(3);
    expect(collected.map((event) => event.type)).toEqual([
      "engine_resolved",
      "delta",
      "done",
    ]);

    const run = await requestJson(`/v1/runs/${createdBody.run_id}`);
    expect(run.status).toBe(200);
    expect(await run.json()).toMatchObject({
      id: createdBody.run_id,
      status: "completed",
      output: { full_content: "hello" },
    });
  });

  test("tst_runtime_run_execution_sse_001 streams events as server-sent events", async () => {
    await requestJson("/v1/sessions", {
      method: "POST",
      body: JSON.stringify({
        id: "sse-session",
        engine: "codex",
        cwd: "/tmp/project",
        mcp_server_ids: ["filesystem"],
      }),
    });

    const response = await requestJson("/v1/sessions/sse-session/runs/stream", {
      method: "POST",
      body: JSON.stringify({ message: { role: "user", content: "hello" } }),
    });
    expect(response.status).toBe(201);
    expect(response.headers.get("content-type") ?? "").toContain("text/event-stream");

    const text = await response.text();
    expect(text).toContain("event: engine_resolved");
    expect(text).toContain("event: delta");
    expect(text).toContain("event: done");
    expect(text).toContain('"full_content":"hello"');
  });
});
