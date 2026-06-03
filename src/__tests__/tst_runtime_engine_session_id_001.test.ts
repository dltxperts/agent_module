/**
 * @test-id: tst_runtime_engine_session_id_001
 * @covers: src/runtime/session-store.service.ts, src/agent/runner.ts
 * @deterministic: yes
 *
 * Bug (found in e2e): the CLI engines require a valid UUID for
 * --session-id / codex thread id, but a session's user-facing `id` is
 * an arbitrary string. Each session must mint a separate
 * `engine_session_id` (UUID) and the runner must pass THAT to the engine.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import { SessionStoreService } from "../runtime/session-store.service";
import { RuntimeConfigService } from "../runtime/config.service";
import { StartupMcpConfigService } from "../runtime/startup-mcp-config.service";
import { AgentRunner } from "../agent/runner";
import type { AgentSession, Run } from "../runtime/types";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let home: string;
const prevHome = process.env.AGENT_HOME;
const prevMcp = process.env.AGENT_MCP_CONFIG;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "esid-"));
  process.env.AGENT_HOME = home;
  process.env.AGENT_MCP_CONFIG = join(home, "mcp-servers.json");
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
  if (prevHome === undefined) delete process.env.AGENT_HOME;
  else process.env.AGENT_HOME = prevHome;
  if (prevMcp === undefined) delete process.env.AGENT_MCP_CONFIG;
  else process.env.AGENT_MCP_CONFIG = prevMcp;
});

function store(): SessionStoreService {
  const config = new RuntimeConfigService();
  const mcp = new StartupMcpConfigService(config);
  return new SessionStoreService(config, mcp);
}

describe("engine_session_id minting (UUID for CLI engines)", () => {
  test("tst_runtime_engine_session_id_001_create_mints_uuid_distinct_from_id", async () => {
    const s = await store().create({
      id: "human-friendly-id",
      engine: "claude",
      cwd: "/tmp/x",
    });
    expect(s.engine_session_id).toMatch(UUID_RE);
    expect(s.engine_session_id).not.toBe(s.id);
  });

  test("tst_runtime_engine_session_id_002_runner_passes_engine_session_id_to_chat", async () => {
    const session: AgentSession = {
      id: "human-friendly-id",
      engine_session_id: "11111111-2222-3333-4444-555555555555",
      engine: "claude",
      cwd: "/tmp/x",
      permission_mode: "full",
      mcp_server_ids: [],
      created_at: "t",
      updated_at: "t",
    };
    const run: Run = {
      id: "run_1",
      session_id: session.id,
      engine: "claude",
      status: "queued",
      input: { message: { role: "user", content: "hi" } },
      created_at: "t",
    };
    let seenSessionId: string | undefined;
    const runner = new AgentRunner(
      { markRunning: async () => run, markCompleted: async () => run, markFailed: async () => run, listForSession: async () => [run] } as never,
      { get: async () => session, setLastEngine: async () => session } as never,
      { append: async () => ({}) } as never,
      { getMany: () => [] } as never,
      {
        async *chat(input: { sessionId?: string }) {
          seenSessionId = input.sessionId;
          yield { type: "done", full_content: "ok" };
        },
      } as never,
    );
    runner.start("run_1");
    for (let i = 0; i < 50; i++) await Promise.resolve();
    expect(seenSessionId).toBe("11111111-2222-3333-4444-555555555555");
  });
});
