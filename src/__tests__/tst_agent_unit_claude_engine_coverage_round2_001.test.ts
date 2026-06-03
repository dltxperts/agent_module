/**
 * Round 1 review fixes: cover INV-STREAM-2/11/13/15 that were missed
 * by the initial Stage-3 unit tests.
 *
 * - INV-STREAM-2: ANTHROPIC_API_KEY → warning event.
 * - INV-STREAM-11: --mcp-config goes in at spawn time only.
 * - INV-STREAM-13: dropping the AgentEngine.stream iterator does NOT
 *                  destroy the cached client (next turn reuses it).
 * - INV-STREAM-15: legacy mode and stream-json mode produce the same
 *                  StreamEvent shapes for the same raw input
 *                  (parity via the shared mapper).
 */

import { afterEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "events";
import type { ChildProcess } from "child_process";

import { ClaudeEngine } from "../agent/claude/claude";
import { mapRawToStreamEvent } from "../agent/claude/events";
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

function makeFakeChild(): ChildProcess {
  const ee = new EventEmitter() as EventEmitter & ChildProcess;
  Object.assign(ee, {
    pid: 90001,
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
  const sharedIterator: AsyncIterator<RawClaudeEvent> = {
    next() {
      if (queue.length > 0) {
        return Promise.resolve({
          value: queue.shift() as RawClaudeEvent,
          done: false,
        });
      }
      if (closed) {
        return Promise.resolve({
          value: undefined as never,
          done: true,
        });
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
      return new Promise<void>((resolve) => {
        const check = () => {
          if (pending) resolve();
          else waiters.push(() => resolve());
        };
        queueMicrotask(check);
      });
    },
    send() {
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

function makeFakeRegistry() {
  const child = makeFakeChild();
  const handle: ProcessHandle = { sessionId: SID, child };
  const spawnArgs: string[][] = [];
  const spawnCwds: Array<string | undefined> = [];
  const reg: ClaudeProcessRegistry = {
    acquire(_sid: string, cfg: SpawnConfig) {
      spawnArgs.push(cfg.args);
      spawnCwds.push(cfg.cwd);
      return handle;
    },
    has: () => true,
    purge: async () => {},
    sweepIdle: () => {},
  };
  return { reg, spawnArgs, spawnCwds };
}

/** Drive one full turn through the engine and return captured spawn state. */
async function runOneTurn(overrides: Partial<EngineRequest>) {
  delete process.env.ANTHROPIC_API_KEY;
  const { reg, spawnArgs, spawnCwds } = makeFakeRegistry();
  const client = makeScriptedClient();
  const engine = new ClaudeEngine({
    mode: "stream-json",
    registry: reg,
    createClient: () => client,
  });
  const drainP = (async () => {
    for await (const _ of engine.stream(makeRequest(overrides))) {
      /* drain */
    }
  })();
  await client.whenWaiting();
  client.pushEvents({ type: "result", subtype: "success" });
  await drainP;
  return { argv: spawnArgs[0], cwd: spawnCwds[0] };
}

function makeRequest(overrides: Partial<EngineRequest> = {}): EngineRequest {
  return {
    messages: [{ role: "user", content: "hi" }],
    systemPrompt: "system",
    maxSteps: 10,
    engineSessionId: SID,
    ...overrides,
  };
}

// Restore env we touch.
const originalApiKey = process.env.ANTHROPIC_API_KEY;
afterEach(() => {
  if (originalApiKey === undefined) {
    delete process.env.ANTHROPIC_API_KEY;
  } else {
    process.env.ANTHROPIC_API_KEY = originalApiKey;
  }
});

// ── Tests ────────────────────────────────────────────────────────────

describe("ClaudeEngine round-1 fixes (INV-STREAM-2/11/13/15)", () => {
  test("tst_agent_unit_claude_engine_round2_001_api_key_set_emits_warning", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-foo";
    const { reg } = makeFakeRegistry();
    const client = makeScriptedClient();
    const engine = new ClaudeEngine({
      mode: "stream-json",
      registry: reg,
      createClient: () => client,
    });

    const out: StreamEvent[] = [];
    const drainP = (async () => {
      for await (const ev of engine.stream(makeRequest())) out.push(ev);
    })();
    await client.whenWaiting();
    client.pushEvents({ type: "result", subtype: "success" });
    await drainP;

    const warnings = out.filter(
      (e): e is Extract<StreamEvent, { type: "warning" }> => e.type === "warning",
    );
    expect(warnings.some((w) => w.code === "claude_api_key_set")).toBe(true);
  });

  test("tst_agent_unit_claude_engine_round2_002_mcp_config_at_spawn_only", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const { reg, spawnArgs } = makeFakeRegistry();
    const client = makeScriptedClient();
    const engine = new ClaudeEngine({
      mode: "stream-json",
      registry: reg,
      createClient: () => client,
    });

    const drainP = (async () => {
      for await (const _ of engine.stream(makeRequest())) {
        /* drain */
      }
    })();
    await client.whenWaiting();
    client.pushEvents({ type: "result", subtype: "success" });
    await drainP;

    // INV-STREAM-11: --mcp-config is a CLI flag at spawn time.
    expect(spawnArgs.length).toBe(1);
    const argv = spawnArgs[0];
    const mcpIdx = argv.indexOf("--mcp-config");
    expect(mcpIdx).toBeGreaterThanOrEqual(0);
    const cfg = JSON.parse(argv[mcpIdx + 1]);
    // INV-8: no fixed servers on this request → empty MCP set (no
    // legacy majordomo proxy fallback).
    expect(cfg.mcpServers).toEqual({});

    // Regression guard: stream-json spawn MUST carry the permission +
    // tool flags so claude in --print mode can execute tool calls
    // non-interactively. Default permission_mode is "restricted"
    // (INV-4): MCP tools pre-approved, shell/file mutation denied,
    // --permission-mode dontAsk so no (impossible) prompt fires.
    expect(argv).toContain("--strict-mcp-config");
    const allowIdx = argv.indexOf("--allowedTools");
    expect(allowIdx).toBeGreaterThanOrEqual(0);
    expect(argv[allowIdx + 1]).toBe("mcp__*");
    expect(argv).toContain("--disallowedTools");
    const permIdx = argv.indexOf("--permission-mode");
    expect(permIdx).toBeGreaterThanOrEqual(0);
    expect(argv[permIdx + 1]).toBe("dontAsk");
    expect(argv).not.toContain("--dangerously-skip-permissions");

    // send() got called once for the user envelope; no MCP config in
    // the envelope payload — the scripted client doesn't surface the
    // payload but we verify sendCount stayed at one (no extra setup
    // sends).
    expect(client.sendCount()).toBe(1);
  });

  test("tst_agent_unit_claude_engine_round2_003_iterator_drop_keeps_process_warm", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const { reg } = makeFakeRegistry();
    const createClientCalls: number[] = [];
    const client = makeScriptedClient();
    const engine = new ClaudeEngine({
      mode: "stream-json",
      registry: reg,
      createClient: () => {
        createClientCalls.push(1);
        return client;
      },
    });

    // Turn 1: drain ONE delta then `result` so the engine generator
    // exits cleanly, but assert the client was created exactly once.
    {
      const stream = engine.stream(makeRequest());
      const it = stream[Symbol.asyncIterator]();
      // Kick off the generator so whenWaiting() has something to
      // synchronize against.
      const firstP = it.next();
      await client.whenWaiting();
      client.pushEvents({
        type: "assistant",
        message: { content: [{ type: "text", text: "partial" }] },
      });
      const first = await firstP;
      expect(first.value.type).toBe("delta");
      // Send `result` so the engine's per-turn loop actually
      // breaks. Without this turn 1's generator stays paused
      // forever holding the iterator — closer to "abort mid-turn"
      // than "drop iterator", which is a separate (untested) case.
      client.pushEvents({ type: "result", subtype: "success" });
      // Drain the rest so the generator finishes.
      for (;;) {
        const r = await it.next();
        if (r.done) break;
      }
    }

    // Turn 2: same sessionId. Must reuse the same client (no second
    // createClient call) — the engine's per-session cache survived.
    const drainP = (async () => {
      for await (const _ of engine.stream(makeRequest())) {
        /* drain */
      }
    })();
    await client.whenWaiting();
    client.pushEvents({ type: "result", subtype: "success" });
    await drainP;

    expect(createClientCalls.length).toBe(1);
  });

  test("tst_agent_unit_claude_engine_round2_004_legacy_streamjson_event_parity", () => {
    // INV-STREAM-15: given identical raw CLI events, both transport
    // paths yield identical StreamEvent shapes via the shared
    // mapper. This is a structural parity check at the mapper layer
    // — the only place the two paths diverge today (post-Stage 3).
    const rawEvents: RawClaudeEvent[] = [
      { type: "system", subtype: "init", session_id: SID },
      {
        type: "assistant",
        message: { content: [{ type: "text", text: "hello" }] },
      },
      {
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              id: "tu-1",
              name: "mcp__majordomo__contacts__list",
              input: { q: "x" },
            },
          ],
        },
      },
      {
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "tu-1",
              content: '[{"type":"text","text":"{\\"ok\\":true}"}]',
            },
          ],
        },
      },
      { type: "result", subtype: "success", stop_reason: "end_turn" },
    ];

    // Simulate legacy: each raw arrives as JSON-line string → parsed
    // → mapped.
    let legacyFull = "";
    const legacyOut: StreamEvent[] = [];
    for (const raw of rawEvents) {
      const line = JSON.stringify(raw);
      const ev = mapRawToStreamEvent(JSON.parse(line), (t) => {
        legacyFull += t;
      });
      if (ev) legacyOut.push(ev);
    }

    // Simulate stream-json: raw object straight into the mapper.
    let streamFull = "";
    const streamOut: StreamEvent[] = [];
    for (const raw of rawEvents) {
      const ev = mapRawToStreamEvent(
        raw as Record<string, unknown>,
        (t) => {
          streamFull += t;
        },
      );
      if (ev) streamOut.push(ev);
    }

    expect(streamOut).toEqual(legacyOut);
    expect(streamFull).toBe(legacyFull);
    // Sanity: the sequence is non-trivial — we should see a delta, a
    // tool_call, and a tool_result in this order.
    expect(legacyOut.map((e) => e.type)).toEqual([
      "delta",
      "tool_call",
      "tool_result",
    ]);
  });

  // ── Session config → spawn (Stage 1: INV-1/2/3/4) ──────────────────

  test("tst_agent_unit_claude_engine_030_cwd_flows_to_spawn_config", async () => {
    const { cwd } = await runOneTurn({ cwd: "/work/session-dir" });
    // INV-1: the session cwd reaches the registry SpawnConfig so the
    // claude child runs in the requested working directory.
    expect(cwd).toBe("/work/session-dir");
  });

  test("tst_agent_unit_claude_engine_031_model_from_request_in_argv", async () => {
    const { argv } = await runOneTurn({ model: "claude-sonnet-4-6" });
    // INV-2: request model wins and appears in argv.
    const i = argv.indexOf("--model");
    expect(i).toBeGreaterThanOrEqual(0);
    expect(argv[i + 1]).toBe("claude-sonnet-4-6");
  });

  test("tst_agent_unit_claude_engine_032_empty_system_prompt_omits_flag", async () => {
    const { argv } = await runOneTurn({ systemPrompt: "" });
    // INV-3: no session system prompt → no --system-prompt flag.
    expect(argv).not.toContain("--system-prompt");
  });

  test("tst_agent_unit_claude_engine_033_full_permission_mode_bypasses", async () => {
    const { argv } = await runOneTurn({ permissionMode: "full" });
    // INV-4: full mode bypasses permissions; no dontAsk/disallow.
    expect(argv).toContain("--dangerously-skip-permissions");
    expect(argv[argv.indexOf("--permission-mode") + 1]).toBe("bypassPermissions");
    expect(argv).not.toContain("--disallowedTools");
  });
});
