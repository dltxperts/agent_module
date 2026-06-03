/**
 * Claude Code persistent-session helpers.
 *
 * Pure path / args utilities + a thin filesystem `purge` so the
 * spawning engine stays declarative: build args, optionally purge,
 * then spawn.
 *
 * Plan: docs/plans/agent-persistent-sessions.md (Stage 4).
 * Invariants: INV-SESSION-1 (--session-id on every spawn when
 * engineSessionId is provided), INV-SESSION-9 (purge before bootstrap
 * on cache_mode = "replay").
 */

import { homedir } from "os";
import { join } from "path";
import { unlink } from "fs/promises";
import type { ClaudeArgsInput, ClaudePreSpawnInput } from "./types";

/**
 * Convert a working directory into Claude Code's project-folder slug.
 * Claude stores per-cwd sessions under `~/.claude/projects/<slug>/`,
 * where `<slug>` is the absolute cwd with BOTH `/` AND `.` replaced
 * by `-`. So `/home/me/proj/.worktrees/x/agent` becomes
 * `-home-me-proj--worktrees-x-agent` (the `/.` boundary produces a
 * double dash). R11 fix: the original implementation missed the
 * dot translation, which silently mis-resolved session paths for
 * any worktree under a dot-prefixed directory and broke
 * `--resume` detection (existsSync returned false → second turn
 * used `--session-id` → "already in use" error).
 *
 * Pure: no I/O.
 */
export function claudeProjectSlug(cwd: string): string {
  return cwd.replace(/[/.]/g, "-");
}

/**
 * Absolute path of the JSONL session file that Claude Code uses
 * (creates on first turn, resumes on subsequent turns) for a given
 * session UUID running in `cwd`.
 *
 * Pure: composes `homedir() + .claude/projects/<slug>/<uuid>.jsonl`.
 * `homedir()` is treated as the environment input and made explicit
 * for testability.
 */
export function claudeSessionPath(
  homeDir: string,
  cwd: string,
  sessionId: string,
): string {
  const slug = claudeProjectSlug(cwd);
  return join(homeDir, ".claude", "projects", slug, `${sessionId}.jsonl`);
}

/**
 * Effective `$HOME` resolution: prefer the live `process.env.HOME`
 * value so a test that overrides it is honored; fall back to the
 * runtime's `homedir()` (passwd-based) otherwise. Node honors `HOME`
 * inside `os.homedir()` on POSIX, but Bun appears to cache the
 * result on first access — using the env var directly avoids that
 * trap and matches what Claude Code itself does when it resolves
 * `~/.claude/`.
 */
function effectiveHomeDir(): string {
  return process.env.HOME ?? homedir();
}

/**
 * Resolved session path using the live `$HOME` and the session's
 * working directory. `cwd` defaults to `process.cwd()` only when the
 * caller has no session cwd (ad-hoc); the engine always passes the
 * session's `cwd` so claude resolves the rollout under the correct
 * project slug (INV-1).
 */
export function defaultClaudeSessionPath(sessionId: string, cwd?: string): string {
  return claudeSessionPath(effectiveHomeDir(), cwd ?? process.cwd(), sessionId);
}

/**
 * Delete the rollout file for `sessionPath`. Idempotent — a missing
 * file is success (e.g. when the engine label changed but no prior
 * claude session ever existed). Used on `cache_mode = "replay"` to
 * guarantee Claude Code creates a fresh session under the same UUID
 * instead of resuming a stale one (INV-SESSION-9).
 */
export async function purgeClaudeSession(sessionPath: string): Promise<void> {
  try {
    await unlink(sessionPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return;
    throw err;
  }
}

/**
 * Pre-spawn cleanup for `ClaudeEngine.stream`. Pulled out so the
 * INV-SESSION-9 call-site dispatch (replay → purge; resume →
 * nothing) is unit-testable without spawning a real `claude` CLI.
 *
 * On `cacheMode === "replay"` and a non-null `sessionId`:
 *  1. Purge the PREVIOUS engine's session under the same UUID
 *     (cross-engine cleanup).
 *  2. Delete this engine's own rollout file so claude creates a
 *     fresh session under the same `--session-id`.
 *
 * Best-effort: warnings logged via `onWarn` if either purge throws,
 * but the function never rethrows. Plan:
 * docs/plans/agent-persistent-sessions.md (R10, INV-SESSION-9).
 */
export async function claudePreSpawnCleanup(
  input: ClaudePreSpawnInput,
  // Test seam: defaults to console.warn but tests can record calls.
  onWarn: (msg: string, err: unknown) => void = (msg, err) =>
    console.warn(msg, err),
): Promise<void> {
  if (!input.sessionId || input.cacheMode !== "replay") return;

  // Lazy import to avoid a static cycle between claude-session and
  // cross-engine-purge (which imports purgeClaudeSession from here).
  const { purgePreviousEngineSession } = await import("../purge");
  const { getDefaultClaudeRegistry } = await import(
    "./registry"
  );
  const { getDefaultCodexRegistry } = await import(
    "../codex/registry"
  );

  try {
    // Feed BOTH registries through so the cross-engine purge can tear
    // down whichever engine produced the prior turn: SIGTERM a stale
    // claude process (INV-STREAM-7) or drop codex's app-server thread
    // (INV-CODEX-AS-7).
    await purgePreviousEngineSession(input.previousEngine, input.sessionId, {
      claudeRegistry: getDefaultClaudeRegistry(),
      codexRegistry: getDefaultCodexRegistry(),
      cwd: input.cwd,
    });
  } catch (err) {
    onWarn(
      `[ClaudeEngine] cross-engine purge for ${input.sessionId} (prev=${input.previousEngine}) failed; continuing:`,
      err,
    );
  }
  const sessionPath = defaultClaudeSessionPath(input.sessionId, input.cwd);
  try {
    await purgeClaudeSession(sessionPath);
  } catch (err) {
    onWarn(
      `[ClaudeEngine] purge_session(${sessionPath}) failed; resume will be attempted anyway:`,
      err,
    );
  }
}

/**
 * Build the `claude` CLI argv. Pure: returns a fresh array, no I/O.
 *
 * Order is fixed for ease of inspection in tests — keep stable.
 * INV-SESSION-1: when `engineSessionId` is provided, the args
 * contain either `--session-id <uuid>` (fresh create) or
 * `--resume <uuid>` (continue existing). Caller picks based on
 * whether the rollout file already exists.
 */
/**
 * Map a session `permission_mode` onto claude CLI permission flags
 * (verified against claude 2.1.161). Pure: returns a fresh array.
 *
 *  - `"full"`: bypass all permission checks — agent may use every
 *    built-in tool (Bash/Write/Edit) plus MCP. No `--tools` restriction.
 *  - `"restricted"` (default): pre-approve ONLY the configured MCP
 *    tools (`--allowedTools <scope>`), explicitly deny shell / file
 *    mutation / network, and run `--permission-mode dontAsk` so any
 *    other tool call is denied without an (impossible, no-TTY) prompt.
 *
 * INV-4. The exact mode names + flag semantics were confirmed via
 * `claude --help` (permission-mode choices include dontAsk;
 * --allowedTools/--disallowedTools are variadic).
 */
export function claudePermissionArgs(
  mode: "restricted" | "full" | undefined,
  mcpToolScope: string,
): string[] {
  if (mode === "full") {
    return [
      "--permission-mode",
      "bypassPermissions",
      "--dangerously-skip-permissions",
    ];
  }
  return [
    "--allowedTools",
    mcpToolScope,
    "--disallowedTools",
    "Bash",
    "Edit",
    "Write",
    "NotebookEdit",
    "WebFetch",
    "--permission-mode",
    "dontAsk",
  ];
}

export function buildClaudeArgs(input: ClaudeArgsInput): string[] {
  const args = ["-p", input.fullPrompt, "--verbose", "--output-format", "stream-json"];
  // INV-3: omit --system-prompt entirely when the session sets none.
  if (input.systemPrompt) args.push("--system-prompt", input.systemPrompt);
  args.push(
    "--max-turns",
    String(Math.min(input.maxSteps, 30)),
    "--mcp-config",
    input.mcpConfig,
    "--strict-mcp-config",
    ...claudePermissionArgs(input.permissionMode, input.mcpTools ?? "mcp__*"),
  );
  // INV-2: only pass --model when the session resolved one; otherwise
  // let the claude CLI use its configured default.
  if (input.model) args.push("--model", input.model);
  if (input.engineSessionId) {
    if (input.resumeSession) {
      args.push("--resume", input.engineSessionId);
    } else {
      args.push("--session-id", input.engineSessionId);
    }
  }
  return args;
}
