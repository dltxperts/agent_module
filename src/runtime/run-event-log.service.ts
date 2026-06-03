import { Injectable } from "@nestjs/common";
import { appendFile, mkdir, readFile } from "fs/promises";
import { join } from "path";
import { RuntimeConfigService } from "./config.service";
import type { RunEvent, RunEventPayload } from "./types";

interface Waiter {
  runId: string;
  cursor: number;
  resolve: () => void;
}

@Injectable()
export class RunEventLogService {
  private readonly dir: string;
  private readonly waiters = new Set<Waiter>();
  // INV-9: last assigned seq per run, kept in memory so append is O(1).
  // Lazily seeded from the file tail on the first append for a run
  // (covers process restart) instead of re-reading on every append.
  private readonly lastSeq = new Map<string, number>();

  constructor(config: RuntimeConfigService) {
    this.dir = join(config.agentHome, "runs");
  }

  async append(runId: string, event: RunEventPayload): Promise<RunEvent> {
    let seq = this.lastSeq.get(runId);
    if (seq === undefined) {
      const existing = await this.read(runId, 0, Number.MAX_SAFE_INTEGER);
      seq = existing.length === 0 ? 0 : existing[existing.length - 1]!.seq;
    }
    seq += 1;
    this.lastSeq.set(runId, seq);

    const next = {
      ...event,
      seq,
      run_id: runId,
      ts: new Date().toISOString(),
    } as RunEvent;
    await mkdir(this.dir, { recursive: true });
    await appendFile(this.pathFor(runId), `${JSON.stringify(next)}\n`);
    for (const waiter of this.waiters) {
      if (waiter.runId === runId && next.seq > waiter.cursor) waiter.resolve();
    }
    return next;
  }

  async read(runId: string, cursor: number, limit: number): Promise<RunEvent[]> {
    try {
      const text = await readFile(this.pathFor(runId), "utf8");
      return text
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as RunEvent)
        .filter((event) => event.seq > cursor)
        .slice(0, limit);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
  }

  async poll(input: {
    runId: string;
    cursor: number;
    timeoutMs: number;
    limit: number;
  }): Promise<{ run_id: string; next_cursor: number; done: boolean; events: RunEvent[] }> {
    let events = await this.read(input.runId, input.cursor, input.limit);
    if (events.length === 0 && input.timeoutMs > 0) {
      await new Promise<void>((resolve) => {
        const waiter: Waiter = {
          runId: input.runId,
          cursor: input.cursor,
          resolve: () => {
            this.waiters.delete(waiter);
            resolve();
          },
        };
        this.waiters.add(waiter);
        setTimeout(waiter.resolve, input.timeoutMs);
      });
      events = await this.read(input.runId, input.cursor, input.limit);
    }
    const nextCursor = events.length === 0
      ? input.cursor
      : events[events.length - 1]!.seq;
    return {
      run_id: input.runId,
      next_cursor: nextCursor,
      done: events.some((event) => event.type === "done" || event.type === "error"),
      events,
    };
  }

  private pathFor(runId: string): string {
    return join(this.dir, `${runId}.events.jsonl`);
  }
}
