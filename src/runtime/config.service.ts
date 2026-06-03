import { Injectable } from "@nestjs/common";
import { homedir } from "os";
import { join } from "path";

@Injectable()
export class RuntimeConfigService {
  readonly agentHome: string;
  readonly mcpConfigPath: string;

  constructor() {
    this.agentHome = process.env.AGENT_HOME ?? join(homedir(), ".agent-runtime");
    this.mcpConfigPath =
      process.env.AGENT_MCP_CONFIG ?? join(this.agentHome, "mcp-servers.json");
  }
}
