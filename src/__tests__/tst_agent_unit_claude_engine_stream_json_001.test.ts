import { describe, expect, test } from "bun:test";
import { EventEmitter } from "events";
import type { ChildProcess } from "child_process";
import { mkdtemp } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import { ClaudeEngine } from "../agent/claude/claude";
import type {
  ClaudeStreamClient,
  RawClaudeEvent,
} from "../agent/claude/types";
import type {
  ClaudeProcessRegistry,
  ProcessHandle,
  SpawnConfig,
} from "../agent/claude/types";
import type { EngineRequest, StreamEvent } from "../agent/types";

const SID = "11111111-2222-3333-4444-555555555555";

// ── Test doubles ─────────────────────────────────────────────────────

function makeFakeChild(): ChildProcess {
  const ee = new EventEmitter() as EventEmitter & ChildProcess;
  Object.assign(ee, {
    pid: 50001,
    stdin: { write: () => true, end: () => {}, once: () => {} },
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    kill: () => true,
  });
  return ee as unknown as ChildProcess;
}

interface ScriptableClient extends ClaudeStreamClient {
  pushEvents: (...evs: RawClaudeEvent[]) => void;
  sendCount: () => number;
  /** Resolves the next time the engine parks on `next()` waiting for
   * an event. Lets tests synchronize with the engine's iteration
   * without `Promise.resolve()` microtask roulette. */
  whenWaiting: () => Promise<void>;
}

function makeScriptedClient(): ScriptableClient {
  const queue: RawClaudeEvent[] = [];
  let pending: ((v: IteratorResult<RawClaudeEvent>) => void) | null = null;
  const waiters: Array<() => void> = [];
  let sendCount = 0;
  let closed = false;

  function push(ev: RawClaudeEvent) {
    if (pending) {
      const p = pending;
      pending = null;
      p({ value: ev, done: false });
    } else {
      queue.push(ev);
    }
  }

  // Hoist a single iterator so multiple `for await` blocks see the
  // same queue.
  const sharedIterator: AsyncIterator<RawClaudeEvent> = {
    next() {
      if (queue.length > 0) {
        return Promise.resolve({
          value: queue.shift() as RawClaudeEvent,
          done: false,
        });
      }
      if (closed) {
        return Promise.resolve({ value: undefined as never, done: true });
      }
      return new Promise<IteratorResult<RawClaudeEvent>>((res) => {
        pending = res;
        while (waiters.length) {
          const w = waiters.shift();
          if (w) w();
        }
      });
    },
    return() {
      return Promise.resolve({ value: undefined as never, done: false });
    },
  };

  return {
    pushEvents(...evs) {
      for (const e of evs) push(e);
    },
    sendCount: () => sendCount,
    whenWaiting() {
      // If the engine is already parked (no events queued and no
      // resolver pending yet) we still need to wait for the
      // engine's next iteration step. Easiest: poll once via a
      // microtask, then resolve when `pending` is set.
      return new Promise<void>((resolve) => {
        const check = () => {
          if (pending) resolve();
          else waiters.push(() => resolve());
        };
        queueMicrotask(check);
      });
    },
    send(_content) {
      sendCount += 1;
      return Promise.resolve();
    },
    events() {
      return { [Symbol.asyncIterator]: () => sharedIterator };
    },
    async close() {
      closed = true;
      if (pending) {
        const p = pending;
        pending = null;
        p({ value: undefined as never, done: true });
      }
    },
  };
}

function makeFakeRegistry(): {
  reg: ClaudeProcessRegistry;
  acquireCalls: string[];
  purgeCalls: string[];
} {
  const acquireCalls: string[] = [];
  const purgeCalls: string[] = [];
  const child = makeFakeChild();
  const handle: ProcessHandle = { sessionId: SID, child };
  const reg: ClaudeProcessRegistry = {
    acquire(sid: string, _cfg: SpawnConfig) {
      acquireCalls.push(sid);
      return handle;
    },
    has: () => true,
    purge: async (sid: string) => {
      purgeCalls.push(sid);
    },
    sweepIdle: () => {},
  };
  return { reg, acquireCalls, purgeCalls };
}

function makeEngineRequest(overrides: Partial<EngineRequest> = {}): EngineRequest {
  return {
    messages: [{ role: "user", content: "hi" }],
    systemPrompt: "system",
    maxSteps: 10,
    engineSessionId: SID,
    ...overrides,
  };
}

async function drain(stream: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const ev of stream) out.push(ev);
  return out;
}

// ── Tests ────────────────────────────────────────────────────────────

describe("ClaudeEngine stream-json path (Stage 3, INV-STREAM-1/15)", () => {
  test("tst_agent_unit_claude_engine_stream_json_001_two_turns_reuse_one_client", async () => {
    const { reg, acquireCalls } = makeFakeRegistry();
    const client = makeScriptedClient();
    const createClientCalls: number[] = [];

    const engine = new ClaudeEngine({
      mode: "stream-json",
      registry: reg,
      createClient: () => {
        createClientCalls.push(1);
        return client;
      },
    });

    // Drive turn 1.
    const turn1 = engine.stream(
      makeEngineRequest({ messages: [{ role: "user", content: "turn-1" }] }),
    );
    const turn1Out: StreamEvent[] = [];
    const turn1Drain = (async () => {
      for await (const ev of turn1) turn1Out.push(ev);
    })();
    // Wait a microtask so the engine has time to call send() + start
    // iterating events.
    await client.whenWaiting();
    client.pushEvents(
      { type: "system", subtype: "init", session_id: SID },
      { type: "assistant", message: { content: [{ type: "text", text: "hello" }] } },
      { type: "result", subtype: "success", stop_reason: "end_turn" },
    );
    await turn1Drain;

    // Drive turn 2.
    const turn2 = engine.stream(
      makeEngineRequest({ messages: [{ role: "user", content: "turn-2" }] }),
    );
    const turn2Out: StreamEvent[] = [];
    const turn2Drain = (async () => {
      for await (const ev of turn2) turn2Out.push(ev);
    })();
    await client.whenWaiting();
    client.pushEvents(
      { type: "assistant", message: { content: [{ type: "text", text: "again" }] } },
      { type: "result", subtype: "success", stop_reason: "end_turn" },
    );
    await turn2Drain;

    // INV-STREAM-1: spawned exactly once (createClient called once).
    expect(createClientCalls.length).toBe(1);
    // Registry was asked both times — caching of client happens in
    // the engine layer; the registry slot reuse is what makes it
    // cheap.
    expect(acquireCalls).toEqual([SID, SID]);
    // Each turn called send() exactly once.
    expect(client.sendCount()).toBe(2);

    // Both turns yielded delta + done.
    expect(turn1Out.map((e) => e.type)).toContain("delta");
    expect(turn1Out.map((e) => e.type)).toContain("done");
    expect(turn2Out.map((e) => e.type)).toContain("delta");
    expect(turn2Out.map((e) => e.type)).toContain("done");
  });

  test("tst_agent_unit_claude_engine_stream_json_003_replay_purges_registry_slot_before_acquire", async () => {
    // INV-STREAM-7 / -14: a replay cacheMode (engine switch or first
    // turn for this engine on this episode) must invalidate any
    // long-lived child for the same session.
    const { reg, purgeCalls } = makeFakeRegistry();
    const client = makeScriptedClient();
    const engine = new ClaudeEngine({
      mode: "stream-json",
      registry: reg,
      createClient: () => client,
    });
    const previousCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = await mkdtemp(join(tmpdir(), "magnis-codex-home-"));

    try {
      const stream = engine.stream(
        makeEngineRequest({ cacheMode: "replay", previousEngine: "codex" }),
      );
      const drainP = (async () => {
        for await (const _ of stream) {
          /* drain */
        }
      })();
      await client.whenWaiting();
      client.pushEvents(
        { type: "assistant", message: { content: [{ type: "text", text: "ok" }] } },
        { type: "result", subtype: "success" },
      );
      await drainP;

      expect(purgeCalls).toContain(SID);
    } finally {
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
    }
  });

  test("tst_agent_unit_claude_engine_stream_json_002_session_id_mismatch_emits_warning", async () => {
    // INV-STREAM-5: when system/init carries a session_id ≠ what we
    // requested, the engine must surface a warning and continue.
    const { reg } = makeFakeRegistry();
    const client = makeScriptedClient();

    const engine = new ClaudeEngine({
      mode: "stream-json",
      registry: reg,
      createClient: () => client,
    });

    const stream = engine.stream(makeEngineRequest());
    const out: StreamEvent[] = [];
    const drainP = (async () => {
      for await (const ev of stream) out.push(ev);
    })();
    await client.whenWaiting();
    client.pushEvents(
      { type: "system", subtype: "init", session_id: "WRONG-ID" },
      { type: "assistant", message: { content: [{ type: "text", text: "ok" }] } },
      { type: "result", subtype: "success" },
    );
    await drainP;

    const warnings = out.filter(
      (e): e is Extract<StreamEvent, { type: "warning" }> => e.type === "warning",
    );
    expect(warnings.length).toBeGreaterThanOrEqual(1);
    expect(warnings[0].code).toBe("claude_session_id_mismatch");
  });
});
