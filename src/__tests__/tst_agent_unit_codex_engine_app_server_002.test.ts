/**
 * Round-1 review fixes: cover INV-CODEX-AS-10 (resume vs replay turn
 * input), INV-CODEX-AS-14 (CODEX_ENGINE_MODE env gate), and
 * engine-level concurrency (two sessions over one shared client must
 * not steal each other's turn/completed).
 */

import { afterEach, describe, expect, test } from "bun:test";

import { CodexEngine, resolveCodexMode } from "../agent/codex/codex";
import type {
  CodexAppServerClient,
  CodexAppServerRegistry,
  EnsureThreadResult,
  JsonRpcNotification,
} from "../agent/codex/types";
import type { EngineRequest, StreamEvent } from "../agent/types";

// ── shared scripted client (broadcast, like the real one) ────────────

interface SharedClient extends CodexAppServerClient {
  pushNotif: (...n: JsonRpcNotification[]) => void;
  turnStarts: () => Array<{ threadId: string; input: { text: string }[] }>;
  /** Resolves once `count` consumers are parked on next(). */
  whenWaiting: (count: number) => Promise<void>;
}

function makeSharedClient(): SharedClient {
  interface Consumer {
    q: JsonRpcNotification[];
    w: ((r: IteratorResult<JsonRpcNotification>) => void) | null;
  }
  const consumers = new Set<Consumer>();
  const turnStarts: Array<{ threadId: string; input: { text: string }[] }> = [];
  const waitWaiters: Array<{ count: number; resolve: () => void }> = [];

  function parkedCount(): number {
    let n = 0;
    for (const c of consumers) if (c.w) n += 1;
    return n;
  }
  function notifyWaiters() {
    const parked = parkedCount();
    for (let i = waitWaiters.length - 1; i >= 0; i--) {
      if (parked >= waitWaiters[i].count) {
        waitWaiters[i].resolve();
        waitWaiters.splice(i, 1);
      }
    }
  }

  function broadcast(n: JsonRpcNotification) {
    for (const c of consumers) {
      if (c.w) {
        const w = c.w;
        c.w = null;
        w({ value: n, done: false });
      } else c.q.push(n);
    }
  }

  return {
    pushNotif(...n) {
      for (const x of n) broadcast(x);
    },
    turnStarts: () => turnStarts,
    whenWaiting(count: number) {
      return new Promise<void>((resolve) => {
        if (parkedCount() >= count) resolve();
        else waitWaiters.push({ count, resolve });
      });
    },
    request<T = unknown>(method: string, params?: unknown): Promise<T> {
      if (method === "turn/start") {
        turnStarts.push(params as { threadId: string; input: { text: string }[] });
      }
      return Promise.resolve({} as T);
    },
    notifications() {
      const c: Consumer = { q: [], w: null };
      consumers.add(c);
      return {
        [Symbol.asyncIterator]() {
          return {
            next() {
              if (c.q.length > 0) {
                return Promise.resolve({ value: c.q.shift() as JsonRpcNotification, done: false });
              }
              return new Promise<IteratorResult<JsonRpcNotification>>((resolve) => {
                c.w = resolve;
                queueMicrotask(notifyWaiters);
              });
            },
            return() {
              consumers.delete(c);
              return Promise.resolve({ value: undefined as never, done: false });
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
}

function regReturning(
  client: CodexAppServerClient,
  threadOf: (sid: string) => string,
): CodexAppServerRegistry {
  return {
    async ensureThread(sessionId: string): Promise<EnsureThreadResult> {
      return { client, threadId: threadOf(sessionId) };
    },
    dropThread() {},
    markProcessDead() {},
    async shutdown() {},
  };
}

function req(over: Partial<EngineRequest> = {}): EngineRequest {
  return {
    messages: [{ role: "user", content: "hi" }],
    systemPrompt: "system",
    maxSteps: 10,
    engineSessionId: "11111111-2222-3333-4444-555555555555",
    ...over,
  };
}

const originalMode = process.env.CODEX_ENGINE_MODE;
const originalKey = process.env.OPENAI_API_KEY;
afterEach(() => {
  if (originalMode === undefined) delete process.env.CODEX_ENGINE_MODE;
  else process.env.CODEX_ENGINE_MODE = originalMode;
  if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = originalKey;
});

// ── INV-CODEX-AS-14: env gate ────────────────────────────────────────

describe("resolveCodexMode env gate (INV-7)", () => {
  // INV-7: app-server is the durable default; only an explicit
  // CODEX_ENGINE_MODE=legacy opts back into per-turn `codex exec`.
  test("tst_agent_unit_codex_mode_001_unset_env_is_app_server", () => {
    delete process.env.CODEX_ENGINE_MODE;
    expect(resolveCodexMode({})).toBe("app-server");
  });
  test("tst_agent_unit_codex_mode_002_app_server_env_selected", () => {
    process.env.CODEX_ENGINE_MODE = "app-server";
    expect(resolveCodexMode({})).toBe("app-server");
  });
  test("tst_agent_unit_codex_mode_003_only_legacy_value_opts_out", () => {
    process.env.CODEX_ENGINE_MODE = "weird";
    expect(resolveCodexMode({})).toBe("app-server");
    process.env.CODEX_ENGINE_MODE = "legacy";
    expect(resolveCodexMode({})).toBe("legacy");
  });
  test("tst_agent_unit_codex_mode_004_explicit_dep_overrides_env", () => {
    process.env.CODEX_ENGINE_MODE = "app-server";
    expect(resolveCodexMode({ mode: "legacy" })).toBe("legacy");
  });
});

// ── INV-CODEX-AS-14: app-server + null sessionId → legacy fallthrough ─

describe("CodexEngine routing (INV-CODEX-AS-14)", () => {
  test("tst_agent_unit_codex_route_001_app_server_without_session_does_not_touch_registry", async () => {
    delete process.env.OPENAI_API_KEY;
    let ensureCalled = false;
    const reg: CodexAppServerRegistry = {
      async ensureThread() {
        ensureCalled = true;
        throw new Error("registry must not be used without a sessionId");
      },
      dropThread() {},
      markProcessDead() {},
      async shutdown() {},
    };
    // mode app-server but NO engineSessionId → must fall through to
    // legacy, detected by the registry never being touched. Point
    // CODEX_BIN at a missing binary so the legacy path fails fast
    // (spawn ENOENT) instead of running a real codex.
    const savedBin = process.env.CODEX_BIN;
    process.env.CODEX_BIN = "/nonexistent-codex-bin-xyz";
    try {
      const engine = new CodexEngine({ mode: "app-server", registry: reg });
      const out: StreamEvent[] = [];
      try {
        for await (const ev of engine.stream(req({ engineSessionId: null }))) {
          out.push(ev);
        }
      } catch {
        // legacy path may throw on the bad spawn — that's fine.
      }
      expect(ensureCalled).toBe(false);
    } finally {
      if (savedBin === undefined) delete process.env.CODEX_BIN;
      else process.env.CODEX_BIN = savedBin;
    }
  });
});

// ── INV-CODEX-AS-10: resume vs replay turn input ─────────────────────

describe("CodexEngine turn input by cacheMode (INV-CODEX-AS-10)", () => {
  async function drainText(stream: AsyncIterable<StreamEvent>): Promise<void> {
    for await (const _ of stream) {
      /* drain */
    }
  }

  test("tst_agent_unit_codex_input_001_resume_sends_only_last_user_message", async () => {
    delete process.env.OPENAI_API_KEY;
    const client = makeSharedClient();
    const reg = regReturning(client, () => "thread-A");
    const engine = new CodexEngine({ mode: "app-server", registry: reg });

    const drain = drainText(
      engine.stream(
        req({
          cacheMode: "resume",
          messages: [
            { role: "user", content: "FIRST" },
            { role: "assistant", content: "ok" },
            { role: "user", content: "SECOND" },
          ],
        }),
      ),
    );
    await client.whenWaiting(1);
    client.pushNotif({ method: "turn/completed", params: { threadId: "thread-A", turn: {} } });
    await drain;

    const text = client.turnStarts()[0].input[0].text;
    // resume → only the latest user message in the turn input.
    expect(text).toContain("SECOND");
    expect(text).not.toContain("FIRST");
  });

  test("tst_agent_unit_codex_input_002_replay_sends_full_transcript", async () => {
    delete process.env.OPENAI_API_KEY;
    const client = makeSharedClient();
    const reg = regReturning(client, () => "thread-A");
    const engine = new CodexEngine({ mode: "app-server", registry: reg });

    const drain = drainText(
      engine.stream(
        req({
          cacheMode: "replay",
          messages: [
            { role: "user", content: "FIRST" },
            { role: "assistant", content: "ok" },
            { role: "user", content: "SECOND" },
          ],
        }),
      ),
    );
    await client.whenWaiting(1);
    client.pushNotif({ method: "turn/completed", params: { threadId: "thread-A", turn: {} } });
    await drain;

    const text = client.turnStarts()[0].input[0].text;
    // replay → full transcript present.
    expect(text).toContain("FIRST");
    expect(text).toContain("SECOND");
  });
});

// ── Engine-level concurrency ─────────────────────────────────────────

describe("CodexEngine concurrency (INV-CODEX-AS-2)", () => {
  test("tst_agent_unit_codex_concurrency_001_two_sessions_do_not_steal_each_others_completion", async () => {
    delete process.env.OPENAI_API_KEY;
    const client = makeSharedClient();
    const reg = regReturning(client, (sid) => (sid === "SID-A" ? "thread-A" : "thread-B"));
    const engine = new CodexEngine({ mode: "app-server", registry: reg });

    const outA: StreamEvent[] = [];
    const outB: StreamEvent[] = [];
    const drainA = (async () => {
      for await (const ev of engine.stream(req({ engineSessionId: "SID-A" }))) outA.push(ev);
    })();
    const drainB = (async () => {
      for await (const ev of engine.stream(req({ engineSessionId: "SID-B" }))) outB.push(ev);
    })();
    await client.whenWaiting(2);

    // Interleave both threads' events on the shared client.
    client.pushNotif(
      { method: "item/agentMessage/delta", params: { threadId: "thread-A", turnId: "u", itemId: "i", delta: "AAA" } },
      { method: "item/agentMessage/delta", params: { threadId: "thread-B", turnId: "u", itemId: "i", delta: "BBB" } },
      { method: "turn/completed", params: { threadId: "thread-A", turn: {} } },
      { method: "turn/completed", params: { threadId: "thread-B", turn: {} } },
    );
    await Promise.all([drainA, drainB]);

    const doneA = outA.find((e) => e.type === "done") as { full_content: string };
    const doneB = outB.find((e) => e.type === "done") as { full_content: string };
    expect(doneA.full_content).toBe("AAA");
    expect(doneB.full_content).toBe("BBB");
  });
});
