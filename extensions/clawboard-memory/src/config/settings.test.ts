import { describe, expect, it } from "vitest";
import { clawboardMemoryPluginConfigSchema, resolvePluginSettings } from "./settings.js";

describe("clawboard-memory settings", () => {
  it("fills defaults while preserving explicit service config", () => {
    const settings = resolvePluginSettings({
      clawboard: {
        baseUrl: "https://clawboard.example.com/api",
        auth: {
          mode: "bearer",
          valueEnv: "CLAWBOARD_API_TOKEN",
        },
      },
      memoryApi: {
        baseUrl: "https://memory.example.com/api",
        defaultNamespace: "openclaw",
        auth: {
          mode: "header",
          headerName: "x-memory-key",
          valueEnv: "MEMORY_API_TOKEN",
        },
      },
      workflow: {
        retrieval: {
          maxPlanningResults: 2,
        },
      },
    });

    expect(settings.clawboard.timeoutMs).toBe(15_000);
    expect(settings.clawboard.endpoints.listItems).toEqual({
      path: "/items",
      method: "GET",
    });
    expect(settings.memoryApi.auth).toEqual({
      mode: "header",
      headerName: "x-memory-key",
      valueEnv: "MEMORY_API_TOKEN",
    });
    expect(settings.memoryApi.defaultNamespace).toBe("openclaw");
    expect(settings.workflow.columns.startedTask).toBe("Started Task");
    expect(settings.workflow.retrieval.maxPlanningResults).toBe(2);
    expect(settings.workflow.retrieval.maxMemoryResults).toBe(3);
    expect(settings.workflow.automation.planningPoll.enabled).toBe(false);
  });

  it("reports structured validation errors for invalid config", () => {
    const parsed = clawboardMemoryPluginConfigSchema.safeParse?.({
      workflow: {
        retrieval: {
          maxMemoryResults: 0,
        },
      },
    });

    expect(parsed?.success).toBe(false);
    expect(parsed?.error?.issues?.[0]?.path).toContain("maxMemoryResults");
  });
});
