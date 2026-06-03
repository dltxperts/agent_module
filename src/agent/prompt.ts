/**
 * Pure helpers for building the CLI prompt under different cache
 * modes. Lives outside `claude.ts` / `codex.ts` so both engines —
 * and codex's R5 fall-through — share one implementation.
 *
 * The backend ALWAYS sends the full `messages` array. The engine
 * trims (or doesn't) based on `cacheMode`:
 *  - `"resume"`: only the latest user message; the CLI session
 *    holds the transcript already.
 *  - `"replay"` or absent: the full transcript so the engine can
 *    rebuild from scratch.
 *
 * Plan: docs/plans/agent-persistent-sessions.md (INV-SESSION-7).
 * Replaces the backend-side `trim_messages_for_resume` so codex's
 * R5 fall-through has access to the original transcript when
 * resume fails.
 */

import type { ChatMessage } from "./types";

/**
 * Pick the messages the engine should pass to the CLI for this turn.
 *
 * `cacheMode === "resume"` returns a single-element array containing
 * the most recent `user` message; everything else returns the input
 * unchanged. Pure — does not mutate the input array.
 */
export function selectMessagesForCacheMode(
  messages: ChatMessage[],
  cacheMode: "resume" | "replay" | undefined,
): ChatMessage[] {
  if (cacheMode !== "resume") return messages;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      return [messages[i]];
    }
  }
  // Degenerate input (no user row) — let the engine see what was
  // sent rather than fabricating empty content.
  return messages;
}
