/**
 * R10 / INV-SESSION-5 — end-to-end behavioural test of the codex R5
 * fall-through path WITHOUT depending on a real codex CLI.
 *
 * Uses `fixtures/fake-codex-fallback.sh` injected via `CODEX_BIN`.
 * The fake CLI fails `codex exec resume <uuid>` twice (with the
 * missing-rollout stderr) and then succeeds on the plain
 * `codex exec <prompt>` invocation. The engine should:
 *   1. Yield exactly ONE `{type:"warning", code:"codex_session_replay"}`
 *      event before the fallback spawn (BLOCK 3 from round-2 review).
 *   2. Yield the agent_message text from the fallback exec.
 *   3. Yield `done` with the accumulated content.
 *   4. NOT yield any `error` event on the success path.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";

import { CodexEngine } from "../agent/codex/codex";
import { codexStateDbPath } from "../agent/codex/session";
import type { StreamEvent } from "../agent/types";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FAKE_CODEX = resolve(__dirname, "fixtures", "fake-codex-fallback.sh");

const UUID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

async function seedCodexHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "magnis-r10-cf-"));
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

describe("CodexEngine R5 fall-through (R10 / INV-SESSION-5)", () => {
  let savedCodexBin: string | undefined;
  let savedCodexHome: string | undefined;
  let savedFakeStateDir: string | undefined;
  let codexHome: string;
  let fakeStateDir: string;

  beforeEach(async () => {
    savedCodexBin = process.env.CODEX_BIN;
    savedCodexHome = process.env.CODEX_HOME;
    savedFakeStateDir = process.env.FAKE_CODEX_STATE_DIR;

    codexHome = await seedCodexHome();
    fakeStateDir = await mkdtemp(join(tmpdir(), "magnis-r10-cf-state-"));

    process.env.CODEX_BIN = FAKE_CODEX;
    process.env.CODEX_HOME = codexHome;
    process.env.FAKE_CODEX_STATE_DIR = fakeStateDir;
  });

  afterEach(async () => {
    if (savedCodexBin === undefined) delete process.env.CODEX_BIN;
    else process.env.CODEX_BIN = savedCodexBin;
    if (savedCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = savedCodexHome;
    if (savedFakeStateDir === undefined) delete process.env.FAKE_CODEX_STATE_DIR;
    else process.env.FAKE_CODEX_STATE_DIR = savedFakeStateDir;

    await rm(codexHome, { recursive: true, force: true });
    await rm(fakeStateDir, { recursive: true, force: true });
  });

  test("tst_agent_unit_codex_fallback_001_emits_warning_then_runs_plain_exec", async () => {
    // This exercises the legacy `codex exec` resume + R5 fall-through,
    // so request legacy mode explicitly (app-server is the default).
    const engine = new CodexEngine({ mode: "legacy" });
    const events: StreamEvent[] = [];

    for await (const ev of engine.stream({
      messages: [{ role: "user", content: "hello" }],
      systemPrompt: "system",
      maxSteps: 5,
      engineSessionId: UUID,
      cacheMode: "replay",
      previousEngine: null,
    })) {
      events.push(ev);
    }

    const warnings = events.filter((e) => e.type === "warning");
    expect(warnings).toHaveLength(1);
    const w = warnings[0] as Extract<StreamEvent, { type: "warning" }>;
    expect(w.code).toBe("codex_session_replay");
    expect(w.message.length).toBeGreaterThan(0);

    // Fallback spawn produced an agent_message → delta event.
    const deltas = events.filter((e) => e.type === "delta");
    expect(deltas.length).toBeGreaterThan(0);

    // Stream terminated cleanly.
    const done = events.filter((e) => e.type === "done");
    expect(done).toHaveLength(1);

    // No error event on the success-path fall-through.
    const errors = events.filter((e) => e.type === "error");
    expect(errors).toHaveLength(0);
  });
});
