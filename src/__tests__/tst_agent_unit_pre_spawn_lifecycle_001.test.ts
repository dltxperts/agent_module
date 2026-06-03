/**
 * R10 / INV-SESSION-9 — verify the pre-spawn lifecycle dispatch in
 * `claudePreSpawnCleanup` and `codexPreSpawnLifecycle` actually calls
 * the right purge / bootstrap operations under each cache_mode +
 * previousEngine combo, WITHOUT spawning a real claude / codex
 * binary. The dispatch was previously inlined in `claude.ts` /
 * `codex.ts`, leaving the call-site contract unverified.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { access, mkdir, mkdtemp, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import { claudePreSpawnCleanup } from "../agent/claude/session";
import {
  codexPreSpawnLifecycle,
  codexStateDbPath,
  lookupSession,
} from "../agent/codex/session";
import { defaultClaudeSessionPath } from "../agent/claude/session";

const UUID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

async function seedCodexHomeWithThreadsSchema(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "magnis-r10-codex-"));
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

async function seedClaudeSessionFile(homeDir: string): Promise<string> {
  // We control HOME via env; defaultClaudeSessionPath reads
  // process.env.HOME so the resolved path lives under our tmpdir.
  const sessionPath = defaultClaudeSessionPath(UUID);
  await mkdir(join(sessionPath, "..").toString(), { recursive: true });
  await writeFile(sessionPath, "stale-transcript");
  void homeDir; // keep the binding for assertion locality
  return sessionPath;
}

describe("claudePreSpawnCleanup (R10 / INV-SESSION-9 call-site)", () => {
  let savedHome: string | undefined;
  let claudeHome: string;

  beforeEach(async () => {
    savedHome = process.env.HOME;
    claudeHome = await mkdtemp(join(tmpdir(), "magnis-r10-claude-"));
    process.env.HOME = claudeHome;
  });
  afterEach(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
  });

  test("tst_agent_unit_pspawn_001_replay_purges_own_session_file", async () => {
    const sessionPath = await seedClaudeSessionFile(claudeHome);
    await access(sessionPath); // sanity

    await claudePreSpawnCleanup({
      sessionId: UUID,
      cacheMode: "replay",
      previousEngine: null,
    });

    await expect(access(sessionPath)).rejects.toThrow();
  });

  test("tst_agent_unit_pspawn_002_resume_does_NOT_purge", async () => {
    const sessionPath = await seedClaudeSessionFile(claudeHome);

    await claudePreSpawnCleanup({
      sessionId: UUID,
      cacheMode: "resume",
      previousEngine: "claude",
    });

    // File must remain.
    await access(sessionPath);
  });

  test("tst_agent_unit_pspawn_003_null_session_id_is_no_op", async () => {
    const sessionPath = await seedClaudeSessionFile(claudeHome);

    await claudePreSpawnCleanup({
      sessionId: null,
      cacheMode: "replay",
      previousEngine: null,
    });

    await access(sessionPath); // file untouched
  });

  test("tst_agent_unit_pspawn_004_replay_with_no_session_file_succeeds_silently", async () => {
    // No file seeded. The cleanup should not throw.
    await claudePreSpawnCleanup({
      sessionId: UUID,
      cacheMode: "replay",
      previousEngine: null,
    });
  });
});

describe("codexPreSpawnLifecycle (R10 / INV-SESSION-4 + INV-SESSION-9)", () => {
  let savedCodexHome: string | undefined;
  let codexHome: string;

  beforeEach(async () => {
    savedCodexHome = process.env.CODEX_HOME;
    codexHome = await seedCodexHomeWithThreadsSchema();
    process.env.CODEX_HOME = codexHome;
  });
  afterEach(() => {
    if (savedCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = savedCodexHome;
  });

  test("tst_agent_unit_pspawn_005_first_turn_bootstraps", async () => {
    // No row exists; lifecycle must create one.
    expect(lookupSession(codexHome, UUID)).toBe(false);

    await codexPreSpawnLifecycle({
      sessionId: UUID,
      cacheMode: "replay",
      previousEngine: null,
      cwd: "/tmp",
      codexBin: "codex",
    });

    expect(lookupSession(codexHome, UUID)).toBe(true);
  });

  test("tst_agent_unit_pspawn_006_resume_with_existing_row_is_idempotent", async () => {
    // Bootstrap first.
    await codexPreSpawnLifecycle({
      sessionId: UUID,
      cacheMode: "replay",
      previousEngine: null,
      cwd: "/tmp",
      codexBin: "codex",
    });
    // Then resume — must NOT purge, row should remain.
    await codexPreSpawnLifecycle({
      sessionId: UUID,
      cacheMode: "resume",
      previousEngine: "codex",
      cwd: "/tmp",
      codexBin: "codex",
    });

    expect(lookupSession(codexHome, UUID)).toBe(true);

    // Only ONE row regardless of two lifecycle calls.
    const db = new Database(codexStateDbPath(codexHome), { readonly: true });
    try {
      const count = db
        .query("SELECT COUNT(*) AS n FROM threads WHERE id = ?")
        .get(UUID) as { n: number };
      expect(count.n).toBe(1);
    } finally {
      db.close();
    }
  });

  test("tst_agent_unit_pspawn_007_replay_after_existing_row_purges_then_re_bootstraps", async () => {
    // Bootstrap first.
    await codexPreSpawnLifecycle({
      sessionId: UUID,
      cacheMode: "replay",
      previousEngine: null,
      cwd: "/tmp",
      codexBin: "codex",
    });
    expect(lookupSession(codexHome, UUID)).toBe(true);

    // Replay → must purge AND re-bootstrap (still one row).
    await codexPreSpawnLifecycle({
      sessionId: UUID,
      cacheMode: "replay",
      previousEngine: "codex",
      cwd: "/tmp",
      codexBin: "codex",
    });

    expect(lookupSession(codexHome, UUID)).toBe(true);
  });

  test("tst_agent_unit_pspawn_008_null_session_id_is_no_op", async () => {
    await codexPreSpawnLifecycle({
      sessionId: null,
      cacheMode: "replay",
      previousEngine: null,
      cwd: "/tmp",
      codexBin: "codex",
    });

    // No rows created for any UUID.
    const db = new Database(codexStateDbPath(codexHome), { readonly: true });
    try {
      const count = db
        .query("SELECT COUNT(*) AS n FROM threads")
        .get() as { n: number };
      expect(count.n).toBe(0);
    } finally {
      db.close();
    }
  });
});
