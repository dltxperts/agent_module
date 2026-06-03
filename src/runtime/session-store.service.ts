import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { mkdir, readdir, rm } from "fs/promises";
import { join } from "path";
import { randomUUID } from "crypto";
import { RuntimeConfigService } from "./config.service";
import { readJsonFile, writeJsonFile } from "./json-store";
import {
  CreateSessionSchema,
  PatchSessionSchema,
  type AgentSession,
  type CreateSessionInput,
  type PatchSessionInput,
} from "./types";
import { StartupMcpConfigService } from "./startup-mcp-config.service";

@Injectable()
export class SessionStoreService {
  private readonly dir: string;

  constructor(
    config: RuntimeConfigService,
    private readonly mcpConfig: StartupMcpConfigService,
  ) {
    this.dir = join(config.agentHome, "sessions");
  }

  async create(raw: unknown): Promise<AgentSession> {
    const input = this.parseCreate(raw);
    this.mcpConfig.assertKnown(input.mcp_server_ids);
    const id = input.id ?? `session_${randomUUID()}`;
    const existing = await this.find(id);
    if (existing) throw new BadRequestException(`Session already exists: ${id}`);

    const now = new Date().toISOString();
    const session: AgentSession = {
      id,
      engine_session_id: randomUUID(),
      title: input.title,
      engine: input.engine,
      model: input.model,
      cwd: input.cwd,
      system_prompt: input.system_prompt,
      permission_mode: input.permission_mode,
      mcp_server_ids: input.mcp_server_ids,
      metadata: input.metadata,
      created_at: now,
      updated_at: now,
    };
    await this.write(session);
    return session;
  }

  async list(): Promise<AgentSession[]> {
    await mkdir(this.dir, { recursive: true });
    const files = await readdir(this.dir);
    const sessions = await Promise.all(
      files
        .filter((file) => file.endsWith(".json"))
        .map((file) => readJsonFile<AgentSession>(join(this.dir, file), null as never)),
    );
    return sessions.sort((a, b) => a.id.localeCompare(b.id));
  }

  async get(id: string): Promise<AgentSession> {
    const session = await this.find(id);
    if (!session) throw new NotFoundException(`Unknown session: ${id}`);
    return session;
  }

  async patch(id: string, raw: unknown): Promise<AgentSession> {
    const input = this.parsePatch(raw);
    const current = await this.get(id);
    if (input.mcp_server_ids) this.mcpConfig.assertKnown(input.mcp_server_ids);

    const next: AgentSession = {
      ...current,
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.engine !== undefined ? { engine: input.engine } : {}),
      ...(input.model !== undefined ? { model: input.model ?? undefined } : {}),
      ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
      ...(input.system_prompt !== undefined
        ? { system_prompt: input.system_prompt ?? undefined }
        : {}),
      ...(input.permission_mode !== undefined
        ? { permission_mode: input.permission_mode }
        : {}),
      ...(input.mcp_server_ids !== undefined
        ? { mcp_server_ids: input.mcp_server_ids }
        : {}),
      ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
      updated_at: new Date().toISOString(),
    };
    await this.write(next);
    return next;
  }

  async delete(id: string): Promise<void> {
    await rm(this.pathFor(id), { force: true });
  }

  async setLastRun(id: string, runId: string): Promise<AgentSession> {
    const session = await this.get(id);
    const next = {
      ...session,
      last_run_id: runId,
      updated_at: new Date().toISOString(),
    };
    await this.write(next);
    return next;
  }

  /** Record the engine that produced the session's latest completed run
   *  (INV-5). Read back on the next run to pick cacheMode/previousEngine. */
  async setLastEngine(id: string, engine: AgentSession["engine"]): Promise<AgentSession> {
    const session = await this.get(id);
    const next = {
      ...session,
      last_engine: engine,
      updated_at: new Date().toISOString(),
    };
    await this.write(next);
    return next;
  }

  private async find(id: string): Promise<AgentSession | null> {
    return readJsonFile<AgentSession | null>(this.pathFor(id), null);
  }

  private async write(session: AgentSession): Promise<void> {
    await writeJsonFile(this.pathFor(session.id), session);
  }

  private pathFor(id: string): string {
    return join(this.dir, `${id}.json`);
  }

  private parseCreate(raw: unknown): CreateSessionInput {
    const parsed = CreateSessionSchema.safeParse(raw);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.message);
    }
    return parsed.data;
  }

  private parsePatch(raw: unknown): PatchSessionInput {
    const parsed = PatchSessionSchema.safeParse(raw);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.message);
    }
    return parsed.data;
  }
}
