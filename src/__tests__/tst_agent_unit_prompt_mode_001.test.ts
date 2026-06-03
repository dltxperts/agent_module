/**
 * Replaces the deleted Rust `trim_messages_for_resume` tests
 * (tst_svc_agent_trim_001..003). The trim now lives engine-side so
 * codex's R5 fall-through can rebuild from the original full
 * transcript when resume fails.
 *
 * Plan: docs/plans/agent-persistent-sessions.md (INV-SESSION-7,
 * R7 BLOCK 2).
 */

import { describe, expect, test } from "bun:test";

import { selectMessagesForCacheMode } from "../agent/prompt";
import type { ChatMessage } from "../agent/types";

const msg = (role: ChatMessage["role"], content: string): ChatMessage => ({
  role,
  content,
});

describe("selectMessagesForCacheMode (R7 BLOCK 2 / INV-SESSION-7)", () => {
  test("tst_agent_unit_prompt_mode_001_resume_keeps_only_last_user", () => {
    const messages = [
      msg("user", "first"),
      msg("assistant", "ok"),
      msg("user", "second"),
      msg("assistant", "fine"),
      msg("user", "third"),
    ];
    const trimmed = selectMessagesForCacheMode(messages, "resume");
    expect(trimmed).toHaveLength(1);
    expect(trimmed[0].role).toBe("user");
    expect(trimmed[0].content).toBe("third");
    // Input must not be mutated.
    expect(messages).toHaveLength(5);
  });

  test("tst_agent_unit_prompt_mode_002_replay_returns_full_transcript", () => {
    const messages = [
      msg("user", "u1"),
      msg("assistant", "a1"),
      msg("user", "u2"),
    ];
    const out = selectMessagesForCacheMode(messages, "replay");
    expect(out).toBe(messages);
  });

  test("tst_agent_unit_prompt_mode_003_undefined_mode_returns_full_transcript", () => {
    const messages = [msg("user", "hi"), msg("assistant", "hello")];
    const out = selectMessagesForCacheMode(messages, undefined);
    expect(out).toBe(messages);
  });

  test("tst_agent_unit_prompt_mode_004_resume_with_no_user_row_returns_input", () => {
    // Degenerate input: only assistant rows. Don't fabricate.
    const messages = [msg("assistant", "orphan")];
    const out = selectMessagesForCacheMode(messages, "resume");
    expect(out).toBe(messages);
  });

  test("tst_agent_unit_prompt_mode_005_resume_picks_rightmost_user", () => {
    // Two user rows in a row (rare, but possible): pick the rightmost.
    const messages = [
      msg("user", "first user"),
      msg("user", "second user"),
      msg("assistant", "noted"),
    ];
    const out = selectMessagesForCacheMode(messages, "resume");
    expect(out).toHaveLength(1);
    expect(out[0].content).toBe("second user");
  });
});
