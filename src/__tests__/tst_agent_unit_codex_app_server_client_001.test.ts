import { describe, expect, test } from "bun:test";
import { EventEmitter } from "events";
import type { ChildProcess } from "child_process";

import { createCodexAppServerClient } from "../agent/codex/app-client";
import type { CodexAppServerClient, JsonRpcNotification } from "../agent/codex/types";

// ── ChildProcess test double ─────────────────────────────────────────

interface FakeStdin {
  written: string[];
  writeReturn: boolean;
  write(chunk: string, cb?: (err?: Error | null) => void): boolean;
  end(): void;
  endCalled: boolean;
  once(ev: string, cb: () => void): void;
}

function makeFakeChild() {
  const ee = new EventEmitter() as EventEmitter & ChildProcess;
  const stdinEE = new EventEmitter();
  const stdin: FakeStdin = {
    written: [],
    writeReturn: true,
    write(chunk, cb) {
      stdin.written.push(chunk);
      if (cb) queueMicrotask(() => cb(null));
      return stdin.writeReturn;
    },
    end() {
      stdin.endCalled = true;
    },
    endCalled: false,
    once: (ev, cb) => {
      stdinEE.once(ev, cb);
    },
  };
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  Object.assign(ee, { pid: 71000, stdin, stdout, stderr, kill: () => true });
  return ee as unknown as ChildProcess & {
    stdin: FakeStdin;
    stdout: EventEmitter;
    stderr: EventEmitter;
  };
}

function emitLine(stdout: EventEmitter, obj: unknown) {
  stdout.emit("data", Buffer.from(JSON.stringify(obj) + "\n"));
}

// ── Tests ────────────────────────────────────────────────────────────

describe("CodexAppServerClient (Stage 1, INV-CODEX-AS-4/8)", () => {
  test("tst_agent_unit_codex_app_server_client_001_request_writes_envelope_and_resolves_on_matching_id", async () => {
    const child = makeFakeChild();
    const client = createCodexAppServerClient(child);

    const p = client.request<{ ok: boolean }>("initialize", { foo: 1 });
    // One envelope written.
    expect(child.stdin.written.length).toBe(1);
    const env = JSON.parse(child.stdin.written[0]);
    expect(env.jsonrpc).toBe("2.0");
    expect(env.method).toBe("initialize");
    expect(env.params).toEqual({ foo: 1 });
    expect(typeof env.id).toBe("number");

    // Server replies with matching id.
    emitLine(child.stdout, { jsonrpc: "2.0", id: env.id, result: { ok: true } });
    const result = await p;
    expect(result).toEqual({ ok: true });
  });

  test("tst_agent_unit_codex_app_server_client_002_error_response_rejects", async () => {
    const child = makeFakeChild();
    const client = createCodexAppServerClient(child);
    const p = client.request("turn/start", {});
    const env = JSON.parse(child.stdin.written[0]);
    emitLine(child.stdout, {
      jsonrpc: "2.0",
      id: env.id,
      error: { code: -32000, message: "bad turn" },
    });
    await expect(p).rejects.toThrow(/bad turn/);
  });

  test("tst_agent_unit_codex_app_server_client_003_distinct_ids_correlate_independently", async () => {
    const child = makeFakeChild();
    const client = createCodexAppServerClient(child);
    const p1 = client.request<number>("a", {});
    const p2 = client.request<number>("b", {});
    const id1 = JSON.parse(child.stdin.written[0]).id;
    const id2 = JSON.parse(child.stdin.written[1]).id;
    expect(id1).not.toBe(id2);
    // Reply out of order.
    emitLine(child.stdout, { jsonrpc: "2.0", id: id2, result: 2 });
    emitLine(child.stdout, { jsonrpc: "2.0", id: id1, result: 1 });
    expect(await p1).toBe(1);
    expect(await p2).toBe(2);
  });

  test("tst_agent_unit_codex_app_server_client_004_notifications_stream_yields_method_messages", async () => {
    const child = makeFakeChild();
    const client = createCodexAppServerClient(child);

    const got: JsonRpcNotification[] = [];
    const drain = (async () => {
      for await (const n of client.notifications()) {
        got.push(n);
        if (n.method === "turn/completed") break;
      }
    })();

    emitLine(child.stdout, {
      method: "item/agentMessage/delta",
      params: { threadId: "t1", turnId: "u1", itemId: "i1", delta: "hi" },
    });
    emitLine(child.stdout, { method: "turn/completed", params: { threadId: "t1", turn: {} } });

    await drain;
    expect(got.map((n) => n.method)).toEqual([
      "item/agentMessage/delta",
      "turn/completed",
    ]);
  });

  test("tst_agent_unit_codex_app_server_client_005_crash_rejects_pending_and_ends_notifications", async () => {
    const child = makeFakeChild();
    const client = createCodexAppServerClient(child);
    const p = client.request("turn/start", {});

    const notifs: JsonRpcNotification[] = [];
    const drain = (async () => {
      for await (const n of client.notifications()) notifs.push(n);
    })();

    (child as unknown as EventEmitter).emit("exit", 1, null);

    await expect(p).rejects.toThrow();
    await drain; // notifications stream must terminate, not hang
    expect(notifs.length).toBe(0);
  });

  test("tst_agent_unit_codex_app_server_client_006_close_ends_stdin_idempotently", async () => {
    const child = makeFakeChild();
    const client = createCodexAppServerClient(child);
    await client.close();
    expect(child.stdin.endCalled).toBe(true);
    await client.close(); // no throw
  });

  test("tst_agent_unit_codex_app_server_client_007_notifications_broadcast_to_concurrent_consumers", async () => {
    // One app-server process hosts N threads; concurrent turns each
    // call notifications() and must EACH see every notification (then
    // filter by threadId themselves). A shared single iterator would
    // let one consumer steal the other's events.
    const child = makeFakeChild();
    const client = createCodexAppServerClient(child);

    const a: string[] = [];
    const b: string[] = [];
    const drainA = (async () => {
      for await (const n of client.notifications()) {
        a.push(n.method);
        if (n.method === "turn/completed") break;
      }
    })();
    const drainB = (async () => {
      for await (const n of client.notifications()) {
        b.push(n.method);
        if (n.method === "turn/completed") break;
      }
    })();

    emitLine(child.stdout, { method: "item/agentMessage/delta", params: {} });
    emitLine(child.stdout, { method: "turn/completed", params: {} });

    await Promise.all([drainA, drainB]);
    expect(a).toEqual(["item/agentMessage/delta", "turn/completed"]);
    expect(b).toEqual(["item/agentMessage/delta", "turn/completed"]);
  });
});
