import { describe, expect, test } from "bun:test";
import { mapRawToStreamEvent } from "../agent/claude/events";

const noop = () => {};

describe("claude-event-mapper (Stage 3 parity helper, INV-STREAM-4)", () => {
  test("tst_agent_unit_claude_event_mapper_001_text_block_yields_delta", () => {
    let captured = "";
    const ev = mapRawToStreamEvent(
      {
        type: "assistant",
        message: { content: [{ type: "text", text: "hello" }] },
      },
      (t) => {
        captured = t;
      },
    );
    expect(ev).toEqual({ type: "delta", content: "hello" });
    expect(captured).toBe("hello");
  });

  test("tst_agent_unit_claude_event_mapper_002_tool_use_yields_tool_call_with_mcp_name_translation", () => {
    const ev = mapRawToStreamEvent(
      {
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              id: "tu-1",
              name: "mcp__filesystem__read_file",
              input: { limit: 10 },
            },
          ],
        },
      },
      noop,
    );
    expect(ev).toEqual({
      type: "tool_call",
      id: "tu-1",
      // `mcp__<server>__<tool>` → `<server>.<tool>` (engine-neutral).
      name: "filesystem.read_file",
      args: { limit: 10 },
    });
  });

  test("tst_agent_unit_claude_event_mapper_003_tool_result_yields_tool_result", () => {
    const ev = mapRawToStreamEvent(
      {
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "tu-1",
              content: '[{"type":"text","text":"{\\"ok\\":true}"}]',
            },
          ],
        },
      },
      noop,
    );
    expect(ev).toEqual({
      type: "tool_result",
      id: "tu-1",
      name: "",
      result: { ok: true },
    });
  });

  test("tst_agent_unit_claude_event_mapper_004_result_success_yields_null", () => {
    expect(
      mapRawToStreamEvent(
        { type: "result", subtype: "success", stop_reason: "end_turn" },
        noop,
      ),
    ).toBeNull();
  });

  test("tst_agent_unit_claude_event_mapper_005_result_error_yields_error", () => {
    const ev = mapRawToStreamEvent(
      { type: "result", is_error: true, result: "boom" },
      noop,
    );
    expect(ev).toEqual({ type: "error", message: "boom" });
  });

  test("tst_agent_unit_claude_event_mapper_006_system_init_yields_null", () => {
    expect(
      mapRawToStreamEvent(
        { type: "system", subtype: "init", session_id: "sid-1" },
        noop,
      ),
    ).toBeNull();
  });
});
