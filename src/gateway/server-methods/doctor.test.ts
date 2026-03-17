import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";

const loadConfig = vi.hoisted(() => vi.fn(() => ({}) as OpenClawConfig));
const resolveDefaultAgentId = vi.hoisted(() => vi.fn(() => "main"));
const getMemorySearchManager = vi.hoisted(() => vi.fn());
const createWebSearchTool = vi.hoisted(() => vi.fn());
const resolveWebSearchProvider = vi.hoisted(() => vi.fn(() => "brave"));

vi.mock("../../config/config.js", () => ({
  loadConfig,
}));

vi.mock("../../agents/agent-scope.js", () => ({
  resolveDefaultAgentId,
}));

vi.mock("../../memory/index.js", () => ({
  getMemorySearchManager,
}));

vi.mock("../../agents/tools/web-search.js", () => ({
  createWebSearchTool,
  resolveWebSearchProvider,
}));

import { doctorHandlers } from "./doctor.js";

const invokeDoctorMemoryStatus = async (respond: ReturnType<typeof vi.fn>) => {
  await doctorHandlers["doctor.memory.status"]({
    req: {} as never,
    params: {} as never,
    respond: respond as never,
    context: {} as never,
    client: null,
    isWebchatConnect: () => false,
  });
};

const invokeDoctorWebStatus = async (respond: ReturnType<typeof vi.fn>) => {
  await doctorHandlers["doctor.web.status"]({
    req: {} as never,
    params: {} as never,
    respond: respond as never,
    context: {} as never,
    client: null,
    isWebchatConnect: () => false,
  });
};

const expectEmbeddingErrorResponse = (respond: ReturnType<typeof vi.fn>, error: string) => {
  expect(respond).toHaveBeenCalledWith(
    true,
    {
      agentId: "main",
      embedding: {
        ok: false,
        error,
      },
    },
    undefined,
  );
};

describe("doctor.memory.status", () => {
  beforeEach(() => {
    loadConfig.mockClear();
    resolveDefaultAgentId.mockClear();
    getMemorySearchManager.mockReset();
    createWebSearchTool.mockReset();
    resolveWebSearchProvider.mockReset().mockReturnValue("brave");
  });

  it("returns gateway embedding probe status for the default agent", async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    getMemorySearchManager.mockResolvedValue({
      manager: {
        status: () => ({ provider: "gemini" }),
        probeEmbeddingAvailability: vi.fn().mockResolvedValue({ ok: true }),
        close,
      },
    });
    const respond = vi.fn();

    await invokeDoctorMemoryStatus(respond);

    expect(getMemorySearchManager).toHaveBeenCalledWith({
      cfg: expect.any(Object),
      agentId: "main",
      purpose: "status",
    });
    expect(respond).toHaveBeenCalledWith(
      true,
      {
        agentId: "main",
        provider: "gemini",
        embedding: { ok: true },
      },
      undefined,
    );
    expect(close).toHaveBeenCalled();
  });

  it("returns unavailable when memory manager is missing", async () => {
    getMemorySearchManager.mockResolvedValue({
      manager: null,
      error: "memory search unavailable",
    });
    const respond = vi.fn();

    await invokeDoctorMemoryStatus(respond);

    expectEmbeddingErrorResponse(respond, "memory search unavailable");
  });

  it("returns probe failure when manager probe throws", async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    getMemorySearchManager.mockResolvedValue({
      manager: {
        status: () => ({ provider: "openai" }),
        probeEmbeddingAvailability: vi.fn().mockRejectedValue(new Error("timeout")),
        close,
      },
    });
    const respond = vi.fn();

    await invokeDoctorMemoryStatus(respond);

    expectEmbeddingErrorResponse(respond, "gateway memory probe failed: timeout");
    expect(close).toHaveBeenCalled();
  });
});

describe("doctor.web.status", () => {
  beforeEach(() => {
    loadConfig.mockClear();
    createWebSearchTool.mockReset();
    resolveWebSearchProvider.mockReset().mockReturnValue("gemini");
  });

  it("returns gateway web probe status", async () => {
    createWebSearchTool.mockReturnValue({
      execute: vi.fn().mockResolvedValue({
        details: {
          provider: "gemini",
          results: [],
        },
      }),
    });
    const respond = vi.fn();

    await invokeDoctorWebStatus(respond);

    expect(createWebSearchTool).toHaveBeenCalledWith({
      config: expect.any(Object),
      sandboxed: false,
    });
    expect(respond).toHaveBeenCalledWith(
      true,
      {
        provider: "gemini",
        search: { ok: true },
      },
      undefined,
    );
  });

  it("returns disabled when web search tool is unavailable", async () => {
    createWebSearchTool.mockReturnValue(null);
    const respond = vi.fn();

    await invokeDoctorWebStatus(respond);

    expect(respond).toHaveBeenCalledWith(
      true,
      {
        provider: "gemini",
        search: {
          ok: false,
          error: "web search is disabled in config",
        },
      },
      undefined,
    );
  });

  it("returns tool error details when the probe fails before results", async () => {
    createWebSearchTool.mockReturnValue({
      execute: vi.fn().mockResolvedValue({
        details: {
          error: "missing_gemini_api_key",
          message: "web_search (gemini) needs an API key.",
        },
      }),
    });
    const respond = vi.fn();

    await invokeDoctorWebStatus(respond);

    expect(respond).toHaveBeenCalledWith(
      true,
      {
        provider: "gemini",
        search: {
          ok: false,
          error: "web_search (gemini) needs an API key.",
        },
      },
      undefined,
    );
  });
});
