import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { mkdir, readdir } from "fs/promises";
import { join } from "path";
import { randomUUID } from "crypto";
import { RuntimeConfigService } from "./config.service";
import { readJsonFile, writeJsonFile } from "./json-store";
import {
  CreateRunSchema,
  type CreateRunInput,
  type Run,
} from "./types";
import { SessionStoreService } from "./session-store.service";

@Injectable()
export class RunStoreService {
  private readonly dir: string;

  constructor(
    config: RuntimeConfigService,
    private readonly sessions: SessionStoreService,
  ) {
    this.dir = join(config.agentHome, "runs");
  }

  async create(sessionId: string, raw: unknown): Promise<Run> {
    const session = await this.sessions.get(sessionId);
    const input = this.parseCreate(raw);
    const now = new Date().toISOString();
    const run: Run = {
      id: `run_${randomUUID()}`,
      session_id: session.id,
      engine: session.engine,
      status: "queued",
      input,
      created_at: now,
    };
    await this.write(run);
    await this.sessions.setLastRun(session.id, run.id);
    return run;
  }

  async get(id: string): Promise<Run> {
    const run = await readJsonFile<Run | null>(this.pathFor(id), null);
    if (!run) throw new NotFoundException(`Unknown run: ${id}`);
    return run;
  }

  async list(): Promise<Run[]> {
    await mkdir(this.dir, { recursive: true });
    const files = await readdir(this.dir);
    const runs = await Promise.all(
      files
        .filter((file) => file.endsWith(".json"))
        .map((file) => readJsonFile<Run>(join(this.dir, file), null as never)),
    );
    return runs.sort((a, b) => a.created_at.localeCompare(b.created_at));
  }

  /** All runs for a session, oldest first (by created_at). Used to
   *  reconstruct the conversation transcript on a replay turn. */
  async listForSession(sessionId: string): Promise<Run[]> {
    const all = await this.list();
    return all.filter((run) => run.session_id === sessionId);
  }

  async write(run: Run): Promise<void> {
    await writeJsonFile(this.pathFor(run.id), run);
  }

  async markRunning(id: string): Promise<Run> {
    const run = await this.get(id);
    const next: Run = {
      ...run,
      status: "running",
      started_at: run.started_at ?? new Date().toISOString(),
    };
    await this.write(next);
    return next;
  }

  async markCompleted(id: string, fullContent: string): Promise<Run> {
    const run = await this.get(id);
    const next: Run = {
      ...run,
      status: "completed",
      output: { full_content: fullContent },
      completed_at: new Date().toISOString(),
    };
    await this.write(next);
    return next;
  }

  async markFailed(id: string, message: string): Promise<Run> {
    const run = await this.get(id);
    const next: Run = {
      ...run,
      status: "failed",
      error: message,
      completed_at: new Date().toISOString(),
    };
    await this.write(next);
    return next;
  }

  private pathFor(id: string): string {
    return join(this.dir, `${id}.json`);
  }

  private parseCreate(raw: unknown): CreateRunInput {
    const parsed = CreateRunSchema.safeParse(raw);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.message);
    }
    return parsed.data;
  }
}
