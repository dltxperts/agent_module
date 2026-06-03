/**
 * Server→client request handling (the codex app-server tool-call hang
 * fix). Live dogfood: codex emitted `mcpServer/elicitation/request`
 * (id + method) for each MCP tool call; the old client misrouted it to
 * the notification stream and never answered → the turn hung forever.
 *
 * Plan: docs/plans/codex-engine-app-server.md §7.5.
 */

import { describe, expect, test } from "bun:test";
import { EventEmitter } from "events";
import type { ChildProcess } from "child_process";

import { createCodexAppServerClient } from "../agent/codex/app-client";
import type { ServerRequest } from "../agent/codex/types";
import { autoApproveResult } from "../agent/codex/approval";

function makeFakeChild() {
  const ee = new EventEmitter() as EventEmitter & ChildProcess;
  const written: string[] = [];
  Object.assign(ee, {
    pid: 1,
    stdin: {
      write: (s: string) => {
        written.push(s);
        return true;
      },
      end: () => {},
      once: () => {},
    },
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
  });
  return { child: ee as unknown as ChildProcess, written };
}

function emit(child: ChildProcess, obj: unknown) {
  (child.stdout as unknown as EventEmitter).emit(
    "data",
    Buffer.from(JSON.stringify(obj) + "\n"),
  );
}

describe("autoApproveResult policy (§7.5)", () => {
  test("tst_agent_unit_codex_srpolicy_001_elicitation_accepts", () => {
    expect(autoApproveResult({ method: "mcpServer/elicitation/request" })).toEqual({
      action: "accept",
    });
  });
  test("tst_agent_unit_codex_srpolicy_002_approvals_approved", () => {
    for (const m of [
      "execCommandApproval",
      "applyPatchApproval",
      "item/commandExecution/requestApproval",
      "item/fileChange/requestApproval",
      "item/permissions/requestApproval",
    ]) {
      expect(autoApproveResult({ method: m })).toEqual({ decision: "approved" });
    }
  });
  test("tst_agent_unit_codex_srpolicy_003_unknown_declines_not_hangs", () => {
    expect(autoApproveResult({ method: "some/futureRequest" })).toEqual({
      action: "decline",
    });
  });
});

describe("CodexAppServerClient server-request routing", () => {
  test("tst_agent_unit_codex_srreq_001_request_with_id_routes_to_handler_not_notifications", async () => {
    const { child } = makeFakeChild();
    const client = createCodexAppServerClient(child);

    const gotRequests: ServerRequest[] = [];
    client.onServerRequest((req) => gotRequests.push(req));

    // A server→client request (method + id) must NOT appear in the
    // notification stream.
    const notifs: string[] = [];
    const drain = (async () => {
      for await (const n of client.notifications()) {
        notifs.push(n.method);
        if (n.method === "turn/completed") break;
      }
    })();

    emit(child, {
      method: "mcpServer/elicitation/request",
      id: 0,
      params: { threadId: "t1", mode: "form" },
    });
    emit(child, { method: "turn/completed", params: { threadId: "t1" } });
    await drain;

    expect(gotRequests.map((r) => r.method)).toEqual([
      "mcpServer/elicitation/request",
    ]);
    expect(gotRequests[0].id).toBe(0);
    // The elicitation must NOT have leaked into notifications.
    expect(notifs).toEqual(["turn/completed"]);
  });

  test("tst_agent_unit_codex_srreq_002_respond_writes_jsonrpc_result", () => {
    const { child, written } = makeFakeChild();
    const client = createCodexAppServerClient(child);
    client.respond(0, { action: "accept" });
    const env = JSON.parse(written.at(-1) as string);
    expect(env).toEqual({ jsonrpc: "2.0", id: 0, result: { action: "accept" } });
  });

  test("tst_agent_unit_codex_srreq_003_requests_before_handler_are_buffered_then_flushed", () => {
    const { child } = makeFakeChild();
    const client = createCodexAppServerClient(child);

    // Request arrives BEFORE a handler is attached — must be buffered,
    // not dropped (else the first turn's elicitation hangs).
    emit(child, { method: "mcpServer/elicitation/request", id: 7, params: {} });

    const seen: ServerRequest[] = [];
    client.onServerRequest((req) => seen.push(req));
    expect(seen.map((r) => r.id)).toEqual([7]);
  });

  test("tst_agent_unit_codex_srreq_004_end_to_end_auto_accept_replies", () => {
    const { child, written } = makeFakeChild();
    const client = createCodexAppServerClient(child);
    client.onServerRequest((req) => client.respond(req.id, autoApproveResult(req)));

    emit(child, { method: "mcpServer/elicitation/request", id: 3, params: {} });
    const env = JSON.parse(written.at(-1) as string);
    expect(env).toEqual({ jsonrpc: "2.0", id: 3, result: { action: "accept" } });
  });
});
