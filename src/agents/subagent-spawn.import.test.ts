import { describe, expect, it, vi } from "vitest";

describe("subagent-spawn module import", () => {
  it("loads without spawn-mode TDZ failures", async () => {
    vi.resetModules();
    const mod = await import("./subagent-spawn.js");
    expect(typeof mod.spawnSubagentDirect).toBe("function");
    expect(mod.SUBAGENT_SPAWN_MODES).toEqual(["run", "session"]);
  });
});
