/**
 * Pure mapping from a raw Claude Code CLI event (parsed JSON object)
 * to the project-wide `StreamEvent` discriminated union.
 *
 * Shared by both the legacy per-turn `claude --prompt` path and the
 * stream-json long-lived process path so the engine's external
 * contract (the `StreamEvent` sequence) is identical regardless of
 * which transport was used. INV-STREAM-4 / -15.
 *
 * Plan: docs/plans/claude-engine-stream-json.md Stage 3.
 */

import type { StreamEvent } from "../types";

// Claude names MCP tools `mcp__<server>__<tool>`. Strip the leading
// `mcp__` and render the rest as `<server>.<tool>` for a readable,
// engine-neutral tool name. Non-MCP built-in tools pass through raw.
const MCP_TOOL_PREFIX = "mcp__";

/**
 * Map one raw CLI event into a single `StreamEvent`, or `null` when
 * the event has no externally visible side effect (e.g. a
 * `system/init` or a no-op `result/success`). Calls `onText(text)`
 * whenever an assistant text block is emitted so the engine can
 * accumulate `full_content` for the final `{type:"done"}` event.
 */
export function mapRawToStreamEvent(
  event: Record<string, unknown>,
  onText: (text: string) => void,
): StreamEvent | null {
  const type = event.type as string;

  if (type === "assistant") {
    const message = event.message as Record<string, unknown> | undefined;
    const content = (message?.content ?? event.content) as
      | Array<Record<string, unknown>>
      | undefined;
    if (!content) return null;

    for (const block of content) {
      if (block.type === "text" && typeof block.text === "string") {
        onText(block.text);
        return { type: "delta", content: block.text };
      }
      if (block.type === "tool_use" && typeof block.name === "string") {
        const rawName = block.name;
        const mcpName = rawName.startsWith(MCP_TOOL_PREFIX)
          ? rawName.slice(MCP_TOOL_PREFIX.length).replace(/__/g, ".")
          : rawName;
        return {
          type: "tool_call",
          id: (block.id as string) ?? "",
          name: mcpName,
          args: block.input ?? {},
        };
      }
    }
    return null;
  }

  if (type === "user") {
    const message = event.message as Record<string, unknown> | undefined;
    const content = message?.content as
      | Array<Record<string, unknown>>
      | undefined;
    if (!content) return null;
    for (const block of content) {
      if (
        block.type === "tool_result" &&
        typeof block.tool_use_id === "string"
      ) {
        const rawContent =
          typeof block.content === "string"
            ? block.content
            : JSON.stringify(block.content);
        let parsed: unknown;
        try {
          const json = JSON.parse(rawContent);
          if (
            Array.isArray(json) &&
            json.length > 0 &&
            json[0]?.type === "text" &&
            json[0]?.text
          ) {
            try {
              parsed = JSON.parse(json[0].text);
            } catch {
              parsed = { text: String(json[0].text).slice(0, 2000) };
            }
          } else {
            parsed = json;
          }
        } catch {
          parsed = { text: rawContent.slice(0, 2000) };
        }
        return {
          type: "tool_result",
          id: block.tool_use_id,
          name: "",
          result: parsed,
        };
      }
    }
    return null;
  }

  if (type === "result") {
    if (event.is_error) {
      return {
        type: "error",
        message: (event.result as string) ?? "Claude Code error",
      };
    }
    return null;
  }

  return null;
}
