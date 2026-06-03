import { Body, Controller, Get, Header, Param, Post, Query, Res } from "@nestjs/common";
import { AgentRunner } from "../agent/runner";
import { RunStoreService } from "../runtime/run-store.service";
import { RunEventLogService } from "../runtime/run-event-log.service";
import type { Run, RunEvent } from "../runtime/types";

interface SseResponse {
  status(code: number): SseResponse;
  setHeader(name: string, value: string): void;
  write(chunk: string): void;
  end(): void;
}

@Controller()
export class RunsController {
  constructor(
    private readonly runs: RunStoreService,
    private readonly events: RunEventLogService,
    private readonly runner: AgentRunner,
  ) {}

  @Post("/v1/sessions/:id/runs")
  async create(
    @Param("id") sessionId: string,
    @Body() body: unknown,
  ): Promise<{ run_id: string; session_id: string; status: Run["status"] }> {
    const run = await this.runs.create(sessionId, body);
    this.runner.start(run.id);
    return {
      run_id: run.id,
      session_id: run.session_id,
      status: run.status,
    };
  }

  @Get("/v1/runs/:id")
  get(@Param("id") id: string): Promise<Run> {
    return this.runs.get(id);
  }

  @Get("/v1/runs/:id/events")
  poll(
    @Param("id") id: string,
    @Query("cursor") cursor = "0",
    @Query("timeout_ms") timeoutMs = "30000",
    @Query("limit") limit = "100",
  ): Promise<{ run_id: string; next_cursor: number; done: boolean; events: RunEvent[] }> {
    return this.events.poll({
      runId: id,
      cursor: Number.parseInt(cursor, 10) || 0,
      timeoutMs: Math.max(0, Number.parseInt(timeoutMs, 10) || 0),
      limit: Math.max(1, Number.parseInt(limit, 10) || 100),
    });
  }

  @Post("/v1/sessions/:id/runs/stream")
  @Header("Content-Type", "text/event-stream")
  async stream(
    @Param("id") sessionId: string,
    @Body() body: unknown,
    @Res() response: SseResponse,
  ): Promise<void> {
    const run = await this.runs.create(sessionId, body);
    response.status(201);
    response.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    response.setHeader("Cache-Control", "no-cache");
    response.setHeader("Connection", "keep-alive");
    response.write(this.formatSse("run_created", {
      run_id: run.id,
      session_id: run.session_id,
      status: run.status,
    }));

    this.runner.start(run.id);

    let cursor = 0;
    for (;;) {
      const polled = await this.events.poll({
        runId: run.id,
        cursor,
        timeoutMs: 30000,
        limit: 100,
      });
      for (const event of polled.events) {
        response.write(this.formatSse(event.type, event));
      }
      cursor = polled.next_cursor;
      if (polled.done) break;
    }
    response.end();
  }

  private formatSse(event: string, data: unknown): string {
    return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  }
}
