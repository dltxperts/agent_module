import { describe, expect, test } from "bun:test";
import { EventEmitter } from "events";

import { createClaudeProcessRegistry } from "../agent/claude/registry";
import type { SpawnFn } from "../agent/claude/types";

const SID_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const SID_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const SID_C = "cccccccc-cccc-cccc-cccc-cccccccccccc";

// Tiny ChildProcess stand-in. Only the fields the registry touches.
function makeFakeChild(pid: number) {
  const c = new EventEmitter() as EventEmitter & {
    pid: number;
    kill: (signal?: string) => boolean;
    killSignals: string[];
    stdin: { write: () => boolean; end: () => void };
    stdout: EventEmitter;
    stderr: EventEmitter;
  };
  c.pid = pid;
  c.killSignals = [];
  c.kill = (signal = "SIGTERM") => {
    c.killSignals.push(signal);
    // Mimic OS: emit close on next tick when SIGTERM/SIGKILL is requested.
    if (signal === "SIGTERM" || signal === "SIGKILL") {
      queueMicrotask(() => c.emit("close", 0, signal));
    }
    return true;
  };
  c.stdin = { write: () => true, end: () => {} };
  c.stdout = new EventEmitter();
  c.stderr = new EventEmitter();
  return c;
}

function makeSpawnSpy(pids: number[]) {
  const calls: Array<{ args: string[] }> = [];
  let i = 0;
  const fn: SpawnFn = (_cmd, args) => {
    const child = makeFakeChild(pids[i++] ?? 99000);
    calls.push({ args: args as string[] });
    return child as unknown as ReturnType<SpawnFn>;
  };
  return { fn, calls };
}

describe("ClaudeProcessRegistry (Stage 1, INV-STREAM-1/7/8)", () => {
  test("tst_agent_unit_claude_registry_001_acquire_once_then_reuses_handle", () => {
    // INV-STREAM-1: two acquire() calls for the same engineSessionId
    // must spawn exactly once and return the same handle on the
    // second call.
    const { fn, calls } = makeSpawnSpy([12001, 12002]);
    const reg = createClaudeProcessRegistry({ spawn: fn });

    const cfg = { args: ["--print", "--input-format", "stream-json"] };
    const h1 = reg.acquire(SID_A, cfg);
    const h2 = reg.acquire(SID_A, cfg);

    expect(calls.length).toBe(1);
    expect(h1).toBe(h2);
    expect(h1.sessionId).toBe(SID_A);
    expect(h1.child.pid).toBe(12001);
  });

  test("tst_agent_unit_claude_registry_002_distinct_sessions_spawn_distinct_processes", () => {
    const { fn, calls } = makeSpawnSpy([13001, 13002]);
    const reg = createClaudeProcessRegistry({ spawn: fn });

    const cfg = { args: ["--print"] };
    const a = reg.acquire(SID_A, cfg);
    const b = reg.acquire(SID_B, cfg);

    expect(calls.length).toBe(2);
    expect(a).not.toBe(b);
    expect(a.child.pid).toBe(13001);
    expect(b.child.pid).toBe(13002);
  });

  test("tst_agent_unit_claude_registry_purge_001_sends_sigterm_and_removes_slot", async () => {
    // INV-STREAM-7: purge sends SIGTERM and the slot is no longer
    // discoverable.
    const { fn } = makeSpawnSpy([14001]);
    const reg = createClaudeProcessRegistry({ spawn: fn });

    const h = reg.acquire(SID_A, { args: ["--print"] });
    expect(reg.has(SID_A)).toBe(true);

    await reg.purge(SID_A);

    const child = h.child as unknown as { killSignals: string[] };
    expect(child.killSignals[0]).toBe("SIGTERM");
    expect(reg.has(SID_A)).toBe(false);
  });

  test("tst_agent_unit_claude_registry_purge_002_idempotent_for_unknown_session", async () => {
    const { fn } = makeSpawnSpy([]);
    const reg = createClaudeProcessRegistry({ spawn: fn });

    // Must not throw — no slot, nothing to do.
    await reg.purge("zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz");
    expect(reg.has("zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz")).toBe(false);
  });

  test("tst_agent_unit_claude_registry_lru_001_evicts_oldest_when_capacity_exceeded", async () => {
    // INV-STREAM-8: bounded LRU. When acquire exceeds capacity, the
    // least-recently-used slot is evicted with SIGTERM.
    const { fn } = makeSpawnSpy([15001, 15002, 15003]);
    const reg = createClaudeProcessRegistry({ spawn: fn, capacity: 2 });

    const a = reg.acquire(SID_A, { args: [] });
    const b = reg.acquire(SID_B, { args: [] });
    // Touch B to keep it MRU; A is now LRU.
    reg.acquire(SID_B, { args: [] });
    const c = reg.acquire(SID_C, { args: [] });

    // Let any queued microtask close events flush.
    await Promise.resolve();

    // A should be evicted.
    expect(reg.has(SID_A)).toBe(false);
    const aChild = a.child as unknown as { killSignals: string[] };
    expect(aChild.killSignals[0]).toBe("SIGTERM");

    // B and C remain.
    expect(reg.has(SID_B)).toBe(true);
    expect(reg.has(SID_C)).toBe(true);
    expect(b.child.pid).toBe(15002);
    expect(c.child.pid).toBe(15003);
  });
});
