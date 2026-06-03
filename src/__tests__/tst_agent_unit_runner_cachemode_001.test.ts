/**
 * @test-id: tst_agent_unit_runner_cachemode_001
 * @covers: src/agent/runner.ts
 * @deterministic: yes
 *
 * Stage 2 (INV-5): the runner derives cacheMode + previousEngine from
 * the session's `last_engine` instead of hardcoding "resume", and
 * records the engine that produced the turn on completion.
 */

import { describe, expect, test } from "bun:test";
import { AgentRunner } from "../agent/runner";
import type { AgentSession, Run } from "../runtime/types";

interface ChatCall {
  cacheMode?: string;
  previousEngine?: string | null;
  messages?: Array<{ role: string; content: string }>;
}

function makeHarness(session: Partial<AgentSession>, priorRuns: Run[] = []) {
  const chatCalls: ChatCall[] = [];
  const setLastEngineCalls: Array<{ id: string; engine: string }> = [];

  const fullSession: AgentSession = {
    id: "s1",
    engine: "claude",
    cwd: "/work",
    permission_mode: "restricted",
    mcp_server_ids: [],
    created_at: "t",
    updated_at: "t",
    ...session,
  } as AgentSession;

  const run: Run = {
    id: "run_1",
    session_id: "s1",
    engine: fullSession.engine,
    status: "queued",
    input: { message: { role: "user", content: "hi" } },
    created_at: "t",
  };

  const runs = {
    markRunning: async () => run,
    markCompleted: async () => run,
    markFailed: async () => run,
    listForSession: async () => [...priorRuns, run],
  };
  const sessions = {
    get: async () => fullSession,
    setLastEngine: async (id: string, engine: string) => {
      setLastEngineCalls.push({ id, engine });
      return fullSession;
    },
  };
  const events = { append: async () => ({}) };
  const mcp = { getMany: () => [] };
  const agent = {
    async *chat(input: ChatCall) {
      chatCalls.push({
        cacheMode: input.cacheMode,
        previousEngine: input.previousEngine,
        messages: input.messages,
      });
      yield { type: "done", full_content: "ok" };
    },
  };

  const runner = new AgentRunner(
    runs as never,
    sessions as never,
    events as never,
    mcp as never,
    agent as never,
  );
  return { runner, chatCalls, setLastEngineCalls };
}

async function drain(runner: AgentRunner): Promise<void> {
  // `start` is fire-and-forget; await the underlying execute via a tick loop.
  runner.start("run_1");
  // Allow the async generator pipeline to settle.
  for (let i = 0; i < 50; i++) await Promise.resolve();
}

describe("AgentRunner cacheMode derivation (INV-5)", () => {
  test("tst_agent_unit_runner_cachemode_001_first_run_is_replay", async () => {
    const { runner, chatCalls } = makeHarness({ engine: "claude", last_engine: undefined });
    await drain(runner);
    expect(chatCalls[0].cacheMode).toBe("replay");
    expect(chatCalls[0].previousEngine).toBe(null);
  });

  test("tst_agent_unit_runner_cachemode_002_same_engine_is_resume", async () => {
    const { runner, chatCalls } = makeHarness({ engine: "claude", last_engine: "claude" });
    await drain(runner);
    expect(chatCalls[0].cacheMode).toBe("resume");
    expect(chatCalls[0].previousEngine).toBe("claude");
  });

  test("tst_agent_unit_runner_cachemode_003_engine_switch_is_replay", async () => {
    const { runner, chatCalls } = makeHarness({ engine: "codex", last_engine: "claude" });
    await drain(runner);
    expect(chatCalls[0].cacheMode).toBe("replay");
    expect(chatCalls[0].previousEngine).toBe("claude");
  });

  test("tst_agent_unit_runner_cachemode_004_records_last_engine_on_completion", async () => {
    const { runner, setLastEngineCalls } = makeHarness({ engine: "codex", last_engine: undefined });
    await drain(runner);
    expect(setLastEngineCalls).toEqual([{ id: "s1", engine: "codex" }]);
  });
});

describe("AgentRunner replay transcript reconstruction (Stage 7)", () => {
  test("tst_agent_unit_runner_replay_001_rebuilds_history_from_prior_runs", async () => {
    // Engine switch → replay. The new engine has no CLI transcript, so
    // the runner reconstructs it from prior completed runs (user input
    // + assistant output) and appends the current message.
    const prior: Run[] = [
      {
        id: "run_0",
        session_id: "s1",
        engine: "claude",
        status: "completed",
        input: { message: { role: "user", content: "first question" } },
        output: { full_content: "first answer" },
        created_at: "t0",
      },
    ];
    const { runner, chatCalls } = makeHarness(
      { engine: "codex", last_engine: "claude" },
      prior,
    );
    await drain(runner);
    expect(chatCalls[0].cacheMode).toBe("replay");
    expect(chatCalls[0].messages).toEqual([
      { role: "user", content: "first question" },
      { role: "assistant", content: "first answer" },
      { role: "user", content: "hi" },
    ]);
  });

  test("tst_agent_unit_runner_replay_002_resume_sends_only_current_message", async () => {
    const prior: Run[] = [
      {
        id: "run_0",
        session_id: "s1",
        engine: "claude",
        status: "completed",
        input: { message: { role: "user", content: "first question" } },
        output: { full_content: "first answer" },
        created_at: "t0",
      },
    ];
    // Same engine → resume: the CLI session holds history, so only the
    // current message is sent (no reconstruction).
    const { runner, chatCalls } = makeHarness(
      { engine: "claude", last_engine: "claude" },
      prior,
    );
    await drain(runner);
    expect(chatCalls[0].cacheMode).toBe("resume");
    expect(chatCalls[0].messages).toEqual([{ role: "user", content: "hi" }]);
  });
});
