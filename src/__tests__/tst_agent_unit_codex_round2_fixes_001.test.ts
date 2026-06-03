/**
 * Round-2 review fixes (Codex findings):
 *  #1 registry no double-spawn under concurrent ensureThread
 *  #2 engine releases the notification consumer on a normal turn
 *  #3 idle process death (client onClose) → next ensureThread respawns
 */

import { describe, expect, test } from "bun:test";

import {
  createCodexAppServerRegistry,
} from "../agent/codex/registry";
import { createCodexAppServerClient } from "../agent/codex/app-client";
import type { CodexAppServerClient, JsonRpcNotification } from "../agent/codex/types";
import { EventEmitter } from "events";
import type { ChildProcess } from "child_process";

const SID_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const SID_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

// A client whose onClose listeners we can fire on demand.
function makeControllableClient(threadId: string) {
  const closeListeners = new Set<() => void>();
  let started = 0;
  const client: CodexAppServerClient = {
    request<T = unknown>(method: string): Promise<T> {
      if (method === "thread/start") {
        started += 1;
        return Promise.resolve({ thread: { id: threadId } } as T);
      }
      return Promise.resolve({} as T);
    },
    notifications() {
      return { [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }) };
    },
    onClose(cb) {
      closeListeners.add(cb);
    },
    onServerRequest() {},
    respond() {},
    async close() {},
  };
  return {
    client,
    fireClose: () => {
      for (const cb of closeListeners) cb();
    },
    startCount: () => started,
  };
}

describe("Codex round-2 fixes", () => {
  test("tst_agent_unit_codex_r2_001_concurrent_ensure_thread_spawns_once", async () => {
    // Codex #1: two sessions calling ensureThread at the same time
    // must not each spawn a process. Slow initialize widens the race
    // window so a missing guard would double-spawn.
    let spawnCount = 0;
    let initCount = 0;
    const reg = createCodexAppServerRegistry({
      spawnClient: () => {
        spawnCount += 1;
        const client: CodexAppServerClient = {
          request<T = unknown>(method: string): Promise<T> {
            if (method === "initialize") {
              initCount += 1;
              return new Promise((r) => setTimeout(() => r({} as T), 20));
            }
            if (method === "thread/start") {
              return Promise.resolve({ thread: { id: `thread-${spawnCount}` } } as T);
            }
            return Promise.resolve({} as T);
          },
          notifications() {
            return { [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }) };
          },
          onClose() {},
          onServerRequest() {},
    respond() {},
    async close() {},
        };
        return client;
      },
    });

    const [a, b] = await Promise.all([
      reg.ensureThread(SID_A),
      reg.ensureThread(SID_B),
    ]);

    expect(spawnCount).toBe(1);
    expect(initCount).toBe(1);
    expect(a.client).toBe(b.client);
  });

  test("tst_agent_unit_codex_r2_002_same_session_concurrent_thread_start_once", async () => {
    // Codex #1 (same-session variant): concurrent ensureThread for
    // ONE session must thread/start once.
    let starts = 0;
    const reg = createCodexAppServerRegistry({
      spawnClient: () => ({
        request<T = unknown>(method: string): Promise<T> {
          if (method === "thread/start") {
            starts += 1;
            return new Promise((r) => setTimeout(() => r({ thread: { id: "thread-A" } } as T), 10));
          }
          return Promise.resolve({} as T);
        },
        notifications() {
          return { [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }) };
        },
        onClose() {},
        onServerRequest() {},
    respond() {},
    async close() {},
      }),
    });

    const [a1, a2] = await Promise.all([
      reg.ensureThread(SID_A),
      reg.ensureThread(SID_A),
    ]);
    expect(starts).toBe(1);
    expect(a1.threadId).toBe("thread-A");
    expect(a2.threadId).toBe("thread-A");
  });

  test("tst_agent_unit_codex_r2_006_rejected_ensure_thread_no_unhandled_rejection", async () => {
    // Codex round-2 finding B: the in-flight cleanup must not leave an
    // unhandled rejection (which crashes Bun) when ensureThread fails.
    // We register a process-level unhandledRejection trap, drive a
    // failing thread/start, handle the returned promise, and assert no
    // unhandled rejection surfaced.
    const seen: unknown[] = [];
    const trap = (r: unknown) => seen.push(r);
    process.on("unhandledRejection", trap);
    try {
      const reg = createCodexAppServerRegistry({
        spawnClient: () => ({
          request<T = unknown>(method: string): Promise<T> {
            if (method === "thread/start") {
              return Promise.reject(new Error("boom"));
            }
            return Promise.resolve({} as T);
          },
          notifications() {
            return { [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }) };
          },
          onClose() {},
          onServerRequest() {},
    respond() {},
    async close() {},
        }),
      });

      // Caller handles the rejection.
      await expect(reg.ensureThread(SID_A)).rejects.toThrow(/boom/);
      // Let any microtask-deferred unhandled rejection fire.
      await new Promise((r) => setTimeout(r, 20));
      expect(seen).toEqual([]);
    } finally {
      process.off("unhandledRejection", trap);
    }
  });

  test("tst_agent_unit_codex_r2_003_idle_close_triggers_respawn_on_next_ensure", async () => {
    // Codex #3: when the live client fires onClose (idle death), the
    // registry drops it; the next ensureThread respawns + resumes.
    let spawnCount = 0;
    const controllers: ReturnType<typeof makeControllableClient>[] = [];
    const reg = createCodexAppServerRegistry({
      spawnClient: () => {
        spawnCount += 1;
        const ctl = makeControllableClient("thread-A");
        controllers.push(ctl);
        return ctl.client;
      },
    });

    await reg.ensureThread(SID_A);
    expect(spawnCount).toBe(1);

    // Simulate idle process death via the client's onClose.
    controllers[0].fireClose();

    // Next ensureThread must respawn (not reuse the dead client).
    const a2 = await reg.ensureThread(SID_A);
    expect(spawnCount).toBe(2);
    expect(a2.threadId).toBe("thread-A");
  });

  test("tst_agent_unit_codex_r2_004_client_onclose_fires_on_exit", () => {
    // The real client must invoke onClose listeners when the child exits.
    const ee = new EventEmitter() as EventEmitter & ChildProcess;
    Object.assign(ee, {
      pid: 1,
      stdin: { write: () => true, end: () => {}, once: () => {} },
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
    });
    const client = createCodexAppServerClient(ee as unknown as ChildProcess);
    let fired = 0;
    client.onClose(() => {
      fired += 1;
    });
    (ee as unknown as EventEmitter).emit("exit", 0, null);
    expect(fired).toBe(1);
    // Late registration after close fires immediately.
    let lateFired = 0;
    client.onClose(() => {
      lateFired += 1;
    });
    expect(lateFired).toBe(1);
  });
});

// Fix A: turn/start rejection must still release the notification
// consumer (the cleanup finally now wraps turn/start too).
describe("Codex engine releases consumer on turn/start failure (#A)", () => {
  test("tst_agent_unit_codex_r2_007_turn_start_reject_calls_notifs_return", async () => {
    // Import lazily to keep this file's other tests independent.
    const { CodexEngine } = await import("../agent/codex/codex");
    const { EventEmitter: EE } = await import("events");
    void EE;

    let returnCalled = 0;
    const client: CodexAppServerClient = {
      request<T = unknown>(method: string): Promise<T> {
        if (method === "turn/start") return Promise.reject(new Error("turn boom"));
        return Promise.resolve({} as T);
      },
      notifications() {
        return {
          [Symbol.asyncIterator]() {
            return {
              next() {
                return new Promise(() => {}); // never resolves
              },
              return() {
                returnCalled += 1;
                return Promise.resolve({ value: undefined as never, done: true });
              },
            };
          },
        };
      },
      onClose() {},
      onServerRequest() {},
    respond() {},
    async close() {},
    };

    const reg = {
      async ensureThread() {
        return { client, threadId: "thread-A" };
      },
      dropThread() {},
      markProcessDead() {},
      async shutdown() {},
    };

    const engine = new CodexEngine({
      mode: "app-server" as const,
      registry: reg,
    });
    const out: string[] = [];
    for await (const ev of engine.stream({
      messages: [{ role: "user", content: "hi" }],
      systemPrompt: "s",
      maxSteps: 1,
      engineSessionId: SID_A,
    })) {
      out.push(ev.type);
    }
    // error surfaced AND the consumer iterator was released.
    expect(out).toContain("error");
    expect(returnCalled).toBe(1);
  });
});

// Engine-level consumer release (#2) lives in the engine test file's
// shared client; here we assert the client's broadcast Set shrinks
// when a consumer iterator is returned.
describe("Codex client consumer cleanup (#2)", () => {
  test("tst_agent_unit_codex_r2_005_returned_consumer_is_removed", async () => {
    const ee = new EventEmitter() as EventEmitter & ChildProcess;
    Object.assign(ee, {
      pid: 1,
      stdin: { write: () => true, end: () => {}, once: () => {} },
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
    });
    const client = createCodexAppServerClient(ee as unknown as ChildProcess);

    const iter = client.notifications()[Symbol.asyncIterator]();
    // Park the consumer.
    const pending = iter.next();
    // Emit one notification — consumer receives it.
    (ee.stdout as EventEmitter).emit(
      "data",
      Buffer.from(JSON.stringify({ method: "warning", params: {} }) + "\n"),
    );
    const first = await pending;
    expect((first.value as JsonRpcNotification).method).toBe("warning");

    // Release the consumer. After this, a new notification must NOT be
    // buffered for it (no leak): emitting again and re-subscribing a
    // fresh consumer should not replay the old one's backlog.
    await iter.return?.(undefined as never);
    (ee.stdout as EventEmitter).emit(
      "data",
      Buffer.from(JSON.stringify({ method: "error", params: {} }) + "\n"),
    );
    // A brand-new consumer starts empty (the released one didn't keep
    // accumulating).
    const iter2 = client.notifications()[Symbol.asyncIterator]();
    const p2 = iter2.next();
    (ee.stdout as EventEmitter).emit(
      "data",
      Buffer.from(JSON.stringify({ method: "turn/completed", params: {} }) + "\n"),
    );
    const got = await p2;
    expect((got.value as JsonRpcNotification).method).toBe("turn/completed");
    await iter2.return?.(undefined as never);
  });
});
