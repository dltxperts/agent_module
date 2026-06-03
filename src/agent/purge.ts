/**
 * Engine-switch cleanup.
 *
 * When the backend's `build_sidecar_body` decides a turn is in
 * `cache_mode = "replay"` because the requested engine differs from
 * the engine that produced the episode's last non-NULL row, the
 * sidecar must purge the PREVIOUS engine's on-disk session under the
 * same episode UUID before the current engine bootstraps its own.
 * Otherwise the stale file / sqlite row lingers and INV-SESSION-9
 * ("the purged engine's session file / sqlite row is gone") fails.
 *
 * Each CLI engine (claude / codex) already purges its own session
 * before re-bootstrap; this helper handles the **cross-engine**
 * cleanup so claude.ts doesn't reach into codex internals and vice
 * versa.
 *
 * Plan: docs/plans/agent-persistent-sessions.md (R1, INV-SESSION-9).
 */

import {
  defaultClaudeSessionPath,
  purgeClaudeSession,
} from "./claude/session";
import {
  defaultCodexHome,
  purgeSession as purgeCodexSession,
} from "./codex/session";
import type { ClaudeProcessRegistry } from "./claude/types";
import type { CodexAppServerRegistry } from "./codex/types";

/**
 * Optional dependencies for testability + in-memory cleanup. The
 * engine layer wires the singleton registries through so a single
 * cross-engine purge can fan out to both the filesystem rollout AND
 * the in-memory process / thread state of the engine being torn down.
 */
export interface PurgeDeps {
  /**
   * When `previousEngine === "claude"` and provided, SIGTERM the
   * claude registry's process slot under `sessionId` (INV-STREAM-7).
   */
  claudeRegistry?: ClaudeProcessRegistry;
  /**
   * Explicit claude rollout path; defaults to
   * `defaultClaudeSessionPath(sessionId)`. Useful in tests where the
   * rollout lives under a tmpdir.
   */
  claudeSessionPath?: string;
  /**
   * When `previousEngine === "codex"` and provided, drop the session's
   * app-server thread so a switch-away doesn't leave a stale
   * long-lived thread (INV-CODEX-AS-7).
   */
  codexRegistry?: CodexAppServerRegistry;
  /**
   * Session working directory; used to resolve the claude rollout path
   * (INV-1) when `claudeSessionPath` is not given explicitly.
   */
  cwd?: string;
}

/**
 * Purge the session file / sqlite row of `previousEngine` (if any)
 * under `sessionId`. No-op when:
 *  - `previousEngine` is null/undefined (no prior turn, or prior
 *    turn used no CLI-backed engine);
 *  - `sessionId` is null/undefined (ad-hoc chat without an episode);
 *  - `previousEngine` is an unknown / non-CLI engine name.
 *
 * Idempotent on both sides — both `purgeClaudeSession` and
 * `purgeCodexSession` tolerate missing files / rows.
 */
export async function purgePreviousEngineSession(
  previousEngine: string | null | undefined,
  sessionId: string | null | undefined,
  deps: PurgeDeps = {},
): Promise<void> {
  if (!previousEngine || !sessionId) return;
  switch (previousEngine) {
    case "claude": {
      const path = deps.claudeSessionPath ?? defaultClaudeSessionPath(sessionId, deps.cwd);
      await purgeClaudeSession(path);
      // INV-STREAM-7: also drop the registry slot so a stale long-
      // lived claude process doesn't survive a switch-away.
      if (deps.claudeRegistry) {
        await deps.claudeRegistry.purge(sessionId);
      }
      break;
    }
    case "codex":
      await purgeCodexSession(defaultCodexHome(), sessionId);
      // INV-CODEX-AS-7: also forget the in-memory app-server thread.
      deps.codexRegistry?.dropThread(sessionId);
      break;
    default:
      // Unknown engine — no on-disk session to purge.
      break;
  }
}

/**
 * Tear down ALL engine state for `sessionId` regardless of which engine
 * last ran — claude rollout file + process slot AND codex thread +
 * rollout. Used by the session `reset` endpoint (INV-6) so a config
 * change (model / permission_mode / cwd) takes effect on the next run
 * via a fresh bootstrap. Idempotent: every step tolerates missing
 * files / rows / slots.
 */
export async function purgeAllEngineState(
  sessionId: string,
  deps: PurgeDeps = {},
): Promise<void> {
  const claudePath = deps.claudeSessionPath ?? defaultClaudeSessionPath(sessionId, deps.cwd);
  await purgeClaudeSession(claudePath);
  if (deps.claudeRegistry) await deps.claudeRegistry.purge(sessionId);

  await purgeCodexSession(defaultCodexHome(), sessionId);
  deps.codexRegistry?.dropThread(sessionId);
}
