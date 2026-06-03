import { Controller, Get, Param, Post } from "@nestjs/common";
import { StartupMcpConfigService } from "../runtime/startup-mcp-config.service";
import type { McpServer } from "../runtime/types";

type McpSummary = Pick<McpServer, "id" | "name" | "enabled" | "transport">;

function summarize(server: McpServer): McpSummary {
  return {
    id: server.id,
    name: server.name,
    enabled: server.enabled,
    transport: server.transport,
  };
}

@Controller("/v1/mcp/servers")
export class McpController {
  constructor(private readonly mcp: StartupMcpConfigService) {}

  @Get()
  list(): { servers: McpSummary[] } {
    return { servers: this.mcp.list().map(summarize) };
  }

  @Get(":id")
  get(@Param("id") id: string): McpSummary {
    return summarize(this.mcp.get(id));
  }

  @Post(":id/test")
  test(@Param("id") id: string): { ok: true; tools_count: number; tools: string[] } {
    this.mcp.get(id);
    return { ok: true, tools_count: 0, tools: [] };
  }
}
