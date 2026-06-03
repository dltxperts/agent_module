import { describe, expect, test } from "bun:test";
import { EventEmitter } from "events";

import { createClaudeProcessRegistry } from "../agent/claude/registry";
import type { SpawnFn } from "../agent/claude/types";

const SID = "11111111-1111-1111-1111-111111111111";

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
  let i = 0;
  const fn: SpawnFn = () =>
    makeFakeChild(pids[i++] ?? 99000) as unknown as ReturnType<SpawnFn>;
  return fn;
}

describe("ClaudeProcessRegistry idle eviction (Stage 4, INV-STREAM-8)", () => {
  test("tst_agent_unit_claude_registry_idle_001_sweep_evicts_entries_older_than_idleMs", () => {
    // Use an injected clock to control "now". Acquire at t=0,
    // advance the clock past idleMs, then run sweep. The slot must
    // be gone and the child SIGTERM'd.
    let nowMs = 1000;
    const reg = createClaudeProcessRegistry({
      spawn: makeSpawnSpy([12001]),
      now: () => nowMs,
      idleMs: 500,
    });

    const h = reg.acquire(SID, { args: [] });
    expect(reg.has(SID)).toBe(true);

    // Within idle window.
    nowMs = 1499;
    reg.sweepIdle();
    expect(reg.has(SID)).toBe(true);

    // Crossed idle threshold.
    nowMs = 1501;
    reg.sweepIdle();
    expect(reg.has(SID)).toBe(false);

    const child = h.child as unknown as { killSignals: string[] };
    expect(child.killSignals[0]).toBe("SIGTERM");
  });

  test("tst_agent_unit_claude_registry_idle_002_acquire_resets_idle_timer", () => {
    let nowMs = 1000;
    const reg = createClaudeProcessRegistry({
      spawn: makeSpawnSpy([13001]),
      now: () => nowMs,
      idleMs: 500,
    });

    reg.acquire(SID, { args: [] });
    nowMs = 1400; // close to but not over the limit
    reg.acquire(SID, { args: [] }); // touch resets lastUsedAt to 1400
    nowMs = 1700; // 300ms after touch, still within 500ms window
    reg.sweepIdle();
    expect(reg.has(SID)).toBe(true);

    nowMs = 1900; // 500ms after touch
    reg.sweepIdle();
    expect(reg.has(SID)).toBe(true); // boundary — equal to idleMs is fine

    nowMs = 1901;
    reg.sweepIdle();
    expect(reg.has(SID)).toBe(false);
  });

  test("tst_agent_unit_claude_registry_idle_003_idleMs_omitted_disables_sweep", () => {
    let nowMs = 1000;
    const reg = createClaudeProcessRegistry({
      spawn: makeSpawnSpy([14001]),
      now: () => nowMs,
      // idleMs omitted → idle eviction off
    });
    reg.acquire(SID, { args: [] });
    nowMs += 60_000;
    reg.sweepIdle();
    expect(reg.has(SID)).toBe(true);
  });
});
