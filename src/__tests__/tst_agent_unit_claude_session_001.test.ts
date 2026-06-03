import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile, access } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import {
  buildClaudeArgs,
  claudeProjectSlug,
  claudeSessionPath,
  defaultClaudeSessionPath,
  purgeClaudeSession,
} from "../agent/claude/session";

const SESSION_ID = "11111111-2222-3333-4444-555555555555";

describe("claude-session pure helpers (Stage 4)", () => {
  // ── claudeProjectSlug ─────────────────────────────────────────────

  test("tst_agent_unit_claude_session_001_slug_replaces_slashes_with_dashes", () => {
    expect(claudeProjectSlug("/home/marketing/Coding/magnis-app")).toBe(
      "-home-marketing-Coding-magnis-app",
    );
  });

  test("tst_agent_unit_claude_session_001b_slug_handles_dot_directories", () => {
    // R11 regression — `.worktrees` becomes `--worktrees` (the
    // `/.` boundary produces a double dash); claude's actual
    // on-disk slug for this path.
    expect(
      claudeProjectSlug("/home/me/proj/.worktrees/dogfood/agent"),
    ).toBe("-home-me-proj--worktrees-dogfood-agent");
  });

  // ── claudeSessionPath ─────────────────────────────────────────────

  test("tst_agent_unit_claude_session_002_path_composes_home_and_slug", () => {
    expect(
      claudeSessionPath("/home/me", "/home/me/proj", SESSION_ID),
    ).toBe(`/home/me/.claude/projects/-home-me-proj/${SESSION_ID}.jsonl`);
  });

  // ── buildClaudeArgs ───────────────────────────────────────────────

  test("tst_agent_unit_claude_session_003_args_omit_session_id_when_absent", () => {
    const args = buildClaudeArgs({
      fullPrompt: "hi",
      systemPrompt: "system",
      maxSteps: 10,
      mcpConfig: "{}",
      model: "claude-opus-4-7",
    });
    expect(args).not.toContain("--session-id");
  });

  test("tst_agent_unit_claude_session_004_args_include_session_id_when_provided", () => {
    const args = buildClaudeArgs({
      fullPrompt: "hi",
      systemPrompt: "system",
      maxSteps: 10,
      mcpConfig: "{}",
      model: "claude-opus-4-7",
      engineSessionId: SESSION_ID,
    });
    // Default (resumeSession not set) → --session-id (fresh CREATE).
    expect(args).toContain("--session-id");
    expect(args).not.toContain("--resume");
    const i = args.indexOf("--session-id");
    expect(args[i + 1]).toBe(SESSION_ID);
  });

  test("tst_agent_unit_claude_session_004b_args_use_resume_when_session_already_exists", () => {
    // R11 fix: Claude Code's `--session-id <uuid>` is CREATE-only;
    // a second invocation errors with "Session ID is already in use".
    // When the rollout file is already on disk the caller sets
    // `resumeSession: true` and we must emit `--resume <uuid>` instead.
    const args = buildClaudeArgs({
      fullPrompt: "hi",
      systemPrompt: "system",
      maxSteps: 10,
      mcpConfig: "{}",
      model: "claude-opus-4-7",
      engineSessionId: SESSION_ID,
      resumeSession: true,
    });
    expect(args).toContain("--resume");
    expect(args).not.toContain("--session-id");
    const i = args.indexOf("--resume");
    expect(args[i + 1]).toBe(SESSION_ID);
  });

  test("tst_agent_unit_claude_session_005_args_ignore_empty_string_session_id", () => {
    const args = buildClaudeArgs({
      fullPrompt: "hi",
      systemPrompt: "system",
      maxSteps: 10,
      mcpConfig: "{}",
      model: "claude-opus-4-7",
      engineSessionId: "",
    });
    expect(args).not.toContain("--session-id");
  });

  // ── permission_mode mapping (INV-4) ───────────────────────────────

  test("tst_agent_unit_claude_session_020_full_mode_bypasses_permissions", () => {
    const args = buildClaudeArgs({
      fullPrompt: "hi",
      systemPrompt: "s",
      maxSteps: 10,
      mcpConfig: "{}",
      model: "m",
      permissionMode: "full",
    });
    expect(args).toContain("--permission-mode");
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("bypassPermissions");
    expect(args).toContain("--dangerously-skip-permissions");
    // full mode does NOT restrict to MCP-only and never denies tools
    expect(args).not.toContain("dontAsk");
    expect(args).not.toContain("--disallowedTools");
  });

  test("tst_agent_unit_claude_session_021_restricted_mode_mcp_only_no_bypass", () => {
    const args = buildClaudeArgs({
      fullPrompt: "hi",
      systemPrompt: "s",
      maxSteps: 10,
      mcpConfig: "{}",
      model: "m",
      mcpTools: "mcp__foo__*",
      permissionMode: "restricted",
    });
    expect(args).toContain("--permission-mode");
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("dontAsk");
    expect(args).not.toContain("--dangerously-skip-permissions");
    expect(args).not.toContain("bypassPermissions");
    // MCP tools pre-approved; shell/file mutation explicitly denied.
    expect(args).toContain("--allowedTools");
    expect(args[args.indexOf("--allowedTools") + 1]).toBe("mcp__foo__*");
    expect(args).toContain("--disallowedTools");
    expect(args).toContain("Bash");
    expect(args).toContain("Write");
    expect(args).toContain("Edit");
  });

  // ── model is optional (INV-2) ─────────────────────────────────────

  test("tst_agent_unit_claude_session_022_omit_model_flag_when_unset", () => {
    const args = buildClaudeArgs({
      fullPrompt: "hi",
      systemPrompt: "s",
      maxSteps: 10,
      mcpConfig: "{}",
      permissionMode: "full",
    });
    expect(args).not.toContain("--model");
  });

  // ── cwd-aware session path (INV-1) ────────────────────────────────

  test("tst_agent_unit_claude_session_023_default_path_uses_provided_cwd", () => {
    const p = defaultClaudeSessionPath(SESSION_ID, "/work/dir");
    expect(p).toContain("-work-dir");
    expect(p).toContain(`${SESSION_ID}.jsonl`);
  });

  // ── purgeClaudeSession ────────────────────────────────────────────

  test("tst_agent_unit_claude_session_006_purge_removes_existing_file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "magnis-claude-purge-"));
    const file = join(dir, "session.jsonl");
    await writeFile(file, "x");
    // sanity check: file is reachable before purge
    await access(file);

    await purgeClaudeSession(file);

    await expect(access(file)).rejects.toThrow();
  });

  test("tst_agent_unit_claude_session_007_purge_is_idempotent_for_missing_file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "magnis-claude-purge-"));
    const file = join(dir, "never-existed.jsonl");

    // Must not throw.
    await purgeClaudeSession(file);
  });
});
