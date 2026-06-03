export { bootstrap } from "./main";

if (import.meta.main) {
  const { bootstrap } = await import("./main");
  await bootstrap();
}
