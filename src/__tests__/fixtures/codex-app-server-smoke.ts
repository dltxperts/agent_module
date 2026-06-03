#!/usr/bin/env bun
/**
 * D'-codex smoke: drive `codex app-server --listen stdio://` over one
 * stdio pipe for two consecutive turns, verify memory survives and
 * the process never re-spawns.
 *
 * Wire protocol = JSON-RPC 2.0 (one envelope per line).
 *   client → server: { jsonrpc:"2.0", id, method, params }
 *   server → client: { jsonrpc:"2.0", id?, method?, params?, result?, error? }
 *
 * Sequence:
 *   1. initialize
 *   2. thread/start
 *   3. turn/start → wait for turn/completed
 *   4. turn/start (turn 2) → wait for turn/completed
 *   5. shutdown
 */

import { spawn } from "child_process";

const args = ["app-server", "--listen", "stdio://"];
console.log(`Spawning: codex ${args.join(" ")}`);

const child = spawn("codex", args, { stdio: ["pipe", "pipe", "pipe"] });
const initialPid = child.pid;
console.log(`pid=${initialPid}\n`);

let stderrBuf = "";
child.stderr.on("data", (c: Buffer) => {
  stderrBuf += c.toString();
});

let stdoutBuf = "";
let nextId = 1;
const pendingRequests = new Map<number, (resp: Record<string, unknown>) => void>();
const notifications: Record<string, unknown>[] = [];

function send(method: string, params: Record<string, unknown> | undefined = {}): Promise<Record<string, unknown>> {
  const id = nextId++;
  const envelope = { jsonrpc: "2.0", id, method, params };
  const line = JSON.stringify(envelope) + "\n";
  console.log(`>>> ${method} (id=${id}) ${JSON.stringify(params).slice(0, 80)}`);
  child.stdin.write(line);
  return new Promise((resolve) => {
    pendingRequests.set(id, resolve);
  });
}

let threadId: string | null = null;
let turn1Text = "";
let turn2Text = "";
let currentPhase: "init" | "turn1" | "turn2" | "done" = "init";

child.stdout.on("data", (chunk: Buffer) => {
  stdoutBuf += chunk.toString();
  const lines = stdoutBuf.split("\n");
  stdoutBuf = lines.pop() ?? "";
  for (const line of lines) {
    if (!line.trim()) continue;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line);
    } catch {
      console.warn(`!! unparseable: ${line.slice(0, 80)}`);
      continue;
    }
    // Response (has id, no method)
    if (typeof msg.id === "number" && pendingRequests.has(msg.id as number)) {
      const cb = pendingRequests.get(msg.id as number);
      pendingRequests.delete(msg.id as number);
      const tag = msg.error ? `ERROR ${JSON.stringify(msg.error)}` : "ok";
      console.log(`<<< response id=${msg.id} ${tag}`);
      cb?.(msg);
      continue;
    }
    // Notification (has method)
    if (typeof msg.method === "string") {
      const m = msg.method as string;
      const params = (msg.params ?? {}) as Record<string, unknown>;
      console.log(`<<< notif ${m}`);
      notifications.push(msg);
      if (m === "thread/started") {
        threadId = (params.threadId ?? params.thread_id) as string ?? null;
        console.log(`    threadId=${threadId}`);
      }
      if (m === "item/agentMessage/delta") {
        const delta = (params.delta as string) ?? "";
        if (currentPhase === "turn1") turn1Text += delta;
        if (currentPhase === "turn2") turn2Text += delta;
      }
    }
  }
});

async function main() {
  await send("initialize", {
    clientInfo: { name: "magnis-smoke", version: "0.0.0" },
  });

  const startResp = await send("thread/start", {});
  console.log("    thread/start result:", JSON.stringify(startResp.result).slice(0, 200));
  const startResult = startResp.result as Record<string, unknown>;
  const thread = startResult.thread as Record<string, unknown> | undefined;
  threadId = (thread?.id as string) ?? null;
  if (!threadId) throw new Error("no threadId in thread/start response");

  // Turn 1
  currentPhase = "turn1";
  await send("turn/start", {
    threadId,
    input: [{ type: "text", text: "Меня зовут Иван. Запомни моё имя одной фразой.", text_elements: [] }],
  });
  // wait until turn/completed for THIS turn
  await new Promise<void>((resolve) => {
    const t = setInterval(() => {
      if (notifications.some((n) => n.method === "turn/completed")) {
        clearInterval(t);
        resolve();
      }
    }, 200);
  });
  console.log(`\n--- turn 1 done. pid=${child.pid} ---\n`);

  // Drop turn/completed marker so we wait for turn 2's.
  notifications.length = 0;

  // Turn 2
  currentPhase = "turn2";
  await send("turn/start", {
    threadId,
    input: [{ type: "text", text: "Как меня зовут? Ответь одним словом.", text_elements: [] }],
  });
  await new Promise<void>((resolve) => {
    const t = setInterval(() => {
      if (notifications.some((n) => n.method === "turn/completed")) {
        clearInterval(t);
        resolve();
      }
    }, 200);
  });
  console.log(`\n--- turn 2 done. pid=${child.pid} ---`);

  currentPhase = "done";

  console.log("\n=== Verdict ===");
  console.log(`Same pid throughout: ${child.pid === initialPid}`);
  console.log(`Thread id: ${threadId}`);
  console.log(`Turn 1 text (${turn1Text.length} ch): ${turn1Text.slice(0, 200)}`);
  console.log(`Turn 2 text (${turn2Text.length} ch): ${turn2Text.slice(0, 200)}`);
  const remembered = turn2Text.includes("Иван");
  console.log(`Turn 2 mentions "Иван"? ${remembered}`);
  if (stderrBuf.trim()) {
    console.log(`stderr (truncated):\n${stderrBuf.slice(0, 600)}`);
  }
  child.stdin.end();
  setTimeout(() => process.exit(remembered ? 0 : 1), 500);
}

main().catch((e) => {
  console.error("FAIL", e);
  if (stderrBuf.trim()) console.error(stderrBuf.slice(0, 600));
  process.exit(2);
});

setTimeout(() => {
  console.error("TIMEOUT 90s");
  console.error(stderrBuf.slice(0, 600));
  child.kill("SIGTERM");
}, 90_000);
