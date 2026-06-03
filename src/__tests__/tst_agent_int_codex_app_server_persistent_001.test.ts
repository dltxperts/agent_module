/**
 * Live integration: drive a real `codex app-server` via CodexEngine
 * in app-server mode and assert two turns share one thread
 * (INV-CODEX-AS-1) and the second recalls the first (INV-CODEX-AS-6).
 *
 * Gated by `MAGNIS_LIVE_AGENT_TESTS=1` (subscription quota + a
 * logged-in `codex` CLI). Default = skipped.
 *
 * Manual:
 *   MAGNIS_LIVE_AGENT_TESTS=1 CODEX_ENGINE_MODE=app-server \\
 *     bun test src/__tests__/tst_agent_int_codex_app_server_persistent_001.test.ts
 *
 * Plan: docs/plans/codex-engine-app-server.md Stage 6.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "crypto";

import { CodexEngine } from "../agent/codex/codex";
import { createCodexAppServerRegistry } from "../agent/codex/registry";
import type { CodexAppServerRegistry } from "../agent/codex/types";
import type { EngineRequest, StreamEvent } from "../agent/types";

const LIVE = process.env.MAGNIS_LIVE_AGENT_TESTS === "1";
const liveTest = LIVE ? test : test.skip;

let sharedRegistry: CodexAppServerRegistry | null = null;

afterAll(async () => {
  if (sharedRegistry) await sharedRegistry.shutdown();
});

async function drain(stream: AsyncIterable<StreamEvent>): Promise<string> {
  let text = "";
  for await (const ev of stream) {
    if (ev.type === "delta") text += ev.content;
  }
  return text;
}

describe("CodexEngine app-server live (Stage 6)", () => {
  liveTest(
    "tst_agent_int_codex_app_server_persistent_001_two_turns_recall_name",
    async () => {
      const registry = createCodexAppServerRegistry();
      sharedRegistry = registry;
      const engine = new CodexEngine({ mode: "app-server", registry });
      const sessionId = randomUUID();

      const base: Omit<EngineRequest, "messages"> = {
        systemPrompt: "You are a terse assistant. Reply in 1-2 short sentences.",
        maxSteps: 2,
        engineSessionId: sessionId,
      };

      const t1 = await drain(
        engine.stream({
          ...base,
          messages: [
            { role: "user", content: "Меня зовут Иван. Запомни моё имя одной фразой." },
          ],
        }),
      );
      expect(t1.length).toBeGreaterThan(0);

      const t2 = await drain(
        engine.stream({
          ...base,
          messages: [{ role: "user", content: "Как меня зовут? Ответь одним словом." }],
        }),
      );
      expect(t2).toContain("Иван");
    },
    120_000,
  );
});
