import { describe, expect, test } from "bun:test";
import { EventEmitter } from "events";
import { mkdtemp, writeFile, access } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import { purgePreviousEngineSession } from "../agent/purge";
import { createClaudeProcessRegistry } from "../agent/claude/registry";
import type { SpawnFn } from "../agent/claude/types";

const SID = "22222222-3333-4444-5555-666666666666";

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

function makeRegistry() {
  const fn: SpawnFn = () =>
    makeFakeChild(99001) as unknown as ReturnType<SpawnFn>;
  return createClaudeProcessRegistry({ spawn: fn });
}

describe("cross-engine purge wires the claude registry (Stage 4, INV-STREAM-7/14)", () => {
  test("tst_agent_unit_cross_engine_purge_stream_001_claude_purge_drops_registry_slot_and_file", async () => {
    const reg = makeRegistry();
    const handle = reg.acquire(SID, { args: [] });
    expect(reg.has(SID)).toBe(true);

    // Also drop a fake rollout file so we can check filesystem purge.
    const dir = await mkdtemp(join(tmpdir(), "magnis-purge-stream-"));
    const file = join(dir, `${SID}.jsonl`);
    await writeFile(file, "{}");

    // The cross-engine helper must accept an explicit registry for
    // testability (no global singletons in unit-land).
    await purgePreviousEngineSession("claude", SID, {
      claudeRegistry: reg,
      claudeSessionPath: file,
    });

    // Registry slot gone, child SIGTERM'd.
    expect(reg.has(SID)).toBe(false);
    const child = handle.child as unknown as { killSignals: string[] };
    expect(child.killSignals[0]).toBe("SIGTERM");

    // File removed.
    await expect(access(file)).rejects.toThrow();
  });

  test("tst_agent_unit_cross_engine_purge_stream_002_codex_previous_does_not_touch_claude_registry", async () => {
    const reg = makeRegistry();
    reg.acquire(SID, { args: [] });
    const previousCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = await mkdtemp(join(tmpdir(), "magnis-codex-home-"));

    try {
      // Switching FROM codex (previousEngine="codex") should not touch
      // the claude registry — codex side gets its own filesystem purge.
      // INV-STREAM-14: a switch-AWAY-from-claude is handled in the
      // engine layer at the next acquire; this helper only deals with
      // tearing down the engine whose name matches `previousEngine`.
      await purgePreviousEngineSession("codex", SID, {
        claudeRegistry: reg,
      });
      expect(reg.has(SID)).toBe(true);
    } finally {
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
    }
  });
});
