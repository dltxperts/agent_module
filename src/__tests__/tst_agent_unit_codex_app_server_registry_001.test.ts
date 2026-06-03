import { describe, expect, test } from "bun:test";

import {
  createCodexAppServerRegistry,
} from "../agent/codex/registry";
import type { CodexAppServerClient, JsonRpcNotification } from "../agent/codex/types";

const SID_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const SID_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

interface FakeClientLog {
  initializeCount: number;
  threadStartCount: number;
  threadResumeCount: number;
  closed: boolean;
}

function makeFakeClient(log: FakeClientLog, threadIdSeq: string[]): CodexAppServerClient {
  let seq = 0;
  return {
    request<T = unknown>(method: string): Promise<T> {
      if (method === "initialize") {
        log.initializeCount += 1;
        return Promise.resolve({} as T);
      }
      if (method === "thread/start") {
        log.threadStartCount += 1;
        const id = threadIdSeq[seq++] ?? `thread-${seq}`;
        return Promise.resolve({ thread: { id } } as T);
      }
      if (method === "thread/resume") {
        log.threadResumeCount += 1;
        return Promise.resolve({} as T);
      }
      return Promise.resolve({} as T);
    },
    notifications(): AsyncIterable<JsonRpcNotification> {
      return { [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }) };
    },
    onClose() {},
    onServerRequest() {},
    respond() {},
    async close() {
      log.closed = true;
    },
  };
}

describe("CodexAppServerRegistry (Stage 2, INV-CODEX-AS-1/2/9)", () => {
  test("tst_agent_unit_codex_registry_001_spawns_once_initializes_once_thread_start_per_session", async () => {
    const log: FakeClientLog = {
      initializeCount: 0,
      threadStartCount: 0,
      threadResumeCount: 0,
      closed: false,
    };
    let spawnClientCount = 0;
    const reg = createCodexAppServerRegistry({
      spawnClient: () => {
        spawnClientCount += 1;
        return makeFakeClient(log, ["thread-A", "thread-B"]);
      },
    });

    const a1 = await reg.ensureThread(SID_A);
    const a2 = await reg.ensureThread(SID_A);

    // INV-CODEX-AS-1: one process, one thread per session.
    expect(spawnClientCount).toBe(1);
    expect(log.initializeCount).toBe(1);
    expect(log.threadStartCount).toBe(1);
    expect(a1.threadId).toBe("thread-A");
    expect(a2.threadId).toBe("thread-A");
    expect(a1.client).toBe(a2.client);
  });

  test("tst_agent_unit_codex_registry_002_distinct_sessions_share_process_distinct_threads", async () => {
    const log: FakeClientLog = {
      initializeCount: 0,
      threadStartCount: 0,
      threadResumeCount: 0,
      closed: false,
    };
    let spawnClientCount = 0;
    const reg = createCodexAppServerRegistry({
      spawnClient: () => {
        spawnClientCount += 1;
        return makeFakeClient(log, ["thread-A", "thread-B"]);
      },
    });

    const a = await reg.ensureThread(SID_A);
    const b = await reg.ensureThread(SID_B);

    // INV-CODEX-AS-2: one process, N threads.
    expect(spawnClientCount).toBe(1);
    expect(log.threadStartCount).toBe(2);
    expect(a.threadId).toBe("thread-A");
    expect(b.threadId).toBe("thread-B");
    expect(a.client).toBe(b.client);
  });

  test("tst_agent_unit_codex_registry_003_drop_thread_mints_fresh_on_next_ensure", async () => {
    const log: FakeClientLog = {
      initializeCount: 0,
      threadStartCount: 0,
      threadResumeCount: 0,
      closed: false,
    };
    const reg = createCodexAppServerRegistry({
      spawnClient: () => makeFakeClient(log, ["thread-A", "thread-A2"]),
    });

    const a1 = await reg.ensureThread(SID_A);
    expect(a1.threadId).toBe("thread-A");

    // INV-CODEX-AS-7: cross-engine switch drops the thread.
    reg.dropThread(SID_A);

    const a2 = await reg.ensureThread(SID_A);
    expect(log.threadStartCount).toBe(2);
    expect(a2.threadId).toBe("thread-A2");
  });

  test("tst_agent_unit_codex_registry_004_crash_respawns_and_resumes_known_session", async () => {
    const log: FakeClientLog = {
      initializeCount: 0,
      threadStartCount: 0,
      threadResumeCount: 0,
      closed: false,
    };
    let spawnClientCount = 0;
    const reg = createCodexAppServerRegistry({
      spawnClient: () => {
        spawnClientCount += 1;
        return makeFakeClient(log, ["thread-A"]);
      },
    });

    const a1 = await reg.ensureThread(SID_A);
    expect(a1.threadId).toBe("thread-A");
    expect(spawnClientCount).toBe(1);

    // Process died.
    reg.markProcessDead();

    // INV-CODEX-AS-9: next ensure respawns + initializes again, and
    // RESUMES the cached threadId (not a fresh thread/start).
    const a2 = await reg.ensureThread(SID_A);
    expect(spawnClientCount).toBe(2);
    expect(log.initializeCount).toBe(2);
    expect(log.threadResumeCount).toBe(1);
    expect(log.threadStartCount).toBe(1); // still just the original start
    expect(a2.threadId).toBe("thread-A");
  });
});
