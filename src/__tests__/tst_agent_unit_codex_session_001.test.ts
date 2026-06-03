import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, readFile, writeFile, access } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import {
  bootstrapSession,
  buildCodexExecArgs,
  buildSessionMeta,
  classifyCodexAttempt,
  codexRolloutPath,
  codexStateDbPath,
  defaultCodexHome,
  isCodexMissingRolloutError,
  lookupSession,
  purgeSession,
} from "../agent/codex/session";

/**
 * Stand up a temp `$CODEX_HOME` with a minimum-viable `threads` table.
 * Mirrors the subset of columns this module relies on; if the real
 * codex schema drifts in incompatible ways the failure surfaces in
 * INV-SESSION-5 fallback (replay mode) — see the plan's "Risks"
 * section.
 */
async function makeCodexHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "magnis-codex-"));
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

const UUID = "9992f9e9-734f-49da-9d35-4fe5a1a80fb0";
const CLI_VERSION = "0.133.0";
const CWD = "/tmp/magnis-test";

describe("codex-session pure helpers (Stage 5)", () => {
  test("tst_agent_unit_codex_session_001_state_db_path", () => {
    expect(codexStateDbPath("/tmp/cx")).toBe("/tmp/cx/state_5.sqlite");
  });

  test("tst_agent_unit_codex_session_002_rollout_path_shape", () => {
    const path = codexRolloutPath(
      "/home/u/.codex",
      "2026-05-26T18:38:06.123Z",
      UUID,
    );
    expect(path).toBe(
      `/home/u/.codex/sessions/2026/05/26/rollout-2026-05-26T18-38-06-${UUID}.jsonl`,
    );
  });

  test("tst_agent_unit_codex_session_003_rollout_path_handles_no_millis", () => {
    const path = codexRolloutPath(
      "/cx",
      "2026-05-26T18:38:06Z",
      UUID,
    );
    expect(path).toBe(`/cx/sessions/2026/05/26/rollout-2026-05-26T18-38-06-${UUID}.jsonl`);
  });

  test("tst_agent_unit_codex_session_003b_default_codex_home_uses_env_when_set", () => {
    const prev = process.env.CODEX_HOME;
    process.env.CODEX_HOME = "/override/cx";
    try {
      expect(defaultCodexHome()).toBe("/override/cx");
    } finally {
      if (prev === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = prev;
    }
  });

  test("tst_agent_unit_codex_session_003c_build_exec_args_without_session", () => {
    const args = buildCodexExecArgs({ fullPrompt: "hello", permissionMode: "full" });
    expect(args[0]).toBe("exec");
    expect(args).not.toContain("resume");
    expect(args).toContain("hello");
    expect(args).toContain("--json");
    expect(args).toContain("--dangerously-bypass-approvals-and-sandbox");
  });

  test("tst_agent_unit_codex_session_003d_build_exec_args_with_session_uses_resume", () => {
    const args = buildCodexExecArgs({
      fullPrompt: "hello",
      engineSessionId: UUID,
      permissionMode: "full",
    });
    expect(args[0]).toBe("exec");
    expect(args[1]).toBe("resume");
    expect(args).toContain(UUID);
    expect(args).toContain("hello");
    expect(args).toContain("--json");
    // UUID precedes the prompt in argv (codex parses positional args
    // as [SESSION_ID] [PROMPT]).
    const uuidIdx = args.indexOf(UUID);
    const promptIdx = args.indexOf("hello");
    expect(uuidIdx).toBeLessThan(promptIdx);
  });

  // ── permission_mode mapping (INV-4) ───────────────────────────────

  test("tst_agent_unit_codex_session_003f_restricted_mode_uses_read_only_sandbox", () => {
    const args = buildCodexExecArgs({ fullPrompt: "hi", permissionMode: "restricted" });
    expect(args).toContain("--sandbox");
    expect(args[args.indexOf("--sandbox") + 1]).toBe("read-only");
    expect(args).not.toContain("--dangerously-bypass-approvals-and-sandbox");
  });

  test("tst_agent_unit_codex_session_003g_default_permission_mode_is_restricted", () => {
    // No permissionMode → safe default (restricted / read-only sandbox).
    const args = buildCodexExecArgs({ fullPrompt: "hi" });
    expect(args).toContain("--sandbox");
    expect(args[args.indexOf("--sandbox") + 1]).toBe("read-only");
    expect(args).not.toContain("--dangerously-bypass-approvals-and-sandbox");
  });

  // ── model passthrough (INV-2) ─────────────────────────────────────

  test("tst_agent_unit_codex_session_003h_model_flag_when_provided", () => {
    const args = buildCodexExecArgs({ fullPrompt: "hi", model: "gpt-5", permissionMode: "full" });
    expect(args).toContain("--model");
    expect(args[args.indexOf("--model") + 1]).toBe("gpt-5");
  });

  test("tst_agent_unit_codex_session_003i_no_model_flag_when_absent", () => {
    const args = buildCodexExecArgs({ fullPrompt: "hi", permissionMode: "full" });
    expect(args).not.toContain("--model");
  });

  test("tst_agent_unit_codex_session_003e_missing_rollout_classifier", () => {
    const stderr =
      "Error: thread/resume: thread/resume failed: no rollout found for thread id 9992f9e9-734f-49da-9d35-4fe5a1a80fb0 (code -32600)";
    expect(isCodexMissingRolloutError(stderr)).toBe(true);
    expect(isCodexMissingRolloutError("")).toBe(false);
    expect(
      isCodexMissingRolloutError("authentication required, please run codex login"),
    ).toBe(false);
    // Case-insensitive guard so a future "No rollout found" rewording
    // still triggers the fallback path.
    expect(
      isCodexMissingRolloutError("No Rollout Found For Thread Id whatever"),
    ).toBe(true);
  });

  test("tst_agent_unit_codex_session_004_session_meta_minimum_fields", () => {
    const line = buildSessionMeta({
      uuid: UUID,
      isoTimestamp: "2026-05-26T18:38:06.000Z",
      cwd: CWD,
      cliVersion: CLI_VERSION,
    });
    expect(line.endsWith("\n")).toBe(true);
    const parsed = JSON.parse(line);
    expect(parsed.type).toBe("session_meta");
    expect(parsed.payload.id).toBe(UUID);
    expect(parsed.payload.cwd).toBe(CWD);
    expect(parsed.payload.cli_version).toBe(CLI_VERSION);
    expect(parsed.payload.originator).toBe("codex_cli_rs");
    expect(parsed.payload.source).toBe("mcp");
    expect(parsed.payload.model_provider).toBe("openai");
  });
});

describe("codex-session sqlite + filesystem (Stage 5)", () => {
  let codexHome: string;

  beforeEach(async () => {
    codexHome = await makeCodexHome();
  });

  afterEach(async () => {
    // Best-effort cleanup; tmpdir entries are short-lived.
    try {
      await purgeSession(codexHome, UUID);
    } catch {
      // ignore
    }
  });

  test("tst_agent_unit_codex_session_005_lookup_empty_returns_false", () => {
    expect(lookupSession(codexHome, UUID)).toBe(false);
  });

  test("tst_agent_unit_codex_session_006_bootstrap_creates_row_and_file", async () => {
    await bootstrapSession({ codexHome, uuid: UUID, cwd: CWD, cliVersion: CLI_VERSION });

    expect(lookupSession(codexHome, UUID)).toBe(true);

    const db = new Database(codexStateDbPath(codexHome), { readonly: true });
    try {
      const row = db
        .query("SELECT id, rollout_path, cwd FROM threads WHERE id = ?")
        .get(UUID) as { id: string; rollout_path: string; cwd: string };
      expect(row.id).toBe(UUID);
      expect(row.cwd).toBe(CWD);
      expect(row.rollout_path).toContain(`-${UUID}.jsonl`);

      const fileContent = await readFile(row.rollout_path, "utf8");
      const meta = JSON.parse(fileContent.trim());
      expect(meta.payload.id).toBe(UUID);
    } finally {
      db.close();
    }
  });

  test("tst_agent_unit_codex_session_007_bootstrap_is_idempotent", async () => {
    await bootstrapSession({ codexHome, uuid: UUID, cwd: CWD, cliVersion: CLI_VERSION });
    // Second call must not throw (INSERT OR IGNORE) and must not
    // create a second row.
    await bootstrapSession({ codexHome, uuid: UUID, cwd: CWD, cliVersion: CLI_VERSION });

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

  test("tst_agent_unit_codex_session_008_purge_drops_row_and_file", async () => {
    await bootstrapSession({ codexHome, uuid: UUID, cwd: CWD, cliVersion: CLI_VERSION });

    // Capture rollout path before purge.
    const db = new Database(codexStateDbPath(codexHome), { readonly: true });
    const row = db
      .query("SELECT rollout_path FROM threads WHERE id = ?")
      .get(UUID) as { rollout_path: string };
    db.close();
    await access(row.rollout_path);

    await purgeSession(codexHome, UUID);

    expect(lookupSession(codexHome, UUID)).toBe(false);
    await expect(access(row.rollout_path)).rejects.toThrow();
  });

  test("tst_agent_unit_codex_session_009_purge_is_idempotent_for_missing_session", async () => {
    // Must not throw even though there is no row / file for UUID.
    await purgeSession(codexHome, UUID);
  });

  test("tst_agent_unit_codex_session_010_lookup_with_missing_state_db_returns_false", async () => {
    // Build a path that doesn't have a state_5.sqlite at all.
    const empty = await mkdtemp(join(tmpdir(), "magnis-codex-empty-"));
    expect(lookupSession(empty, UUID)).toBe(false);
  });

  test("tst_agent_unit_codex_session_011_purge_tolerates_missing_rollout_file", async () => {
    await bootstrapSession({ codexHome, uuid: UUID, cwd: CWD, cliVersion: CLI_VERSION });
    // Manually remove the rollout file out of band — purge must
    // still complete successfully.
    const db = new Database(codexStateDbPath(codexHome));
    const row = db
      .query("SELECT rollout_path FROM threads WHERE id = ?")
      .get(UUID) as { rollout_path: string };
    db.close();
    await writeFile(row.rollout_path, ""); // sanity: file exists
    await Bun.$`rm -f ${row.rollout_path}`;

    await purgeSession(codexHome, UUID);
    expect(lookupSession(codexHome, UUID)).toBe(false);
  });
});

describe("classifyCodexAttempt (R7 BLOCK 4 / INV-SESSION-5)", () => {
  test("tst_agent_unit_codex_attempt_decision_001_clean_exit_is_success", () => {
    expect(
      classifyCodexAttempt({
        attempt: 0,
        hasSessionId: true,
        streamErrored: false,
        producedEvents: false,
        exitCode: 0,
        stderr: "",
      }),
    ).toBe("success");
  });

  test("tst_agent_unit_codex_attempt_decision_002_produced_events_is_success_even_on_nonzero_exit", () => {
    // Codex exited non-zero but already produced model output —
    // treat as success; the failure was post-LLM.
    expect(
      classifyCodexAttempt({
        attempt: 0,
        hasSessionId: true,
        streamErrored: false,
        producedEvents: true,
        exitCode: 1,
        stderr: "warning: late shutdown",
      }),
    ).toBe("success");
  });

  test("tst_agent_unit_codex_attempt_decision_003_stream_errored_is_fatal", () => {
    expect(
      classifyCodexAttempt({
        attempt: 0,
        hasSessionId: true,
        streamErrored: true,
        producedEvents: false,
        exitCode: null,
        stderr: "no rollout found for thread id whatever",
      }),
    ).toBe("fatal");
  });

  test("tst_agent_unit_codex_attempt_decision_004_first_attempt_missing_rollout_retries", () => {
    expect(
      classifyCodexAttempt({
        attempt: 0,
        hasSessionId: true,
        streamErrored: false,
        producedEvents: false,
        exitCode: 2,
        stderr: "Error: thread/resume failed: no rollout found for thread id abc",
      }),
    ).toBe("retry_with_bootstrap");
  });

  test("tst_agent_unit_codex_attempt_decision_005_second_attempt_missing_rollout_falls_through", () => {
    // Same stderr, but attempt=1 (already retried once) → no more
    // retries; drop into R5 fall-through.
    expect(
      classifyCodexAttempt({
        attempt: 1,
        hasSessionId: true,
        streamErrored: false,
        producedEvents: false,
        exitCode: 2,
        stderr: "no rollout found for thread id abc",
      }),
    ).toBe("fall_through");
  });

  test("tst_agent_unit_codex_attempt_decision_006_first_attempt_non_rollout_error_falls_through", () => {
    // First attempt but stderr DOES NOT match the rollout pattern
    // — retry won't help; go straight to R5.
    expect(
      classifyCodexAttempt({
        attempt: 0,
        hasSessionId: true,
        streamErrored: false,
        producedEvents: false,
        exitCode: 1,
        stderr: "authentication required, please run codex login",
      }),
    ).toBe("fall_through");
  });

  test("tst_agent_unit_codex_attempt_decision_007_no_session_id_skips_retry", () => {
    // No session id (ad-hoc chat) → resume path doesn't apply, so
    // even a "missing rollout" stderr can't be retried via bootstrap.
    // Drop straight to fall-through.
    expect(
      classifyCodexAttempt({
        attempt: 0,
        hasSessionId: false,
        streamErrored: false,
        producedEvents: false,
        exitCode: 2,
        stderr: "no rollout found for thread id abc",
      }),
    ).toBe("fall_through");
  });
});

describe("codex-session lookupSession error semantics (R10)", () => {
  test("tst_agent_unit_codex_session_013_lookup_throws_on_permission_denied", async () => {
    // Create a state DB with no read permission. lookupSession must
    // SURFACE this (per CLAUDE.md "no fallbacks") instead of silently
    // returning false the way a missing-file path would.
    const home = await mkdtemp(join(tmpdir(), "magnis-codex-perm-"));
    const dbPath = codexStateDbPath(home);
    {
      // Initialize the DB with the threads schema, then chmod 000.
      const db = new Database(dbPath);
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
    }
    await Bun.$`chmod 000 ${dbPath}`;
    try {
      expect(() => lookupSession(home, UUID)).toThrow();
    } finally {
      // Restore so cleanup can run.
      await Bun.$`chmod 600 ${dbPath}`.nothrow();
    }
  });
});

describe("codex-session schema-drift detection (Stage 5 / risks)", () => {
  test("tst_agent_unit_codex_session_012_bootstrap_throws_on_unknown_required_column", async () => {
    // Stand up a CODEX_HOME with a `threads` table that has an EXTRA
    // NOT NULL column without a default — mirroring the failure mode
    // a future codex release could introduce. bootstrapSession's
    // INSERT must surface the error so the engine's fallback path
    // (R5) can take over instead of silently corrupting state.
    const home = await mkdtemp(join(tmpdir(), "magnis-codex-drift-"));
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
          "approval_mode TEXT NOT NULL," +
          // The drift: a NOT NULL column with no default that our
          // INSERT does not write.
          "new_required_column TEXT NOT NULL)",
      );
    } finally {
      db.close();
    }

    await expect(
      bootstrapSession({
        codexHome: home,
        uuid: UUID,
        cwd: CWD,
        cliVersion: CLI_VERSION,
      }),
    ).rejects.toThrow();
  });
});
