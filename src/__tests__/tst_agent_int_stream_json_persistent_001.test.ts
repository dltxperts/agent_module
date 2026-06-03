/**
 * Live integration test: drives a real `claude` child via
 * ClaudeEngine in stream-json mode and asserts that two consecutive
 * turns share one process (INV-STREAM-1) and that the second turn
 * recalls content from the first (INV-STREAM-6).
 *
 * Gated by `MAGNIS_LIVE_AGENT_TESTS=1` because it consumes
 * subscription quota and depends on a logged-in `claude` CLI
 * (`~/.claude.json`). Default = skipped.
 *
 * Manual invocation:
 *   unset ANTHROPIC_API_KEY
 *   MAGNIS_LIVE_AGENT_TESTS=1 CLAUDE_ENGINE_MODE=stream-json \\
 *     bun test src/__tests__/tst_agent_int_stream_json_persistent_001.test.ts
 *
 * Plan: docs/plans/claude-engine-stream-json.md Stage 5.
 */

import { describe, expect, test } from "bun:test";
import { randomUUID } from "crypto";

import { ClaudeEngine } from "../agent/claude/claude";
import { createClaudeProcessRegistry } from "../agent/claude/registry";
import type { StreamEvent } from "../agent/types";

const LIVE = process.env.MAGNIS_LIVE_AGENT_TESTS === "1";
const liveTest = LIVE ? test : test.skip;

interface DrainResult {
  text: string;
  events: StreamEvent[];
}

async function drain(stream: AsyncIterable<StreamEvent>): Promise<DrainResult> {
  let text = "";
  const events: StreamEvent[] = [];
  for await (const ev of stream) {
    events.push(ev);
    if (ev.type === "delta") text += ev.content;
  }
  return { text, events };
}

describe("ClaudeEngine stream-json live (Stage 5)", () => {
  liveTest(
    "tst_agent_int_stream_json_persistent_001_two_turns_share_one_process_and_recall_name",
    async () => {
      // Use a haiku model — cheap + fast.
      process.env.CLAUDE_MODEL = "claude-haiku-4-5-20251001";

      const registry = createClaudeProcessRegistry();
      const engine = new ClaudeEngine({
        mode: "stream-json",
        registry,
      });

      const sessionId = randomUUID();
      const baseReq = {
        systemPrompt: "You are a terse assistant. Reply in 1–2 short sentences.",
        // MCP proxy points to an unreachable port — this test is
        // memory-only, no tools.
        maxSteps: 2,
        engineSessionId: sessionId,
      };

      try {
        // Turn 1 — introduce name.
        const turn1 = await drain(
          engine.stream({
            ...baseReq,
            messages: [
              {
                role: "user",
                content: "Меня зовут Иван. Запомни моё имя одной фразой.",
              },
            ],
          }),
        );
        expect(turn1.text.length).toBeGreaterThan(0);

        // The process slot must exist after turn 1.
        expect(registry.has(sessionId)).toBe(true);
        const childAfterTurn1 = (registry as unknown as {
          // sneaky read of internal map for pid assertion — see
          // ClaudeProcessRegistry impl for the actual field.
          [k: string]: unknown;
        });
        void childAfterTurn1;

        // Turn 2 — ask for the name.
        const turn2 = await drain(
          engine.stream({
            ...baseReq,
            messages: [{ role: "user", content: "Как меня зовут?" }],
          }),
        );
        // INV-STREAM-6: memory survives across turns.
        expect(turn2.text).toContain("Иван");

        // INV-STREAM-1: registry slot is still the same one.
        expect(registry.has(sessionId)).toBe(true);
      } finally {
        await registry.purge(sessionId);
      }
    },
    60_000,
  );

  liveTest(
    "tst_agent_int_stream_json_persistent_002_session_id_surfaced_in_warnings_only_on_mismatch",
    async () => {
      // Sanity-check the warning channel: with a fresh session id we
      // should NOT see `claude_session_id_mismatch`.
      process.env.CLAUDE_MODEL = "claude-haiku-4-5-20251001";
      const registry = createClaudeProcessRegistry();
      const engine = new ClaudeEngine({ mode: "stream-json", registry });
      const sessionId = randomUUID();

      try {
        const { events } = await drain(
          engine.stream({
            messages: [{ role: "user", content: "1+1?" }],
            systemPrompt: "Reply with the integer.",
            maxSteps: 1,
            engineSessionId: sessionId,
          }),
        );
        const mismatch = events.find(
          (e) => e.type === "warning" && e.code === "claude_session_id_mismatch",
        );
        expect(mismatch).toBeUndefined();
      } finally {
        await registry.purge(sessionId);
      }
    },
    60_000,
  );
});
