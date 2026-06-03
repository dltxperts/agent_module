import { afterEach, describe, expect, test } from "bun:test";

import { CodexEngine } from "../agent/codex/codex";
import type { CodexAppServerClient } from "../agent/codex/types";
import type {
  CodexAppServerRegistry,
  EnsureThreadResult,
  JsonRpcNotification,
} from "../agent/codex/types";
import type { EngineRequest, StreamEvent } from "../agent/types";

const SID = "11111111-2222-3333-4444-555555555555";
const THREAD = "thread-A";

interface ScriptableClient extends CodexAppServerClient {
  pushNotif: (...n: JsonRpcNotification[]) => void;
  turnStartParams: () => unknown[];
  whenWaiting: () => Promise<void>;
}

function makeScriptedClient(): ScriptableClient {
  const queue: JsonRpcNotification[] = [];
  let waiter: ((r: IteratorResult<JsonRpcNotification>) => void) | null = null;
  const whenWaiters: Array<() => void> = [];
  let done = false;
  const turnStarts: unknown[] = [];

  function push(n: JsonRpcNotification) {
    if (waiter) {
      const w = waiter;
      waiter = null;
      w({ value: n, done: false });
    } else {
      queue.push(n);
    }
  }
  const iterator: AsyncIterator<JsonRpcNotification> = {
    next() {
      if (queue.length > 0) {
        return Promise.resolve({ value: queue.shift() as JsonRpcNotification, done: false });
      }
      if (done) return Promise.resolve({ value: undefined as never, done: true });
      return new Promise((resolve) => {
        waiter = resolve;
        while (whenWaiters.length) {
          const w = whenWaiters.shift();
          if (w) w();
        }
      });
    },
    return() {
      return Promise.resolve({ value: undefined as never, done: false });
    },
  };

  return {
    pushNotif(...n) {
      for (const x of n) push(x);
    },
    turnStartParams: () => turnStarts,
    whenWaiting() {
      return new Promise<void>((resolve) => {
        const check = () => (waiter ? resolve() : whenWaiters.push(resolve));
        queueMicrotask(check);
      });
    },
    request<T = unknown>(method: string, params?: unknown): Promise<T> {
      if (method === "turn/start") turnStarts.push(params);
      return Promise.resolve({} as T);
    },
    notifications() {
      return { [Symbol.asyncIterator]: () => iterator };
    },
    onClose() {},
    onServerRequest() {},
    respond() {},
    async close() {
      done = true;
    },
  };
}

function makeFakeRegistry(client: CodexAppServerClient) {
  const ensureCalls: string[] = [];
  const startParams: Array<Record<string, unknown> | undefined> = [];
  const dropCalls: string[] = [];
  let deadCount = 0;
  const reg: CodexAppServerRegistry = {
    async ensureThread(
      sessionId: string,
      params?: Record<string, unknown>,
    ): Promise<EnsureThreadResult> {
      ensureCalls.push(sessionId);
      startParams.push(params);
      return { client, threadId: THREAD };
    },
    dropThread(sessionId: string) {
      dropCalls.push(sessionId);
    },
    markProcessDead() {
      deadCount += 1;
    },
    async shutdown() {},
  };
  return { reg, ensureCalls, startParams, dropCalls, deadCount: () => deadCount };
}

function makeRequest(over: Partial<EngineRequest> = {}): EngineRequest {
  return {
    messages: [{ role: "user", content: "hi" }],
    systemPrompt: "system",
    maxSteps: 10,
    engineSessionId: SID,
    ...over,
  };
}

const originalOpenAiKey = process.env.OPENAI_API_KEY;
afterEach(() => {
  if (originalOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = originalOpenAiKey;
});

describe("CodexEngine app-server path (Stage 4, INV-CODEX-AS-1/3/4/12/14)", () => {
  test("tst_agent_unit_codex_engine_app_server_030_thread_start_carries_cwd_model_sandbox", async () => {
    // Stage 1 INV-1/2/4: the session cwd, model and permission_mode
    // reach thread/start as cwd + model + sandbox.
    delete process.env.OPENAI_API_KEY;
    const client = makeScriptedClient();
    const { reg, startParams } = makeFakeRegistry(client);
    const engine = new CodexEngine({ mode: "app-server", registry: reg });

    const drain = (async () => {
      for await (const _ of engine.stream(
        makeRequest({ cwd: "/work/dir", model: "gpt-5", permissionMode: "full" }),
      )) {
        /* drain */
      }
    })();
    await client.whenWaiting();
    client.pushNotif({ method: "turn/completed", params: { threadId: THREAD, turn: {} } });
    await drain;

    const p = startParams[0] as { cwd?: string; model?: string; sandbox?: string };
    expect(p.cwd).toBe("/work/dir");
    expect(p.model).toBe("gpt-5");
    expect(p.sandbox).toBe("danger-full-access");
  });

  test("tst_agent_unit_codex_engine_app_server_031_restricted_thread_start_read_only", async () => {
    delete process.env.OPENAI_API_KEY;
    const client = makeScriptedClient();
    const { reg, startParams } = makeFakeRegistry(client);
    const engine = new CodexEngine({ mode: "app-server", registry: reg });

    const drain = (async () => {
      for await (const _ of engine.stream(
        makeRequest({ permissionMode: "restricted" }),
      )) {
        /* drain */
      }
    })();
    await client.whenWaiting();
    client.pushNotif({ method: "turn/completed", params: { threadId: THREAD, turn: {} } });
    await drain;

    const p = startParams[0] as { sandbox?: string };
    expect(p.sandbox).toBe("read-only");
  });

  test("tst_agent_unit_codex_engine_app_server_001_turn_drains_delta_then_done", async () => {
    delete process.env.OPENAI_API_KEY;
    const client = makeScriptedClient();
    const { reg, ensureCalls } = makeFakeRegistry(client);
    const engine = new CodexEngine({ mode: "app-server", registry: reg });

    const out: StreamEvent[] = [];
    const drain = (async () => {
      for await (const ev of engine.stream(makeRequest())) out.push(ev);
    })();
    await client.whenWaiting();
    client.pushNotif(
      { method: "item/agentMessage/delta", params: { threadId: THREAD, turnId: "u1", itemId: "i1", delta: "hello" } },
      { method: "turn/completed", params: { threadId: THREAD, turn: {} } },
    );
    await drain;

    expect(ensureCalls).toEqual([SID]);
    expect(out.map((e) => e.type)).toContain("delta");
    expect(out.map((e) => e.type)).toContain("done");
    const delta = out.find((e) => e.type === "delta") as { content: string };
    expect(delta.content).toBe("hello");
    const done = out.find((e) => e.type === "done") as { full_content: string };
    expect(done.full_content).toBe("hello");

    // INV-CODEX-AS-12: turn/start used the documented input shape.
    const ts = client.turnStartParams()[0] as { threadId: string; input: unknown[]; approvalPolicy?: string };
    expect(ts.threadId).toBe(THREAD);
    expect(ts.input).toEqual([{ type: "text", text: expect.stringContaining("hi"), text_elements: [] }]);
    // approval gate decision: never (we don't answer approval requests).
    expect(ts.approvalPolicy).toBe("never");
  });

  test("tst_agent_unit_codex_engine_app_server_002_only_our_thread_notifications_count", async () => {
    delete process.env.OPENAI_API_KEY;
    const client = makeScriptedClient();
    const { reg } = makeFakeRegistry(client);
    const engine = new CodexEngine({ mode: "app-server", registry: reg });

    const out: StreamEvent[] = [];
    const drain = (async () => {
      for await (const ev of engine.stream(makeRequest())) out.push(ev);
    })();
    await client.whenWaiting();
    client.pushNotif(
      // Another thread's noise — must be ignored.
      { method: "item/agentMessage/delta", params: { threadId: "other", turnId: "x", itemId: "y", delta: "NOISE" } },
      { method: "item/agentMessage/delta", params: { threadId: THREAD, turnId: "u1", itemId: "i1", delta: "ours" } },
      { method: "turn/completed", params: { threadId: "other", turn: {} } }, // not our turn end
      { method: "turn/completed", params: { threadId: THREAD, turn: {} } },
    );
    await drain;

    const done = out.find((e) => e.type === "done") as { full_content: string };
    expect(done.full_content).toBe("ours");
  });

  test("tst_agent_unit_codex_engine_app_server_003_openai_key_emits_warning", async () => {
    process.env.OPENAI_API_KEY = "sk-openai";
    const client = makeScriptedClient();
    const { reg } = makeFakeRegistry(client);
    const engine = new CodexEngine({ mode: "app-server", registry: reg });

    const out: StreamEvent[] = [];
    const drain = (async () => {
      for await (const ev of engine.stream(makeRequest())) out.push(ev);
    })();
    await client.whenWaiting();
    client.pushNotif({ method: "turn/completed", params: { threadId: THREAD, turn: {} } });
    await drain;

    const warn = out.find((e) => e.type === "warning") as { code: string } | undefined;
    expect(warn?.code).toBe("codex_api_key_set");
  });

  test("tst_agent_unit_codex_engine_app_server_004_replay_drops_thread", async () => {
    delete process.env.OPENAI_API_KEY;
    const client = makeScriptedClient();
    const { reg, dropCalls } = makeFakeRegistry(client);
    const engine = new CodexEngine({ mode: "app-server", registry: reg });

    const drain = (async () => {
      for await (const _ of engine.stream(
        makeRequest({ cacheMode: "replay", previousEngine: "claude" }),
      )) {
        /* drain */
      }
    })();
    await client.whenWaiting();
    client.pushNotif({ method: "turn/completed", params: { threadId: THREAD, turn: {} } });
    await drain;

    expect(dropCalls).toContain(SID);
  });
});
