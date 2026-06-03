/**
 * @test-id: tst_agent_unit_reset_session_001
 * @covers: src/agent/purge.ts (purgeAllEngineState)
 * @deterministic: yes
 *
 * Stage 2 (INV-6): resetting a session tears down BOTH engines'
 * persistent state under the session id — claude rollout file +
 * process slot, codex thread + rollout — so the next run bootstraps
 * fresh with the current session config.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, writeFile, access, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import { purgeAllEngineState } from "../agent/purge";

const SID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

let codexHome: string;
const prevCodexHome = process.env.CODEX_HOME;

beforeEach(async () => {
  // Empty CODEX_HOME (no state db) → codex purge is a safe no-op.
  codexHome = await mkdtemp(join(tmpdir(), "reset-codex-"));
  process.env.CODEX_HOME = codexHome;
});

afterEach(async () => {
  await rm(codexHome, { recursive: true, force: true });
  if (prevCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = prevCodexHome;
});

describe("purgeAllEngineState (INV-6)", () => {
  test("tst_agent_unit_reset_session_001_purges_both_engines", async () => {
    const dir = await mkdtemp(join(tmpdir(), "reset-claude-"));
    const claudeRollout = join(dir, `${SID}.jsonl`);
    await writeFile(claudeRollout, "x");
    await access(claudeRollout); // sanity: exists

    const claudePurges: string[] = [];
    const codexDrops: string[] = [];
    const claudeRegistry = {
      acquire: () => ({ sessionId: SID, child: {} as never }),
      has: () => false,
      purge: async (id: string) => {
        claudePurges.push(id);
      },
      sweepIdle: () => {},
    };
    const codexRegistry = {
      ensureThread: async () => ({ client: {} as never, threadId: "t" }),
      dropThread: (id: string) => {
        codexDrops.push(id);
      },
      markProcessDead: () => {},
      shutdown: async () => {},
    };

    await purgeAllEngineState(SID, {
      claudeRegistry,
      codexRegistry,
      claudeSessionPath: claudeRollout,
    });

    // claude rollout file removed + process slot purged
    await expect(access(claudeRollout)).rejects.toThrow();
    expect(claudePurges).toEqual([SID]);
    // codex thread dropped from the in-memory registry
    expect(codexDrops).toEqual([SID]);

    await rm(dir, { recursive: true, force: true });
  });
});
