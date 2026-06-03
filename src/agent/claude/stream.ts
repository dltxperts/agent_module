/**
 * ClaudeStreamClient — bidirectional JSON-line pipe wrapper around a
 * long-lived `claude --print --input-format stream-json --output-format
 * stream-json` child process.
 *
 * Pure transport: writes user-message envelopes to stdin, parses
 * newline-delimited JSON from stdout, surfaces raw events. The engine
 * (Stage 3) maps raw events to the project-wide StreamEvent
 * discriminated union.
 *
 * Plan: docs/plans/claude-engine-stream-json.md Stage 2.
 */

import type { ChildProcess } from "child_process";
import type { ClaudeStreamClient, PendingRead, RawClaudeEvent } from "./types";

export function createClaudeStreamClient(
  child: ChildProcess,
): ClaudeStreamClient {
  if (!child.stdin) throw new Error("ClaudeStreamClient: child has no stdin");
  if (!child.stdout) throw new Error("ClaudeStreamClient: child has no stdout");

  const queue: RawClaudeEvent[] = [];
  let pending: PendingRead | null = null;
  let streamDone = false;
  let stdinClosed = false;

  // Singleton iterator over the events queue; each call to events()
  // returns the same iterator so consecutive `for await` blocks
  // resume on the SAME queue (no lost messages across turn
  // boundaries).
  const sharedIterator: AsyncIterator<RawClaudeEvent> = {
    next(): Promise<IteratorResult<RawClaudeEvent>> {
      if (queue.length > 0) {
        return Promise.resolve({
          value: queue.shift() as RawClaudeEvent,
          done: false,
        });
      }
      if (streamDone) {
        return Promise.resolve({ value: undefined as never, done: true });
      }
      return new Promise<IteratorResult<RawClaudeEvent>>((resolve) => {
        pending = { resolve };
      });
    },
    // Make `break` out of `for await` a no-op: the engine breaks
    // every turn at `result/*` and must resume on the next turn
    // without the iterator being closed (INV-STREAM-13).
    return(): Promise<IteratorResult<RawClaudeEvent>> {
      return Promise.resolve({ value: undefined as never, done: false });
    },
  };
  const sharedIterable: AsyncIterable<RawClaudeEvent> = {
    [Symbol.asyncIterator]: () => sharedIterator,
  };

  function deliver(ev: RawClaudeEvent): void {
    if (streamDone) return;
    if (pending) {
      const p = pending;
      pending = null;
      p.resolve({ value: ev, done: false });
    } else {
      queue.push(ev);
    }
  }

  function finish(): void {
    if (streamDone) return;
    streamDone = true;
    if (pending) {
      const p = pending;
      pending = null;
      p.resolve({ value: undefined as never, done: true });
    }
  }

  let stdoutBuf = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdoutBuf += chunk.toString();
    const lines = stdoutBuf.split("\n");
    stdoutBuf = lines.pop() ?? "";
    for (const line of lines) {
      const t = line.trim();
      if (!t) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(t);
      } catch {
        // Malformed line — surface as a warning-shaped raw event so
        // the engine can decide what to do.
        deliver({ type: "warning", code: "stream_parse_failed", line: t.slice(0, 200) });
        continue;
      }
      if (parsed && typeof parsed === "object" && "type" in parsed) {
        deliver(parsed as RawClaudeEvent);
      } else {
        deliver({ type: "warning", code: "stream_unexpected_payload" });
      }
    }
  });

  const onTerminal = (
    label: string,
  ) => (codeOrErr: number | Error | null, signal?: NodeJS.Signals | null) => {
    if (streamDone) return;
    const code = typeof codeOrErr === "number" ? codeOrErr : null;
    const message =
      codeOrErr instanceof Error
        ? codeOrErr.message
        : `claude child ${label} code=${code} signal=${signal ?? ""}`.trim();
    deliver({ type: "error", message, code: code ?? undefined });
    finish();
  };
  child.on("exit", onTerminal("exit"));
  child.on("error", onTerminal("error"));

  return {
    send(content: string): Promise<void> {
      if (stdinClosed) {
        return Promise.reject(new Error("ClaudeStreamClient: stdin already closed"));
      }
      const stdin = child.stdin;
      if (!stdin) {
        return Promise.reject(new Error("ClaudeStreamClient: child has no stdin"));
      }
      const envelope =
        JSON.stringify({
          type: "user",
          message: { role: "user", content },
        }) + "\n";
      return new Promise<void>((resolve, reject) => {
        const ok = stdin.write(envelope, (err) => {
          if (err) reject(err);
        });
        if (ok) {
          resolve();
          return;
        }
        // Backpressure — wait for 'drain'.
        stdin.once("drain", () => resolve());
      });
    },

    events(): AsyncIterable<RawClaudeEvent> {
      // One stream-of-events per client; both real and test usage
      // expect events() to return the same iterator across turns so
      // queued events aren't dropped between `for await` blocks.
      // INV-STREAM-13: dropping a `for await` mid-iteration must NOT
      // detach this iterator from the underlying stream.
      return sharedIterable;
    },

    async close(): Promise<void> {
      if (stdinClosed) return;
      stdinClosed = true;
      try {
        child.stdin?.end();
      } catch {
        // already gone — fine
      }
    },
  };
}
