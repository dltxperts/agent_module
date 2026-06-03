/**
 * R1 / INV-SESSION-9 — cross-engine purge fires the right cleanup
 * helper based on `previousEngine`, no-ops for non-CLI / unknown
 * engines, and tolerates missing session artifacts.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { access, mkdir, mkdtemp, readdir, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import { purgePreviousEngineSession } from "../agent/purge";
import {
  codexStateDbPath,
  bootstrapSession,
  lookupSession,
} from "../agent/codex/session";
import { defaultClaudeSessionPath } from "../agent/claude/session";

const UUID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const CLI_VERSION = "0.133.0";

async function seedCodexHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "magnis-cep-codex-"));
  const db = new Database(codexStateDbPath(home));
  try {
    db.run(
      "CREATE TABLE threads (" +
        "id TEXT PRIMARY KEY NOT NULL," +
        "rollout_path TEXT NOT NULL," +
        "created_at INTEGER NOT NULL," +
        "updated_at INTEGER NOT NULL," +
        "source TEXT NOT NULL," +
        "model_provider TEXT NOT NULL," +
        "cwd TEXT NOT NULL," +
        "title TEXT NOT NULL," +
        "sandbox_policy TEXT NOT NULL," +
        "approval_mode TEXT NOT NULL)",
    );
  } finally {
    db.close();
  }
  return home;
}

async function seedClaudeSession(homeDir: string): Promise<string> {
  // Mirror the path defaultClaudeSessionPath produces but write under
  // a CONTROLLED home root so tests stay sandboxed. We do this by
  // pre-creating the dir then writing the file there.
  const sessionPath = defaultClaudeSessionPath(UUID).replace(
    process.env.HOME ?? "",
    homeDir,
  );
  // Above only works when HOME is set; bail loudly otherwise.
  if (!process.env.HOME) throw new Error("HOME unset in test env");
  await mkdir(join(sessionPath, "..").toString(), { recursive: true });
  await writeFile(sessionPath, "stale-transcript");
  return sessionPath;
}

describe("cross-engine purge (R1 / INV-SESSION-9)", () => {
  let savedCodexHome: string | undefined;
  let savedClaudeHome: string | undefined;
  let codexHome: string;
  let claudeHome: string;

  beforeEach(async () => {
    savedCodexHome = process.env.CODEX_HOME;
    savedClaudeHome = process.env.HOME;
    codexHome = await seedCodexHome();
    claudeHome = await mkdtemp(join(tmpdir(), "magnis-cep-claude-"));
    process.env.CODEX_HOME = codexHome;
    process.env.HOME = claudeHome;
  });

  afterEach(() => {
    if (savedCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = savedCodexHome;
    if (savedClaudeHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedClaudeHome;
  });

  test("tst_agent_unit_cep_001_null_previous_engine_is_no_op", async () => {
    await purgePreviousEngineSession(null, UUID); // must not throw
    await purgePreviousEngineSession(undefined, UUID);
  });

  test("tst_agent_unit_cep_002_null_session_id_is_no_op", async () => {
    await purgePreviousEngineSession("claude", null);
    await purgePreviousEngineSession("codex", undefined);
  });

  test("tst_agent_unit_cep_003_unknown_engine_is_no_op", async () => {
    // builtin / scripted / random — no on-disk session to clean.
    await purgePreviousEngineSession("builtin", UUID);
    await purgePreviousEngineSession("scripted", UUID);
    await purgePreviousEngineSession("not-an-engine", UUID);
    // sqlite state in $CODEX_HOME must be untouched.
    const db = new Database(codexStateDbPath(codexHome), { readonly: true });
    try {
      const row = db
        .query("SELECT COUNT(*) AS n FROM threads")
        .get() as { n: number };
      expect(row.n).toBe(0);
    } finally {
      db.close();
    }
  });

  test("tst_agent_unit_cep_004_purges_codex_session_when_previous_is_codex", async () => {
    await bootstrapSession({
      codexHome,
      uuid: UUID,
      cwd: "/tmp",
      cliVersion: CLI_VERSION,
    });
    expect(lookupSession(codexHome, UUID)).toBe(true);

    await purgePreviousEngineSession("codex", UUID);

    expect(lookupSession(codexHome, UUID)).toBe(false);
  });

  test("tst_agent_unit_cep_005_purges_claude_file_when_previous_is_claude", async () => {
    const sessionPath = await seedClaudeSession(claudeHome);
    await access(sessionPath); // sanity

    await purgePreviousEngineSession("claude", UUID);

    await expect(access(sessionPath)).rejects.toThrow();
  });

  test("tst_agent_unit_cep_006_idempotent_when_no_session_exists", async () => {
    // Neither claude file nor codex row exists. Both branches must
    // tolerate the missing artifact.
    await purgePreviousEngineSession("claude", UUID);
    await purgePreviousEngineSession("codex", UUID);
  });
});

/**
 * Validates seedClaudeSession composed a path under `claudeHome`,
 * not under the real user home (sandboxing guard so the test never
 * touches ~/.claude/projects).
 */
describe("cross-engine purge sandbox guard", () => {
  test("tst_agent_unit_cep_007_claude_path_resolves_under_test_home", async () => {
    const dir = await mkdtemp(join(tmpdir(), "magnis-cep-guard-"));
    const prev = process.env.HOME;
    process.env.HOME = dir;
    try {
      const p = defaultClaudeSessionPath(UUID);
      expect(p.startsWith(dir)).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.HOME;
      else process.env.HOME = prev;
      await readdir(dir); // sanity
    }
  });
});
