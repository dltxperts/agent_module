/**
 * ClaudeProcessRegistry — bounded LRU pool of long-lived claude CLI
 * processes, keyed by engineSessionId.
 *
 * One slot per session. Subsequent `acquire(sid)` calls reuse the slot's
 * handle so consecutive turns talk to the same process (INV-STREAM-1).
 * When capacity is exceeded the least-recently-used slot is evicted —
 * SIGTERM, with a SIGKILL fallback after CLAUDE_PROCESS_EVICT_GRACE_MS
 * (INV-STREAM-8).
 *
 * Plan: docs/plans/claude-engine-stream-json.md Stage 1.
 */

import {
  spawn as nodeSpawn,
  type ChildProcess,
} from "child_process";
import type {
  ClaudeProcessRegistry,
  ClaudeRegistryDeps,
  ClaudeRegistryEntry,
  ProcessHandle,
  SpawnConfig,
} from "./types";

const DEFAULT_CAPACITY = 8;
const DEFAULT_KILL_GRACE_MS = 2_000;
const BINARY_NAME = "claude";

/**
 * Lazily-constructed process-wide registry singleton. Wired with env
 * knobs `CLAUDE_PROCESS_POOL_SIZE` and `CLAUDE_PROCESS_IDLE_MS`. When
 * `CLAUDE_PROCESS_IDLE_MS` is set to a positive integer, an unref'd
 * `setInterval` calls `sweepIdle()` every `idleMs / 2` so the
 * production agent reclaims forgotten sessions without a manual
 * sweep.
 */
let defaultClaudeRegistry: ClaudeProcessRegistry | null = null;
export function getDefaultClaudeRegistry(): ClaudeProcessRegistry {
  if (defaultClaudeRegistry) return defaultClaudeRegistry;
  const capacityEnv = parseInt(process.env.CLAUDE_PROCESS_POOL_SIZE ?? "", 10);
  const idleEnv = parseInt(process.env.CLAUDE_PROCESS_IDLE_MS ?? "", 10);
  const capacity =
    Number.isFinite(capacityEnv) && capacityEnv > 0
      ? capacityEnv
      : DEFAULT_CAPACITY;
  const idleMs =
    Number.isFinite(idleEnv) && idleEnv > 0 ? idleEnv : undefined;
  defaultClaudeRegistry = createClaudeProcessRegistry({ capacity, idleMs });
  if (idleMs) {
    const t = setInterval(
      () => defaultClaudeRegistry?.sweepIdle(),
      Math.max(1_000, Math.floor(idleMs / 2)),
    );
    if (typeof (t as { unref?: () => void }).unref === "function") {
      (t as { unref: () => void }).unref();
    }
  }
  return defaultClaudeRegistry;
}

function killGracefully(
  child: ChildProcess,
  graceMs: number,
): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    child.once("close", settle);
    try {
      child.kill("SIGTERM");
    } catch {
      settle();
      return;
    }
    const t = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // process already gone — fine
      }
      settle();
    }, graceMs);
    // Prevent the timer from holding the event loop open.
    if (typeof (t as { unref?: () => void }).unref === "function") {
      (t as { unref: () => void }).unref();
    }
  });
}

export function createClaudeProcessRegistry(
  deps: ClaudeRegistryDeps = {},
): ClaudeProcessRegistry {
  const spawnFn = deps.spawn ?? nodeSpawn;
  const now = deps.now ?? (() => Date.now());
  const capacity = deps.capacity ?? DEFAULT_CAPACITY;
  const killGraceMs = deps.killGraceMs ?? DEFAULT_KILL_GRACE_MS;

  // Map preserves insertion order. We use that order as LRU: oldest
  // entry first, most-recently-used at the tail. To "touch" a slot we
  // delete + reinsert.
  const slots = new Map<string, ClaudeRegistryEntry>();

  function evictOne(): void {
    const oldest = slots.keys().next();
    if (oldest.done) return;
    const sid = oldest.value;
    const entry = slots.get(sid);
    if (!entry) {
      slots.delete(sid);
      return;
    }
    slots.delete(sid);
    // Fire-and-forget kill; the caller doesn't await eviction.
    void killGracefully(entry.child, killGraceMs);
  }

  function touch(entry: ClaudeRegistryEntry): void {
    entry.lastUsedAt = now();
    slots.delete(entry.sessionId);
    slots.set(entry.sessionId, entry);
  }

  return {
    acquire(sessionId: string, config: SpawnConfig): ProcessHandle {
      const existing = slots.get(sessionId);
      if (existing) {
        touch(existing);
        return existing.handle;
      }

      while (slots.size >= capacity) {
        evictOne();
      }

      const child = spawnFn(BINARY_NAME, config.args, {
        stdio: ["pipe", "pipe", "pipe"],
        cwd: config.cwd,
        env: config.env,
      });
      const handle: ProcessHandle = { sessionId, child };
      const entry: ClaudeRegistryEntry = {
        sessionId,
        child,
        lastUsedAt: now(),
        handle,
      };
      slots.set(sessionId, entry);
      return handle;
    },

    has(sessionId: string): boolean {
      return slots.has(sessionId);
    },

    async purge(sessionId: string): Promise<void> {
      const entry = slots.get(sessionId);
      if (!entry) return;
      slots.delete(sessionId);
      await killGracefully(entry.child, killGraceMs);
    },

    sweepIdle(): void {
      if (!deps.idleMs || deps.idleMs <= 0) return;
      const cutoff = now() - deps.idleMs;
      // Iterate a snapshot — entries get deleted as we go.
      const ids: string[] = [];
      for (const [sid, e] of slots) {
        if (e.lastUsedAt < cutoff) ids.push(sid);
      }
      for (const sid of ids) {
        const e = slots.get(sid);
        if (!e) continue;
        slots.delete(sid);
        void killGracefully(e.child, killGraceMs);
      }
    },
  };
}
