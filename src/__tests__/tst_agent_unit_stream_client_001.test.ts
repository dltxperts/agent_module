import { describe, expect, test } from "bun:test";
import { EventEmitter } from "events";
import type { ChildProcess } from "child_process";

import { createClaudeStreamClient } from "../agent/claude/stream";
import type { RawClaudeEvent } from "../agent/claude/types";

// ── ChildProcess test double ─────────────────────────────────────────

interface FakeStdin {
  written: string[];
  writeReturn: boolean;
  write(chunk: string, cb?: (err?: Error | null) => void): boolean;
  end(): void;
  endCalled: boolean;
  emit(ev: string): void;
}

function makeFakeStdin(): FakeStdin {
  const ee = new EventEmitter();
  const stdin: FakeStdin = {
    written: [],
    writeReturn: true,
    write(chunk: string, cb?: (err?: Error | null) => void): boolean {
      stdin.written.push(chunk);
      if (cb) queueMicrotask(() => cb(null));
      return stdin.writeReturn;
    },
    end(): void {
      stdin.endCalled = true;
    },
    endCalled: false,
    emit(ev: string): void {
      ee.emit(ev);
    },
  };
  Object.assign(stdin, {
    on: ee.on.bind(ee),
    once: ee.once.bind(ee),
    off: ee.off.bind(ee),
  });
  return stdin;
}

function makeFakeChild() {
  const ee = new EventEmitter() as EventEmitter & ChildProcess;
  const stdin = makeFakeStdin();
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  // Cast through unknown — the real type is fine for our needs and
  // we only touch the fields the client touches.
  Object.assign(ee, {
    pid: 99000,
    stdin,
    stdout,
    stderr,
    kill: () => true,
  });
  return ee as unknown as ChildProcess & {
    stdin: FakeStdin;
    stdout: EventEmitter;
    stderr: EventEmitter;
  };
}

function emitLines(stdout: EventEmitter, ...lines: string[]) {
  stdout.emit("data", Buffer.from(lines.map((l) => l + "\n").join("")));
}

// ── Tests ────────────────────────────────────────────────────────────

describe("ClaudeStreamClient (Stage 2, INV-STREAM-3/4)", () => {
  test("tst_agent_unit_stream_client_001_send_writes_canonical_json_line", async () => {
    const child = makeFakeChild();
    const client = createClaudeStreamClient(child);
    await client.send("hello");
    expect(child.stdin.written).toEqual([
      JSON.stringify({
        type: "user",
        message: { role: "user", content: "hello" },
      }) + "\n",
    ]);
  });

  test("tst_agent_unit_stream_client_002_events_yields_until_result", async () => {
    // INV-STREAM-3: events() should resolve the per-turn iteration on
    // the first `result/*` event after a send().
    const child = makeFakeChild();
    const client = createClaudeStreamClient(child);

    // Drain events on a background task.
    const collected: RawClaudeEvent[] = [];
    const iter = client.events();
    const drain = (async () => {
      for await (const ev of iter) {
        collected.push(ev);
        if (ev.type === "result") break;
      }
    })();

    await client.send("hi");
    emitLines(
      child.stdout,
      JSON.stringify({ type: "system", subtype: "init", session_id: "sid-1" }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "hello back" }] } }),
      JSON.stringify({ type: "result", subtype: "success", stop_reason: "end_turn" }),
    );

    await drain;
    expect(collected.map((e) => e.type)).toEqual(["system", "assistant", "result"]);
    const sysEv = collected[0] as unknown as { subtype: string; session_id: string };
    expect(sysEv.subtype).toBe("init");
    expect(sysEv.session_id).toBe("sid-1");
  });

  test("tst_agent_unit_stream_client_003_send_awaits_drain_on_backpressure", async () => {
    // INV-STREAM-12-adjacent: backpressure. When stdin.write returns
    // false (kernel buffer full) the send() promise must not resolve
    // until 'drain' is emitted on stdin.
    const child = makeFakeChild();
    child.stdin.writeReturn = false;
    const client = createClaudeStreamClient(child);

    const p = client.send("payload");
    // The send promise has not resolved yet.
    let settled = false;
    void p.then(() => {
      settled = true;
    });
    await new Promise((r) => setTimeout(r, 5));
    expect(settled).toBe(false);

    // Emit drain — now send() should resolve.
    child.stdin.emit("drain");
    await p;
    expect(settled).toBe(true);
  });

  test("tst_agent_unit_stream_client_004_crash_yields_error_event", async () => {
    // INV-STREAM-9 (partial): if the child exits with non-zero code
    // before a result event the events stream emits an `error` event
    // and terminates.
    const child = makeFakeChild();
    const client = createClaudeStreamClient(child);

    const collected: RawClaudeEvent[] = [];
    const drain = (async () => {
      for await (const ev of client.events()) {
        collected.push(ev);
      }
    })();

    // Emit an "exit" event with non-zero code mid-conversation.
    (child as unknown as EventEmitter).emit("exit", 137, null);

    await drain;
    expect(collected.length).toBe(1);
    expect(collected[0].type).toBe("error");
    expect(String(collected[0].message ?? "")).toContain("137");
  });

  test("tst_agent_unit_stream_client_005_close_ends_stdin_idempotently", async () => {
    const child = makeFakeChild();
    const client = createClaudeStreamClient(child);
    await client.close();
    expect(child.stdin.endCalled).toBe(true);
    // Second close must not throw — INV-STREAM-12 expects us to never
    // write to a closed stdin even when caller is buggy.
    await client.close();
  });
});
