/**
 * Pure mapping from a codex app-server `ServerNotification` to the
 * project-wide `StreamEvent` union, so the engine's external contract
 * is identical to the legacy `codex exec` path (INV-CODEX-AS-5 / -13).
 *
 * `turn/completed` returns null — it is the per-turn end marker the
 * engine watches for, not a user-visible event. Text arrives only via
 * `item/agentMessage/delta`; the matching item lifecycle events for an
 * agentMessage are suppressed to avoid duplicates.
 *
 * Plan: docs/plans/codex-engine-app-server.md Stage 3.
 */

import type { StreamEvent } from "../types";
import {
  NOTIF,
  type AgentMessageDeltaParams,
  type ErrorParams,
  type ItemLifecycleParams,
  type JsonRpcNotification,
  type ThreadItem,
  type WarningParams,
} from "./types";

function toolCallFromItem(item: ThreadItem): StreamEvent | null {
  if (item.type === "mcpToolCall") {
    return {
      type: "tool_call",
      id: item.id,
      name: (item as { tool: string }).tool,
      args: (item as { arguments: unknown }).arguments ?? {},
    };
  }
  if (item.type === "dynamicToolCall") {
    return {
      type: "tool_call",
      id: item.id,
      name: (item as { tool: string }).tool,
      args: (item as { arguments: unknown }).arguments ?? {},
    };
  }
  return null;
}

/**
 * Unwrap a codex `McpToolCallResult` ({ content, structuredContent,
 * _meta }) to the FLAT tool payload the frontend's AgentChatStore
 * expects — so signals like `pending_approval` / `approval_id` are
 * visible at the top level. Without this, a gated write renders as a
 * completed "Created" card instead of an approval card (the backend
 * correctly held it pending, but the UI mislabeled it). Mirrors the
 * claude mapper's MCP-content unwrap. Live dogfood finding.
 */
export function unwrapMcpResult(result: unknown): unknown {
  if (!result || typeof result !== "object") return result;
  const r = result as {
    structuredContent?: unknown;
    content?: Array<Record<string, unknown>>;
  };
  // Prefer structuredContent when the server provided it.
  if (r.structuredContent && typeof r.structuredContent === "object") {
    return r.structuredContent;
  }
  // Else unwrap MCP content blocks: [{ type:"text", text:"<json>" }].
  if (Array.isArray(r.content) && r.content.length > 0) {
    const first = r.content[0];
    if (first?.type === "text" && typeof first.text === "string") {
      try {
        return JSON.parse(first.text);
      } catch {
        return { text: first.text.slice(0, 2000) };
      }
    }
  }
  return result;
}

function toolResultFromItem(item: ThreadItem): StreamEvent | null {
  if (item.type === "mcpToolCall") {
    const it = item as { tool: string; result?: unknown; error?: unknown };
    return {
      type: "tool_result",
      id: item.id,
      name: it.tool,
      result:
        it.result != null ? unwrapMcpResult(it.result) : (it.error ?? null),
    };
  }
  if (item.type === "dynamicToolCall") {
    const it = item as { tool: string; success?: boolean | null };
    return {
      type: "tool_result",
      id: item.id,
      name: it.tool,
      result: { success: it.success ?? null },
    };
  }
  return null;
}

export function mapCodexNotification(
  notif: JsonRpcNotification,
): StreamEvent | null {
  const params = (notif.params ?? {}) as Record<string, unknown>;

  switch (notif.method) {
    case NOTIF.agentMessageDelta: {
      const p = params as unknown as AgentMessageDeltaParams;
      return { type: "delta", content: p.delta };
    }
    case NOTIF.itemStarted: {
      const p = params as unknown as ItemLifecycleParams;
      return toolCallFromItem(p.item);
    }
    case NOTIF.itemCompleted: {
      const p = params as unknown as ItemLifecycleParams;
      return toolResultFromItem(p.item);
    }
    case NOTIF.turnCompleted:
      return null;
    case NOTIF.warning: {
      const p = params as unknown as WarningParams;
      return {
        type: "warning",
        code: p.code ?? "codex_warning",
        message: p.message ?? "codex warning",
      };
    }
    case NOTIF.error: {
      const p = params as unknown as ErrorParams;
      return { type: "error", message: p.message ?? "codex error" };
    }
    default:
      return null;
  }
}
