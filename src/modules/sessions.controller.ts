import { Body, Controller, Delete, Get, Param, Patch, Post } from "@nestjs/common";
import { SessionStoreService } from "../runtime/session-store.service";
import { AgentService } from "../agent/service";
import type { AgentSession } from "../runtime/types";

@Controller("/v1/sessions")
export class SessionsController {
  constructor(
    private readonly sessions: SessionStoreService,
    private readonly agent: AgentService,
  ) {}

  @Post()
  create(@Body() body: unknown): Promise<AgentSession> {
    return this.sessions.create(body);
  }

  @Get()
  async list(): Promise<{ sessions: AgentSession[] }> {
    return { sessions: await this.sessions.list() };
  }

  @Get(":id")
  get(@Param("id") id: string): Promise<AgentSession> {
    return this.sessions.get(id);
  }

  @Patch(":id")
  patch(@Param("id") id: string, @Body() body: unknown): Promise<AgentSession> {
    return this.sessions.patch(id, body);
  }

  @Post(":id/reset")
  async reset(@Param("id") id: string): Promise<{ id: string; status: "reset" }> {
    const session = await this.sessions.get(id);
    await this.agent.resetSession(session);
    return { id, status: "reset" };
  }

  @Delete(":id")
  async delete(@Param("id") id: string): Promise<{ id: string; status: "deleted" }> {
    await this.sessions.delete(id);
    return { id, status: "deleted" };
  }
}
