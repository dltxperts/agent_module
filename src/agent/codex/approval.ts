/**
 * Auto-approval policy for codex app-server → client REQUESTS.
 *
 * In headless agent mode the backend's permission/approval gate is the
 * source of truth, and the engine runs with `approvalPolicy: "never"`.
 * But codex app-server still surfaces an MCP **elicitation** request for
 * each MCP tool call (`codex_approval_kind: "mcp_tool_call"`) and may
 * surface exec/patch approval requests. These are server→client
 * requests with an `id` that BLOCK the turn until answered — if the
 * agent doesn't reply, the turn hangs forever.
 *
 * This pure function maps a server request to the JSON-RPC `result` we
 * send back. The agent auto-accepts (the human-facing approval gate, if
 * any, lives in the backend / frontend, not in the codex transport).
 *
 * Plan: docs/plans/codex-engine-app-server.md §7.5 / §7.2 (live dogfood
 * finding: tool calls hung on unanswered elicitation).
 */

import type { CodexServerRequestLike } from "./types";

/**
 * The reply body for a server→client request. `null` means "no known
 * reply shape" — the caller should still respond (with this) to avoid
 * hanging, but it signals the method was unrecognized.
 */
export function autoApproveResult(req: CodexServerRequestLike): unknown {
  switch (req.method) {
    // MCP elicitation (incl. codex's mcp_tool_call approval form).
    // Response shape: McpServerElicitationRequestResponse { action }.
    case "mcpServer/elicitation/request":
      return { action: "accept" };

    // Command / patch / permission approvals.
    // Response shape: *ApprovalResponse { decision }.
    case "execCommandApproval":
    case "applyPatchApproval":
    case "item/commandExecution/requestApproval":
    case "item/fileChange/requestApproval":
    case "item/permissions/requestApproval":
      return { decision: "approved" };

    // Unknown server request: decline rather than hang. Declining is
    // the safe default — it unblocks the turn without authorizing an
    // action whose shape we don't understand.
    default:
      return { action: "decline" };
  }
}
