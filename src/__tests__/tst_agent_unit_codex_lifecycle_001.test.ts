import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import { purgePreviousEngineSession } from "../agent/purge";
import {
  createCodexAppServerRegistry,
} from "../agent/codex/registry";
import type {
  CodexAppServerClient,
  CodexAppServerRegistry,
  JsonRpcNotification,
} from "../agent/codex/types";

const SID = "22222222-3333-4444-5555-666666666666";

// Hermetic: point CODEX_HOME at a throwaway dir so the cross-engine
// purge's real codex sqlite/rollout cleanup never touches the
// operator's ~/.codex (would hit SQLITE_READONLY under a read-only
// sandbox, and is unhygienic regardless).
const savedCodexHome = process.env.CODEX_HOME;
beforeAll(async () => {
  process.env.CODEX_HOME = await mkdtemp(join(tmpdir(), "magnis-codex-home-"));
});
afterAll(() => {
  if (savedCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = savedCodexHome;
});

describe("codex lifecycle: cross-engine purge + crash recovery (Stage 5, INV-CODEX-AS-7/9)", () => {
  test("tst_agent_unit_codex_lifecycle_001_cross_engine_purge_drops_codex_thread", async () => {
    const dropped: string[] = [];
    const reg: CodexAppServerRegistry = {
      async ensureThread() {
        throw new Error("not used");
      },
      dropThread(sid) {
        dropped.push(sid);
      },
      markProcessDead() {},
      async shutdown() {},
    };

    // previousEngine === "codex" + a registry → drop the in-memory
    // thread in addition to the on-disk purge.
    await purgePreviousEngineSession("codex", SID, { codexRegistry: reg });
    expect(dropped).toContain(SID);
  });

  test("tst_agent_unit_codex_lifecycle_002_claude_previous_does_not_touch_codex_registry", async () => {
    const dropped: string[] = [];
    const reg: CodexAppServerRegistry = {
      async ensureThread() {
        throw new Error("not used");
      },
      dropThread(sid) {
        dropped.push(sid);
      },
      markProcessDead() {},
      async shutdown() {},
    };
    await purgePreviousEngineSession("claude", SID, { codexRegistry: reg });
    expect(dropped).toEqual([]);
  });

  test("tst_agent_unit_codex_lifecycle_003_crash_then_resume_on_next_ensure", async () => {
    // INV-CODEX-AS-9 end-to-end at the registry level: after the
    // process dies (markProcessDead), the next ensureThread spawns a
    // fresh client, re-initializes, and thread/resume's the cached id.
    const log = { init: 0, start: 0, resume: 0 };
    let spawnCount = 0;

    function makeClient(): CodexAppServerClient {
      return {
        request<T = unknown>(method: string): Promise<T> {
          if (method === "initialize") log.init += 1;
          if (method === "thread/start") {
            log.start += 1;
            return Promise.resolve({ thread: { id: "thread-X" } } as T);
          }
          if (method === "thread/resume") log.resume += 1;
          return Promise.resolve({} as T);
        },
        notifications(): AsyncIterable<JsonRpcNotification> {
          return { [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }) };
        },
        onClose() {},
    onServerRequest() {},
    respond() {},
    async close() {},
      };
    }

    const reg = createCodexAppServerRegistry({
      spawnClient: () => {
        spawnCount += 1;
        return makeClient();
      },
    });

    const a1 = await reg.ensureThread(SID);
    expect(a1.threadId).toBe("thread-X");
    expect(spawnCount).toBe(1);
    expect(log.start).toBe(1);

    reg.markProcessDead();

    const a2 = await reg.ensureThread(SID);
    expect(spawnCount).toBe(2);
    expect(log.init).toBe(2);
    expect(log.resume).toBe(1);
    expect(log.start).toBe(1); // not started again
    expect(a2.threadId).toBe("thread-X");
  });
});
