/**
 * Codex persistent-session helpers.
 *
 * Codex CLI does not accept `--session-id` on `codex exec`; sessions
 * are looked up by UUID through a sqlite index at
 * `$CODEX_HOME/state_5.sqlite` (`threads` table). To resume a session
 * under a UUID we choose, we have to bootstrap the row + rollout
 * file ourselves the first time we see that UUID, then call
 * `codex exec resume <uuid>` on every turn.
 *
 * Plan: docs/plans/agent-persistent-sessions.md (Stage 5).
 * Invariants: INV-SESSION-1 (`resume <uuid>` on every spawn),
 * INV-SESSION-4 (one row + one rollout file per (episode, engine)),
 * INV-SESSION-9 (purge before bootstrap on cache_mode = "replay").
 */

import { Database } from "bun:sqlite";
import { existsSync } from "fs";
import { mkdir, unlink, writeFile } from "fs/promises";
import { homedir } from "os";
import { dirname, join } from "path";
import { spawnSync } from "child_process";
import type {
  CodexAttemptDecision,
  CodexAttemptOutcome,
  CodexPreSpawnInput,
} from "./types";

/**
 * Resolve `$CODEX_HOME` from the env, defaulting to `~/.codex`.
 * Override path is honored verbatim — no validation here.
 */
export function defaultCodexHome(): string {
  return process.env.CODEX_HOME ?? join(homedir(), ".codex");
}

/** Absolute path of the codex sqlite index that owns `threads`. */
export function codexStateDbPath(codexHome: string): string {
  return join(codexHome, "state_5.sqlite");
}

/**
 * Build the argv for `codex exec` (when no session) or
 * `codex exec resume <uuid>` (when an engine session id is provided).
 * Pure: returns a fresh array, no I/O.
 *
 * INV-SESSION-1: when `engineSessionId` is provided, the argv starts
 * with `exec resume <uuid>` so codex looks up the rollout file via
 * the `threads` index.
 */
/**
 * Map a session `permission_mode` onto codex `exec` sandbox/approval
 * flags (verified against codex-cli 0.134.0 `codex exec --help`).
 *
 *  - `"full"`: `--dangerously-bypass-approvals-and-sandbox` (full host
 *    access, no prompts).
 *  - `"restricted"` (default): `--sandbox read-only` — model-generated
 *    shell is sandboxed read-only; MCP tools still run. No bypass.
 *
 * INV-4. Plus optional `--model <m>` (INV-2) when the session set one.
 */
export function buildCodexExecArgs(input: {
  fullPrompt: string;
  engineSessionId?: string | null;
  model?: string;
  permissionMode?: "restricted" | "full";
}): string[] {
  const permission =
    input.permissionMode === "full"
      ? ["--dangerously-bypass-approvals-and-sandbox"]
      : ["--sandbox", "read-only"];
  const model = input.model ? ["--model", input.model] : [];
  if (input.engineSessionId) {
    return [
      "exec",
      "resume",
      ...permission,
      ...model,
      "--json",
      input.engineSessionId,
      input.fullPrompt,
    ];
  }
  return ["exec", ...permission, ...model, "--json", input.fullPrompt];
}

/**
 * Memoized `codex --version` lookup. Codex stamps this into the
 * `session_meta.cli_version` field on bootstrap; running codex never
 * changes mid-process, so we cache the first result. Returns
 * `"unknown"` if codex is not on PATH or the version line is
 * unparseable (operator's responsibility to fix).
 */
let cachedCodexCliVersion: string | null = null;
export function readCodexCliVersion(codexBin = "codex"): string {
  if (cachedCodexCliVersion) return cachedCodexCliVersion;
  try {
    const result = spawnSync(codexBin, ["--version"], { encoding: "utf8" });
    if (result.status === 0) {
      const match = result.stdout.match(/(\d+\.\d+\.\d+)/);
      cachedCodexCliVersion = match?.[1] ?? "unknown";
    } else {
      cachedCodexCliVersion = "unknown";
    }
  } catch {
    cachedCodexCliVersion = "unknown";
  }
  return cachedCodexCliVersion;
}

/** Test-only hook to clear the memoized version between cases. */
export function _resetCodexCliVersionCache(): void {
  cachedCodexCliVersion = null;
}

/**
 * Pre-spawn lifecycle for `CodexEngine.stream`. On `cacheMode =
 * "replay"`: cross-engine purge of any prior engine's session
 * (e.g. claude → codex switch deletes the claude rollout file)
 * THEN purge this episode's own codex row + file. On either mode,
 * if no codex `threads` row exists for the session UUID, bootstrap
 * one so `codex exec resume <uuid>` has somewhere to land.
 *
 * Best-effort: warnings logged via `onWarn` if any step throws, but
 * the function never rethrows. Plan:
 * docs/plans/agent-persistent-sessions.md (R10, INV-SESSION-9 /
 * INV-SESSION-4).
 */
export async function codexPreSpawnLifecycle(
  input: CodexPreSpawnInput,
  onWarn: (msg: string, err: unknown) => void = (msg, err) =>
    console.warn(msg, err),
): Promise<void> {
  if (!input.sessionId) return;

  const codexHome = defaultCodexHome();

  if (input.cacheMode === "replay") {
    const { purgePreviousEngineSession } = await import("../purge");
    const { getDefaultClaudeRegistry } = await import(
      "../claude/registry"
    );
    try {
      // INV-STREAM-7: on codex→? switch we must also SIGTERM any
      // long-lived claude process under the same sessionId, not just
      // purge codex's sqlite row.
      await purgePreviousEngineSession(input.previousEngine, input.sessionId, {
        claudeRegistry: getDefaultClaudeRegistry(),
      });
    } catch (err) {
      onWarn(
        `[CodexEngine] cross-engine purge for ${input.sessionId} (prev=${input.previousEngine}) failed; continuing:`,
        err,
      );
    }
    try {
      await purgeSession(codexHome, input.sessionId);
    } catch (err) {
      onWarn(
        `[CodexEngine] purge_session(${input.sessionId}) failed; will retry bootstrap:`,
        err,
      );
    }
  }

  if (!lookupSession(codexHome, input.sessionId)) {
    try {
      await bootstrapSession({
        codexHome,
        uuid: input.sessionId,
        cwd: input.cwd,
        cliVersion: readCodexCliVersion(input.codexBin),
      });
    } catch (err) {
      onWarn(
        `[CodexEngine] bootstrap_session(${input.sessionId}) failed; codex resume will likely error:`,
        err,
      );
    }
  }
}

/**
 * Classifier for stderr output from a failed `codex exec resume <uuid>`
 * invocation. Returns `true` iff codex reports the rollout file is
 * missing for the requested thread id — the exact failure mode where
 * INV-SESSION-5 mandates a single re-bootstrap + retry.
 *
 * Matches codex 0.133.0 phrasing
 * (`Error: thread/resume: thread/resume failed: no rollout found for thread id <uuid>`)
 * loosely so minor wording bumps in future codex versions still trigger
 * the same fallback path. Pure: no I/O.
 */
export function isCodexMissingRolloutError(stderr: string): boolean {
  if (!stderr) return false;
  return /no rollout found for thread id/i.test(stderr);
}

/**
 * Decision the codex resume loop makes after one spawn iteration.
 * Pure function over the observable outcome of an attempt; the
 * effectful loop in `CodexEngine.stream` dispatches on this value.
 * Lets us unit-test the branch logic of INV-SESSION-5 (retry + R5
 * fall-through) without mocking `child_process.spawn`.
 *
 * Plan: docs/plans/agent-persistent-sessions.md (R7 BLOCK 4,
 * INV-SESSION-5).
 */
/**
 * Map the observable outcome of one resume attempt to the next step:
 *
 *  - `"success"`: emit `done`, return.
 *  - `"retry_with_bootstrap"`: only on attempt 0 + sessionId present
 *    + stderr matched the missing-rollout classifier; purge +
 *    re-bootstrap and try once more (the loop's `attempt++ + continue`).
 *  - `"fall_through"`: resume is exhausted; drop into R5 plain
 *    `codex exec <prompt>` for a degraded but non-empty response.
 *  - `"fatal"`: `parseStream` itself threw (network / pipe / parser
 *    error). Surface immediately; no retry will help.
 */
export function classifyCodexAttempt(outcome: CodexAttemptOutcome): CodexAttemptDecision {
  if (outcome.streamErrored) return "fatal";
  if (outcome.exitCode === 0 || outcome.producedEvents) return "success";
  if (
    outcome.attempt === 0 &&
    outcome.hasSessionId &&
    isCodexMissingRolloutError(outcome.stderr)
  ) {
    return "retry_with_bootstrap";
  }
  return "fall_through";
}

/**
 * Build the rollout-file path codex expects for a session created at
 * `isoTimestamp` with id `uuid`. Pure: no I/O.
 *
 * Format (observed on codex 0.133.0):
 *   `<CODEX_HOME>/sessions/<YYYY>/<MM>/<DD>/rollout-<YYYY-MM-DD>T<HH-MM-SS>-<uuid>.jsonl`
 *
 * The time portion uses `-` instead of `:` and drops fractional
 * seconds / the trailing `Z`.
 */
export function codexRolloutPath(
  codexHome: string,
  isoTimestamp: string,
  uuid: string,
): string {
  // 2026-05-26T18:38:06.123Z → 2026-05-26T18:38:06 → split into date+time parts.
  const trimmed = isoTimestamp.replace(/\.\d+Z?$/, "").replace(/Z$/, "");
  const [datePart, timePart] = trimmed.split("T");
  if (!datePart || !timePart) {
    throw new Error(`codexRolloutPath: malformed ISO timestamp '${isoTimestamp}'`);
  }
  const [yyyy, mm, dd] = datePart.split("-");
  const cleanTime = timePart.replace(/:/g, "-");
  return join(
    codexHome,
    "sessions",
    yyyy,
    mm,
    dd,
    `rollout-${datePart}T${cleanTime}-${uuid}.jsonl`,
  );
}

/** Build the minimal `session_meta` JSON line codex needs on resume. */
export function buildSessionMeta(input: {
  uuid: string;
  isoTimestamp: string;
  cwd: string;
  cliVersion: string;
}): string {
  const payload = {
    timestamp: input.isoTimestamp,
    type: "session_meta",
    payload: {
      id: input.uuid,
      timestamp: input.isoTimestamp,
      cwd: input.cwd,
      originator: "codex_cli_rs",
      cli_version: input.cliVersion,
      source: "mcp",
      model_provider: "openai",
    },
  };
  return JSON.stringify(payload) + "\n";
}

/**
 * Returns `true` iff a `threads` row keyed by `uuid` already exists
 * in the codex sqlite index. A `true` result means we can call
 * `codex exec resume <uuid>` directly; `false` means the session
 * must be bootstrapped first.
 *
 * Missing state DB (`ENOENT` — fresh codex install before its own
 * first run) returns `false` cleanly. Other open failures
 * (permission denied, corrupt db, IO error) THROW so the engine's
 * INV-SESSION-5 fallback path can act on the real cause instead of
 * silently swallowing it. Plan: docs/plans/agent-persistent-sessions.md
 * (R10 — addresses round-2 Codex QUESTION).
 */
export function lookupSession(codexHome: string, uuid: string): boolean {
  const dbPath = codexStateDbPath(codexHome);
  let db: Database;
  try {
    db = new Database(dbPath, { readonly: true });
  } catch (err) {
    if (isMissingFileError(err, dbPath)) return false;
    throw err;
  }
  try {
    const row = db.query("SELECT 1 FROM threads WHERE id = ?").get(uuid);
    return row != null;
  } finally {
    db.close();
  }
}

/**
 * Distinguish "file genuinely absent" (bun:sqlite raises SQLITE_CANTOPEN
 * → code 14 → ENOENT on disk) from "file present but unreadable"
 * (permission denied, corrupt header, etc.). bun:sqlite errors carry
 * a `code` string AND embed the path in the message; we check both.
 */
function isMissingFileError(err: unknown, dbPath: string): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { code?: string; errno?: number; message?: string };
  if (e.code === "ENOENT") return true;
  if (e.errno === -2) return true;
  if (typeof e.message === "string") {
    // bun:sqlite phrasing: "unable to open database file" + path.
    // Confirm with a filesystem check — if the file is absent,
    // treat as missing; otherwise the open failure is something
    // else (permissions, lock, etc.) and must surface.
    if (
      /unable to open database file/i.test(e.message) &&
      !existsSync(dbPath)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Create the minimum-viable codex session for `uuid`: the rollout
 * JSONL file with one `session_meta` line and the matching row in
 * `state_5.sqlite/threads`. Idempotent via `INSERT OR IGNORE` — a
 * repeated bootstrap for the same UUID is a no-op on the DB side.
 * The rollout file is overwritten each call (codex appends to it on
 * resume, so a "blank slate" is the safe default).
 *
 * Plan: INV-SESSION-4.
 */
export async function bootstrapSession(input: {
  codexHome: string;
  uuid: string;
  cwd: string;
  cliVersion: string;
}): Promise<void> {
  const now = new Date();
  const isoTimestamp = now.toISOString();
  const rolloutPath = codexRolloutPath(input.codexHome, isoTimestamp, input.uuid);

  await mkdir(dirname(rolloutPath), { recursive: true });
  await writeFile(
    rolloutPath,
    buildSessionMeta({
      uuid: input.uuid,
      isoTimestamp,
      cwd: input.cwd,
      cliVersion: input.cliVersion,
    }),
  );

  const epochSeconds = Math.floor(now.getTime() / 1000);
  const db = new Database(codexStateDbPath(input.codexHome));
  try {
    // ON CONFLICT(id) DO NOTHING keeps idempotency for repeated
    // bootstraps with the same UUID (turn-2 path through the engine
    // is allowed to re-call bootstrapSession) WITHOUT swallowing
    // unrelated constraint violations the way `INSERT OR IGNORE`
    // would. If the codex schema drifts (extra NOT NULL column with
    // no default), this INSERT now throws and the engine's
    // INV-SESSION-5 fallback path can take over instead of writing
    // a silently-orphaned rollout file.
    db.run(
      "INSERT INTO threads(id, rollout_path, created_at, updated_at, source, model_provider, cwd, title, sandbox_policy, approval_mode) " +
        "VALUES(?, ?, ?, ?, 'mcp', 'openai', ?, ?, 'workspace-write', 'on-request') " +
        "ON CONFLICT(id) DO NOTHING",
      [
        input.uuid,
        rolloutPath,
        epochSeconds,
        epochSeconds,
        input.cwd,
        "agent session",
      ],
    );
  } finally {
    db.close();
  }
}

/**
 * Remove the codex session for `uuid` entirely: drop the row in
 * `threads` and unlink the rollout file. Idempotent on both fronts
 * — missing row / missing file are tolerated. Used on engine switch
 * before re-bootstrapping under the same UUID (INV-SESSION-9).
 */
export async function purgeSession(codexHome: string, uuid: string): Promise<void> {
  const dbPath = codexStateDbPath(codexHome);
  let rolloutPath: string | null = null;

  let db: Database;
  try {
    db = new Database(dbPath);
  } catch {
    // No state DB at all → nothing to purge.
    return;
  }
  try {
    // A freshly-created (or pre-schema) state DB has no `threads`
    // table yet — nothing to purge. Honor the idempotency contract
    // rather than throwing "no such table: threads".
    const hasThreads = db
      .query(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='threads'",
      )
      .get();
    if (hasThreads) {
      const row = db
        .query("SELECT rollout_path FROM threads WHERE id = ?")
        .get(uuid) as { rollout_path: string } | null;
      rolloutPath = row?.rollout_path ?? null;
      db.run("DELETE FROM threads WHERE id = ?", [uuid]);
    }
  } finally {
    db.close();
  }

  if (rolloutPath) {
    try {
      await unlink(rolloutPath);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") throw err;
    }
  }
}
