import { Controller, Get } from "@nestjs/common";

@Controller("/v1/health")
export class HealthController {
  @Get()
  getHealth(): { status: "ok"; version: string } {
    return { status: "ok", version: "0.1.0" };
  }
}
