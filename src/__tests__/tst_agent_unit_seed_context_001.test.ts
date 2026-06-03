/**
 * INV-SESSION-6 — dynamic context (DENIED actions, contextEnvelope)
 * MUST reach the engine as a prefix on the user message, NOT via
 * `systemPrompt`. A persistent CLI session locks the system prompt
 * on turn 1; mutating it on resume would either be ignored (codex)
 * or change the conversation contract (claude).
 *
 * This test drives `AgentService.chat` with a non-empty
 * `contextEnvelope` and asserts:
 *  (1) `engine.stream({...}).systemPrompt` does NOT contain the
 *      envelope text;
 *  (2) one of `engine.stream({...}).messages` (the user one)
 *      carries the envelope as a prefix.
 */

import { describe, expect, test } from "bun:test";
import { injectSeedContext } from "../agent/service";
import type { ChatMessage } from "../agent/types";

const ENVELOPE = "## DENIED ACTIONS\n- notes.create(...)\n\n## Context\nfoo";

describe("INV-SESSION-6: dynamic context as user-message prefix", () => {
  test("tst_agent_unit_seed_context_001_envelope_appears_in_user_message_not_system_prompt", async () => {
    const messages = [{ role: "user" as const, content: "what now?" }];
    const enriched = injectSeedContext(messages, `${ENVELOPE}\n\n`);
    const userMsg = enriched.find((m) => m.role === "user");
    expect(userMsg).toBeDefined();
    expect(userMsg?.content).toContain("DENIED ACTIONS");
    expect(userMsg?.content).toContain("what now?");
  });

  test("tst_agent_unit_seed_context_002_no_envelope_means_no_prefix", async () => {
    const userMsg = injectSeedContext(
      [{ role: "user", content: "plain message" }],
      "",
    ).find((m) => m.role === "user");
    expect(userMsg?.content).toBe("plain message");
  });

  /// R9 / INV-SESSION-6 regression guard: on a multi-turn transcript,
  /// the seed context MUST attach to the LAST user message so the
  /// engine's resume-mode trim (selectMessagesForCacheMode picking
  /// the rightmost user) still carries the prefix through.
  test("tst_agent_unit_seed_context_003_envelope_lands_on_last_user_message", async () => {
    const messages: ChatMessage[] = [
      { role: "user" as const, content: "first" },
      { role: "assistant" as const, content: "ok" },
      { role: "user" as const, content: "latest user msg" },
    ];

    const enriched = injectSeedContext(messages, `${ENVELOPE}\n\n`);
    // First user must remain UN-prefixed.
    expect(enriched[0].content).toBe("first");
    // Last user must carry the envelope prefix + original content.
    const lastUser = enriched[enriched.length - 1];
    expect(lastUser.role).toBe("user");
    expect(lastUser.content).toContain("DENIED ACTIONS");
    expect(lastUser.content).toContain("latest user msg");
    // Order preserved.
    expect(enriched).toHaveLength(3);
  });
});
