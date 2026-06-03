import { describe, expect, test } from "bun:test";

import {
  codexMode,
  createEngines,
  orderEngines,
} from "../agent/service";
import type { AgentEngine, EngineRequest, StreamEvent } from "../agent/types";

class NamedEngine implements AgentEngine {
  constructor(readonly name: string) {}

  async *stream(_request: EngineRequest): AsyncIterable<StreamEvent> {
    yield { type: "done", full_content: "" };
  }
}

describe("standalone startup engines", () => {
  test("tst_agent_unit_startup_engines_001_builtin_disabled_by_default", () => {
    const engines = createEngines({});

    expect(engines.map((engine) => engine.name)).toEqual(["claude", "codex"]);
  });

  test("tst_agent_unit_startup_engines_003_default_engine_reorders_enabled_engines", () => {
    const engines = [
      new NamedEngine("claude"),
      new NamedEngine("codex"),
    ];

    expect(orderEngines(engines, "codex").map((engine) => engine.name)).toEqual([
      "codex",
      "claude",
    ]);
  });

  test("tst_agent_unit_startup_engines_004_default_engine_must_be_enabled", () => {
    const engines = [
      new NamedEngine("claude"),
      new NamedEngine("codex"),
    ];

    expect(() => orderEngines(engines, "builtin")).toThrow(
      "DEFAULT_ENGINE=builtin is not enabled",
    );
  });

  test("tst_agent_unit_startup_engines_005_codex_app_server_is_startup_default", () => {
    expect(codexMode({})).toBe("app-server");
    expect(codexMode({ CODEX_ENGINE_MODE: "app-server" })).toBe("app-server");
    expect(codexMode({ CODEX_ENGINE_MODE: "legacy" })).toBe("legacy");
  });
});
