/**
 * @test-id: tst_runtime_event_log_seq_001
 * @covers: src/runtime/run-event-log.service.ts
 * @deterministic: yes
 *
 * Stage 6 (INV-9): append assigns a monotonic seq in O(1) — it does
 * NOT re-read the whole event file on every append. A fresh service
 * instance (process restart) resumes the seq from the file tail.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import { RunEventLogService } from "../runtime/run-event-log.service";
import type { RunEvent } from "../runtime/types";

let agentHome: string;

class CountingLog extends RunEventLogService {
  reads = 0;
  async read(runId: string, cursor: number, limit: number): Promise<RunEvent[]> {
    this.reads += 1;
    return super.read(runId, cursor, limit);
  }
}

function makeLog(): CountingLog {
  return new CountingLog({ agentHome } as never);
}

beforeEach(async () => {
  agentHome = await mkdtemp(join(tmpdir(), "evlog-"));
});
afterEach(async () => {
  await rm(agentHome, { recursive: true, force: true });
});

describe("RunEventLogService append seq (INV-9)", () => {
  test("tst_runtime_event_log_seq_001_monotonic_without_full_reread", async () => {
    const log = makeLog();
    const seqs: number[] = [];
    for (let i = 0; i < 5; i++) {
      const ev = await log.append("run_x", { type: "delta", content: `c${i}` });
      seqs.push(ev.seq);
    }
    // Correctness: seq is 1..5.
    expect(seqs).toEqual([1, 2, 3, 4, 5]);
    // INV-9: at most ONE file read across all five appends (lazy init),
    // not one read per append.
    expect(log.reads).toBeLessThanOrEqual(1);
  });

  test("tst_runtime_event_log_seq_002_resumes_from_file_after_restart", async () => {
    const first = makeLog();
    await first.append("run_y", { type: "delta", content: "a" });
    await first.append("run_y", { type: "delta", content: "b" });

    // New instance == process restart: in-memory counter is empty, so
    // it must read the file once to resume the seq.
    const restarted = makeLog();
    const ev = await restarted.append("run_y", { type: "done", full_content: "b" });
    expect(ev.seq).toBe(3);
  });
});
