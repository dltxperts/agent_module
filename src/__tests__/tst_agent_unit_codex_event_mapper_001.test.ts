import { describe, expect, test } from "bun:test";
import { mapCodexNotification } from "../agent/codex/events";
import type { JsonRpcNotification } from "../agent/codex/types";

function notif(method: string, params: unknown): JsonRpcNotification {
  return { method, params };
}

describe("codex-event-mapper (Stage 3, INV-CODEX-AS-13)", () => {
  test("tst_agent_unit_codex_event_mapper_001_agent_message_delta_to_delta", () => {
    const ev = mapCodexNotification(
      notif("item/agentMessage/delta", {
        threadId: "t1",
        turnId: "u1",
        itemId: "i1",
        delta: "hello",
      }),
    );
    expect(ev).toEqual({ type: "delta", content: "hello" });
  });

  test("tst_agent_unit_codex_event_mapper_002_item_started_mcp_tool_to_tool_call", () => {
    const ev = mapCodexNotification(
      notif("item/started", {
        threadId: "t1",
        turnId: "u1",
        item: {
          type: "mcpToolCall",
          id: "tc-1",
          server: "majordomo",
          tool: "contacts.list",
          arguments: { limit: 5 },
          status: "running",
        },
      }),
    );
    expect(ev).toEqual({
      type: "tool_call",
      id: "tc-1",
      name: "contacts.list",
      args: { limit: 5 },
    });
  });

  test("tst_agent_unit_codex_event_mapper_003_item_completed_mcp_tool_to_tool_result", () => {
    const ev = mapCodexNotification(
      notif("item/completed", {
        threadId: "t1",
        turnId: "u1",
        item: {
          type: "mcpToolCall",
          id: "tc-1",
          server: "majordomo",
          tool: "contacts.list",
          arguments: {},
          status: "completed",
          result: { rows: 3 },
        },
      }),
    );
    expect(ev).toEqual({
      type: "tool_result",
      id: "tc-1",
      name: "contacts.list",
      result: { rows: 3 },
    });
  });

  test("tst_agent_unit_codex_event_mapper_003b_mcp_result_content_unwrapped_so_pending_approval_surfaces", () => {
    // Real codex McpToolCallResult wraps the payload in
    // { content:[{type:text,text:"<json>"}], structuredContent, _meta }.
    // The mapper MUST unwrap to the flat payload so the frontend can
    // detect pending_approval and render an approval card (not a
    // completed "Created" card). Live dogfood finding.
    const ev = mapCodexNotification(
      notif("item/completed", {
        threadId: "t1",
        turnId: "u1",
        item: {
          type: "mcpToolCall",
          id: "tc-9",
          server: "majordomo",
          tool: "contacts.create",
          arguments: { name: "room" },
          status: "completed",
          result: {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  pending_approval: true,
                  approval_id: "ap-123",
                  message: "This action requires user approval.",
                }),
              },
            ],
            structuredContent: null,
            _meta: null,
          },
        },
      }),
    );
    expect(ev).toEqual({
      type: "tool_result",
      id: "tc-9",
      name: "contacts.create",
      result: {
        pending_approval: true,
        approval_id: "ap-123",
        message: "This action requires user approval.",
      },
    });
  });

  test("tst_agent_unit_codex_event_mapper_003c_structured_content_preferred", () => {
    const ev = mapCodexNotification(
      notif("item/completed", {
        threadId: "t1",
        turnId: "u1",
        item: {
          type: "mcpToolCall",
          id: "tc-10",
          server: "majordomo",
          tool: "contacts.create",
          arguments: {},
          status: "completed",
          result: {
            content: [{ type: "text", text: "{\"ignored\":true}" }],
            structuredContent: { id: "entity-1", name: "room" },
            _meta: null,
          },
        },
      }),
    );
    expect((ev as { result: unknown }).result).toEqual({
      id: "entity-1",
      name: "room",
    });
  });

  test("tst_agent_unit_codex_event_mapper_004_dynamic_tool_call_started_to_tool_call", () => {
    const ev = mapCodexNotification(
      notif("item/started", {
        threadId: "t1",
        turnId: "u1",
        item: {
          type: "dynamicToolCall",
          id: "dt-1",
          tool: "shell",
          arguments: { cmd: "ls" },
          status: "running",
        },
      }),
    );
    expect(ev).toEqual({
      type: "tool_call",
      id: "dt-1",
      name: "shell",
      args: { cmd: "ls" },
    });
  });

  test("tst_agent_unit_codex_event_mapper_005_turn_completed_yields_null", () => {
    expect(
      mapCodexNotification(notif("turn/completed", { threadId: "t1", turn: {} })),
    ).toBeNull();
  });

  test("tst_agent_unit_codex_event_mapper_006_warning_to_warning", () => {
    const ev = mapCodexNotification(
      notif("warning", { message: "low credits", code: "credits_low" }),
    );
    expect(ev).toEqual({
      type: "warning",
      code: "credits_low",
      message: "low credits",
    });
  });

  test("tst_agent_unit_codex_event_mapper_007_error_to_error", () => {
    const ev = mapCodexNotification(notif("error", { message: "boom" }));
    expect(ev).toEqual({ type: "error", message: "boom" });
  });

  test("tst_agent_unit_codex_event_mapper_008_agent_message_item_started_is_null", () => {
    // The agentMessage text arrives via delta; the item lifecycle for
    // it must NOT produce a duplicate event.
    expect(
      mapCodexNotification(
        notif("item/started", {
          threadId: "t1",
          turnId: "u1",
          item: { type: "agentMessage", id: "a1", text: "" },
        }),
      ),
    ).toBeNull();
  });

  test("tst_agent_unit_codex_event_mapper_009_unknown_method_is_null", () => {
    expect(
      mapCodexNotification(notif("thread/tokenUsage/updated", {})),
    ).toBeNull();
  });
});
