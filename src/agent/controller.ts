import { Controller, Get } from "@nestjs/common";
import { AgentService, type EngineSummary } from "./service";

@Controller("/v1/engines")
export class AgentController {
  constructor(private readonly agent: AgentService) {}

  @Get()
  listEngines(): { engines: EngineSummary[] } {
    return { engines: this.agent.listEngines() };
  }
}
