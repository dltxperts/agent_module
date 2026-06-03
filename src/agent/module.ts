import { Module } from "@nestjs/common";
import { AgentController } from "./controller";
import { AgentService } from "./service";

@Module({
  controllers: [AgentController],
  providers: [AgentService],
  exports: [AgentService],
})
export class AgentModule {}
