/**
 * Seed context builder — minimal, generic, not module-specific.
 *
 * Inserted at the start of the first user message so the agent
 * knows what the user is looking at. The agent then uses graph
 * discovery tools to learn more.
 */

import type { UIContext } from "../agent/types";

/**
 * Build seed context for injection into the first user message.
 *
 * @invariant INV-15: Uses contextEnvelope when present, falls back to [Context:] when absent.
 * @tested-by: tst_int_epctx_010..026 (backend), typecheck (sidecar)
 */
export function buildSeedContext(ctx?: UIContext, envelope?: string): string {
  // INV-15: prefer structured envelope from backend ContextEnvelopeBuilder
  if (envelope) return envelope + "\n\n";

  // Fallback: thin context string (backward-compatible)
  if (!ctx) return "";

  const parts: string[] = [];

  if (ctx.activeModule) parts.push(`module="${ctx.activeModule}"`);
  if (ctx.selectedEntityId) parts.push(`entity_id="${ctx.selectedEntityId}"`);
  if (ctx.selectedEntityName) parts.push(`entity_name="${ctx.selectedEntityName}"`);
  if (ctx.selectedChatId) parts.push(`chat_id="${ctx.selectedChatId}"`);
  if (ctx.selectedChatName) parts.push(`chat_name="${ctx.selectedChatName}"`);
  if (ctx.episodeId) parts.push(`episode_id="${ctx.episodeId}"`);
  if (ctx.replyToEntityId) parts.push(`reply_to_entity="${ctx.replyToEntityId}"`);

  return parts.length > 0 ? `[Context: ${parts.join(", ")}]\n\n` : "";
}
