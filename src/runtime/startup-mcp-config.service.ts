import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { existsSync, readFileSync } from "fs";
import { RuntimeConfigService } from "./config.service";
import {
  McpServerSchema,
  StartupMcpConfigSchema,
  type McpServer,
} from "./types";

@Injectable()
export class StartupMcpConfigService {
  private readonly servers: McpServer[];
  private readonly byId: Map<string, McpServer>;

  constructor(config: RuntimeConfigService) {
    const loaded = existsSync(config.mcpConfigPath)
      ? StartupMcpConfigSchema.parse(
          JSON.parse(readFileSync(config.mcpConfigPath, "utf8")),
        )
      : { servers: [] };
    this.servers = loaded.servers.map((server) => McpServerSchema.parse(server));
    this.byId = new Map(this.servers.map((server) => [server.id, server]));
    if (this.byId.size !== this.servers.length) {
      throw new Error("Duplicate MCP server id in startup config");
    }
  }

  list(): McpServer[] {
    return this.servers;
  }

  get(id: string): McpServer {
    const server = this.byId.get(id);
    if (!server) throw new NotFoundException(`Unknown MCP server: ${id}`);
    return server;
  }

  getMany(ids: string[]): McpServer[] {
    this.assertKnown(ids);
    return ids.map((id) => this.get(id));
  }

  assertKnown(ids: string[]): void {
    const missing = ids.filter((id) => !this.byId.has(id));
    if (missing.length > 0) {
      throw new BadRequestException(`Unknown MCP server ids: ${missing.join(", ")}`);
    }
  }
}
