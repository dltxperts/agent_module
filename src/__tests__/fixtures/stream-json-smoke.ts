#!/usr/bin/env bun
/**
 * Manual smoke test for the Claude CLI stream-json bidi protocol.
 * Not part of CI. Run with:
 *
 *   unset ANTHROPIC_API_KEY
 *   bun run src/__tests__/fixtures/stream-json-smoke.ts
 *
 * What it proves:
 *  1. One claude process can serve multiple turns over a single stdin pipe.
 *  2. Subscription auth (~/.claude.json) is used; ANTHROPIC_API_KEY unset.
 *  3. Memory across turns survives without --resume (process stays alive).
 *  4. session_id is emitted in `system/init`.
 *
 * Original recon: docs/plans/claude-engine-stream-json.md (smoke test
 * referenced in section 1 "Motivation").
 */

import { spawn } from "child_process";
import { homedir } from "os";
import { existsSync } from "fs";

const apiKeySet = !!process.env.ANTHROPIC_API_KEY;
const claudeJsonExists = existsSync(`${homedir()}/.claude.json`);

console.log("=== Env preflight ===");
console.log(`ANTHROPIC_API_KEY set?  ${apiKeySet}`);
console.log(`~/.claude.json exists?  ${claudeJsonExists}`);
console.log("");

if (apiKeySet) {
  console.error(
    "ABORT: ANTHROPIC_API_KEY is set — would mask the subscription path. Unset it and retry.",
  );
  process.exit(2);
}

const args = [
  "--print",
  "--verbose",
  "--input-format",
  "stream-json",
  "--output-format",
  "stream-json",
  "--model",
  "claude-haiku-4-5-20251001",
];
console.log(`Spawning: claude ${args.join(" ")}`);

const child = spawn("claude", args, {
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env },
});
const initialPid = child.pid;
console.log(`pid=${initialPid}\n`);

let stderrBuf = "";
child.stderr.on("data", (c: Buffer) => {
  stderrBuf += c.toString();
});

let buffer = "";
let sessionId: string | null = null;
type Phase = "init" | "turn1" | "turn2" | "done";
let phase: Phase = "init";
let turn1Text = "";
let turn2Text = "";

function send(content: string) {
  const obj = {
    type: "user",
    message: { role: "user", content },
  };
  const line = JSON.stringify(obj) + "\n";
  console.log(`>>> ${line.trim().slice(0, 100)}`);
  child.stdin.write(line);
}

child.stdout.on("data", (chunk: Buffer) => {
  buffer += chunk.toString();
  const lines = buffer.split("\n");
  buffer = lines.pop() ?? "";
  for (const line of lines) {
    if (!line.trim()) continue;
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(line);
    } catch {
      console.warn(`!! unparseable: ${line.slice(0, 80)}`);
      continue;
    }
    const type = ev.type as string;
    const subtype = ev.subtype as string | undefined;
    const tag = subtype ? `${type}/${subtype}` : type;

    if (type === "system" && subtype === "init") {
      sessionId = (ev.session_id as string) ?? null;
      console.log(`<<< ${tag} session_id=${sessionId}`);
    } else if (type === "assistant") {
      const message = ev.message as Record<string, unknown> | undefined;
      const content = message?.content as Array<Record<string, unknown>> | undefined;
      if (content) {
        for (const blk of content) {
          if (blk.type === "text" && typeof blk.text === "string") {
            if (phase === "turn1") turn1Text += blk.text;
            if (phase === "turn2") turn2Text += blk.text;
          }
        }
      }
      console.log(`<<< ${tag}`);
    } else if (type === "result") {
      console.log(
        `<<< ${tag} stop_reason=${ev.stop_reason} duration_ms=${ev.duration_ms}`,
      );
      if (phase === "turn1") {
        phase = "turn2";
        console.log(`\n--- turn 1 done. process pid still ${child.pid} ---\n`);
        send("Как меня зовут?");
      } else if (phase === "turn2") {
        phase = "done";
        console.log(`\n--- turn 2 done. process pid still ${child.pid} ---`);
        child.stdin.end();
      }
    } else {
      console.log(`<<< ${tag}`);
    }
  }
});

// Stream-json input mode: send turn 1 immediately, the process won't emit
// anything until it has input on stdin.
phase = "turn1";
setTimeout(() => send("Меня зовут Иван. Запомни моё имя."), 500);

child.on("close", (code, signal) => {
  console.log("\n=== Verdict ===");
  console.log(`Exit code: ${code} signal: ${signal}`);
  console.log(`Same pid throughout: ${child.pid === initialPid}`);
  console.log(`Turn 1 reply (${turn1Text.length} chars): ${turn1Text.slice(0, 200)}`);
  console.log(`Turn 2 reply (${turn2Text.length} chars): ${turn2Text.slice(0, 200)}`);
  const remembered = turn2Text.includes("Иван");
  console.log(`Turn 2 mentions "Иван"? ${remembered}`);
  console.log(`session_id seen?       ${sessionId}`);
  if (stderrBuf.trim()) {
    console.log(`stderr (truncated):\n${stderrBuf.slice(0, 500)}`);
  }
  process.exit(remembered ? 0 : 1);
});

setTimeout(() => {
  console.error("TIMEOUT after 60s");
  child.kill("SIGTERM");
}, 60_000);
