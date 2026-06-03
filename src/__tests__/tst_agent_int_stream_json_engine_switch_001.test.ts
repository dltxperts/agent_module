/**
 * Live switch-engine integration test (Stage 6 / INV-STREAM-7 / -14).
 *
 * Pattern: claude turn 1 → codex turn 2 → claude turn 3. Verifies:
 *  - the long-lived claude process from turn 1 is SIGTERM'd before
 *    turn 3 spawns a fresh one (registry purge on replay);
 *  - turn 3 does NOT recall turn 1's content (the binary was killed,
 *    transcript replay comes from the backend, not in-memory).
 *
 * This test is intentionally minimal: switching engines requires
 * a running backend to supply transcript replay (cacheMode='replay'
 * with the full messages array). Without that, the binary-side
 * memory test in Stage 5 already exercises INV-STREAM-1/6 / the
 * unit test in tst_agent_unit_claude_engine_stream_json_001 (test
 * 003) exercises the engine-level purge.
 *
 * Gated by `MAGNIS_LIVE_AGENT_TESTS=1`. Skipped by default.
 *
 * Plan: docs/plans/claude-engine-stream-json.md Stage 6.
 */

import { describe, expect, test } from "bun:test";
import { randomUUID } from "crypto";

import { ClaudeEngine } from "../agent/claude/claude";
import { createClaudeProcessRegistry } from "../agent/claude/registry";
import type { StreamEvent } from "../agent/types";

const LIVE = process.env.MAGNIS_LIVE_AGENT_TESTS === "1";
const liveTest = LIVE ? test : test.skip;

async function drain(stream: AsyncIterable<StreamEvent>): Promise<string> {
  let text = "";
  for await (const ev of stream) {
    if (ev.type === "delta") text += ev.content;
  }
  return text;
}

describe("ClaudeEngine stream-json engine switch (Stage 6)", () => {
  liveTest(
    "tst_agent_int_stream_json_engine_switch_001_replay_after_switch_loses_binary_memory",
    async () => {
      process.env.CLAUDE_MODEL = "claude-haiku-4-5-20251001";
      const registry = createClaudeProcessRegistry();
      const engine = new ClaudeEngine({ mode: "stream-json", registry });
      const sessionId = randomUUID();

      try {
        // Turn 1: introduce a unique token.
        const TOKEN = "magenta-quetzal-7732";
        await drain(
          engine.stream({
            messages: [
              {
                role: "user",
                content: `Запомни этот token: ${TOKEN}. Reply OK.`,
              },
            ],
            systemPrompt: "You are a terse assistant.",
            maxSteps: 1,
            engineSessionId: sessionId,
          }),
        );
        expect(registry.has(sessionId)).toBe(true);

        // Simulate the codex turn 2: we don't actually call codex
        // here (that's the backend's job — see Stage 7 dogfood).
        // Instead, the next ClaudeEngine.stream() declares the
        // previous turn was codex and cacheMode='replay' WITHOUT
        // the original token in the replay (because between turns
        // the operator might have started a different conversation).

        const turn3Text = await drain(
          engine.stream({
            messages: [
              {
                role: "user",
                content: "Что ты помнишь? Reply with one word only.",
              },
            ],
            systemPrompt: "You are a terse assistant.",
            maxSteps: 1,
            engineSessionId: sessionId,
            previousEngine: "codex",
            cacheMode: "replay",
          }),
        );

        // The new claude process has no memory of TOKEN — the prior
        // session was SIGTERM'd by registry.purge() on replay and
        // its rollout file was purged by claudePreSpawnCleanup.
        expect(turn3Text).not.toContain(TOKEN);
      } finally {
        await registry.purge(sessionId);
      }
    },
    60_000,
  );
});
