import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";

export async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  const port = Number(process.env.AGENT_PORT ?? "3002");
  await app.listen(port, "0.0.0.0");
  console.log(`Agent runtime listening on http://0.0.0.0:${port}`);
}

if (import.meta.main) {
  await bootstrap();
}
