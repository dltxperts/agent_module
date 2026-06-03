import { Module } from "@nestjs/common";
import { AgentModule } from "./agent/module";
import { AgentRunner } from "./agent/runner";
import { HealthController } from "./modules/health.controller";
import { McpController } from "./modules/mcp.controller";
import { SessionsController } from "./modules/sessions.controller";
import { RunsController } from "./modules/runs.controller";
import { FilesController } from "./modules/files.controller";
import { RuntimeConfigService } from "./runtime/config.service";
import { StartupMcpConfigService } from "./runtime/startup-mcp-config.service";
import { SessionStoreService } from "./runtime/session-store.service";
import { RunStoreService } from "./runtime/run-store.service";
import { RunEventLogService } from "./runtime/run-event-log.service";
import { FileStoreService } from "./runtime/file-store.service";

@Module({
  imports: [AgentModule],
  controllers: [
    HealthController,
    McpController,
    SessionsController,
    RunsController,
    FilesController,
  ],
  providers: [
    RuntimeConfigService,
    StartupMcpConfigService,
    SessionStoreService,
    RunStoreService,
    RunEventLogService,
    FileStoreService,
    AgentRunner,
  ],
})
export class AppModule {}
