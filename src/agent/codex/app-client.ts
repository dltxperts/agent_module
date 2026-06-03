/**
 * CodexAppServerClient — JSON-RPC 2.0 over a long-lived
 * `codex app-server --listen stdio://` child process.
 *
 * Two channels multiplexed on one stdio pipe:
 *  - request/response: `request(method, params)` correlates the reply
 *    by `id` (INV-CODEX-AS-8).
 *  - server notifications: `notifications()` is a single shared
 *    async-iterator over all method-bearing messages (deltas, item
 *    lifecycle, turn/completed, warnings, errors).
 *
 * Plan: docs/plans/codex-engine-app-server.md Stage 1.
 */

import type { ChildProcess } from "child_process";
import type {
  CodexAppServerClient,
  IncomingMessage,
  JsonRpcNotification,
  JsonRpcResponse,
  NotificationConsumer,
  PendingRequest,
  ServerRequest,
} from "./types";

function isResponse(message: IncomingMessage): message is JsonRpcResponse {
  return (
    typeof (message as JsonRpcResponse).id !== "undefined" &&
    typeof (message as JsonRpcNotification).method === "undefined"
  );
}

export function createCodexAppServerClient(
  child: ChildProcess,
): CodexAppServerClient {
  if (!child.stdin) throw new Error("CodexAppServerClient: child has no stdin");
  if (!child.stdout) throw new Error("CodexAppServerClient: child has no stdout");

  let nextId = 1;
  const pending = new Map<number, PendingRequest>();
  let stdinClosed = false;
  const closeListeners = new Set<() => void>();
  let closeFired = false;
  let serverRequestHandler: ((req: ServerRequest) => void) | null = null;
  // Buffer server→client requests that arrive before a handler is set
  // so the very first turn's elicitation isn't dropped (which would
  // hang the turn).
  const bufferedServerRequests: ServerRequest[] = [];

  function writeLine(obj: unknown): void {
    if (stdinClosed || !child.stdin) return;
    child.stdin.write(JSON.stringify(obj) + "\n");
  }

  // Broadcast model: one app-server process multiplexes N threads, so
  // every `notifications()` consumer receives EVERY notification and
  // filters by threadId itself. A shared single iterator would let one
  // concurrent turn steal another's events.
  const consumers = new Set<NotificationConsumer>();
  let notifDone = false;

  function pushNotif(n: JsonRpcNotification): void {
    if (notifDone) return;
    for (const c of consumers) {
      if (c.waiter) {
        const w = c.waiter;
        c.waiter = null;
        w({ value: n, done: false });
      } else {
        c.queue.push(n);
      }
    }
  }

  function endNotif(): void {
    if (notifDone) return;
    notifDone = true;
    for (const c of consumers) {
      c.done = true;
      if (c.waiter) {
        const w = c.waiter;
        c.waiter = null;
        w({ value: undefined as never, done: true });
      }
    }
  }

  function makeConsumerIterator(): AsyncIterator<JsonRpcNotification> {
    const c: NotificationConsumer = { queue: [], waiter: null, done: notifDone };
    consumers.add(c);
    return {
      next() {
        if (c.queue.length > 0) {
          return Promise.resolve({
            value: c.queue.shift() as JsonRpcNotification,
            done: false,
          });
        }
        if (c.done) {
          consumers.delete(c);
          return Promise.resolve({ value: undefined as never, done: true });
        }
        return new Promise<IteratorResult<JsonRpcNotification>>((resolve) => {
          c.waiter = resolve;
        });
      },
      return() {
        consumers.delete(c);
        return Promise.resolve({ value: undefined as never, done: false });
      },
    };
  }

  function handle(msg: IncomingMessage): void {
    const m = msg as { id?: unknown; method?: unknown };
    const hasId = m.id !== undefined && m.id !== null;
    const hasMethod = typeof m.method === "string";

    // Server→client REQUEST: has BOTH method AND id. These block the
    // codex turn until answered (e.g. mcpServer/elicitation/request,
    // approvals). MUST route to the request handler, NOT the
    // notification stream — otherwise the turn hangs forever.
    if (hasId && hasMethod) {
      const req: ServerRequest = {
        id: m.id as number | string,
        method: m.method as string,
        params: (msg as JsonRpcNotification).params,
      };
      if (serverRequestHandler) {
        serverRequestHandler(req);
      } else {
        bufferedServerRequests.push(req);
      }
      return;
    }

    // Response to one of our requests: has id, no method.
    if (isResponse(msg)) {
      const resp = msg as JsonRpcResponse;
      const id = typeof resp.id === "number" ? resp.id : Number(resp.id);
      const p = pending.get(id);
      if (!p) return;
      pending.delete(id);
      if (resp.error) {
        p.reject(new Error(`codex app-server error ${resp.error.code}: ${resp.error.message}`));
      } else {
        p.resolve(resp.result);
      }
      return;
    }
    // Notification: has method, no id.
    pushNotif(msg as JsonRpcNotification);
  }

  let stdoutBuf = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdoutBuf += chunk.toString();
    const lines = stdoutBuf.split("\n");
    stdoutBuf = lines.pop() ?? "";
    for (const line of lines) {
      const t = line.trim();
      if (!t) continue;
      let parsed: IncomingMessage;
      try {
        parsed = JSON.parse(t) as IncomingMessage;
      } catch {
        // Non-JSON stderr-ish noise on stdout — ignore.
        continue;
      }
      handle(parsed);
    }
  });

  const onTerminal = (label: string) => (
    codeOrErr: number | Error | null,
    signal?: NodeJS.Signals | null,
  ) => {
    const message =
      codeOrErr instanceof Error
        ? codeOrErr.message
        : `codex app-server ${label} code=${codeOrErr} signal=${signal ?? ""}`.trim();
    // Reject every in-flight request.
    for (const [, p] of pending) p.reject(new Error(message));
    pending.clear();
    endNotif();
    if (!closeFired) {
      closeFired = true;
      for (const cb of closeListeners) cb();
      closeListeners.clear();
    }
  };
  child.on("exit", onTerminal("exit"));
  child.on("error", onTerminal("error"));

  return {
    request<T = unknown>(method: string, params?: unknown): Promise<T> {
      if (stdinClosed) {
        return Promise.reject(new Error("CodexAppServerClient: stdin already closed"));
      }
      const stdin = child.stdin;
      if (!stdin) {
        return Promise.reject(new Error("CodexAppServerClient: child has no stdin"));
      }
      const id = nextId++;
      const envelope = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
      return new Promise<T>((resolve, reject) => {
        pending.set(id, {
          resolve: resolve as (v: unknown) => void,
          reject,
        });
        const ok = stdin.write(envelope, (err) => {
          if (err) {
            pending.delete(id);
            reject(err);
          }
        });
        if (!ok) {
          stdin.once("drain", () => {
            /* backpressure relieved; the write callback already fired */
          });
        }
      });
    },

    notifications(): AsyncIterable<JsonRpcNotification> {
      return { [Symbol.asyncIterator]: () => makeConsumerIterator() };
    },

    onServerRequest(handler: (req: ServerRequest) => void): void {
      serverRequestHandler = handler;
      // Flush anything buffered before the handler was attached.
      if (bufferedServerRequests.length > 0) {
        const buffered = bufferedServerRequests.splice(0);
        for (const req of buffered) handler(req);
      }
    },

    respond(id: number | string, result: unknown): void {
      writeLine({ jsonrpc: "2.0", id, result });
    },

    onClose(cb: () => void): void {
      if (closeFired) {
        cb();
        return;
      }
      closeListeners.add(cb);
    },

    async close(): Promise<void> {
      if (stdinClosed) return;
      stdinClosed = true;
      try {
        child.stdin?.end();
      } catch {
        // already gone
      }
    },
  };
}
