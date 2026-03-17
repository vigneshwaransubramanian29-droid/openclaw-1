import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withEnv } from "../test-utils/env.js";

const note = vi.hoisted(() => vi.fn());

vi.mock("../terminal/note.js", () => ({
  note,
}));

import { noteWebSearchHealth } from "./doctor-web-search.js";

describe("noteWebSearchHealth", () => {
  beforeEach(() => {
    note.mockClear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("reports missing Brave credentials for an explicit brave provider", async () => {
    await withEnv(
      {
        BRAVE_API_KEY: undefined,
      },
      async () => {
        await noteWebSearchHealth({
          tools: {
            web: {
              search: {
                provider: "brave",
              },
            },
          },
        });
      },
    );

    expect(note).toHaveBeenCalledWith(
      expect.stringContaining("Brave Search API key"),
      "Web search",
    );
  });

  it("reports missing Gemini credentials for an explicit gemini provider", async () => {
    await withEnv(
      {
        GEMINI_API_KEY: undefined,
      },
      async () => {
        await noteWebSearchHealth({
          tools: {
            web: {
              search: {
                provider: "gemini",
              },
            },
          },
        });
      },
    );

    expect(note).toHaveBeenCalledWith(expect.stringContaining("GEMINI_API_KEY"), "Web search");
  });

  it("reports generic missing credentials when auto detection has no provider keys", async () => {
    await withEnv(
      {
        BRAVE_API_KEY: undefined,
        GEMINI_API_KEY: undefined,
        XAI_API_KEY: undefined,
        KIMI_API_KEY: undefined,
        MOONSHOT_API_KEY: undefined,
        PERPLEXITY_API_KEY: undefined,
        OPENROUTER_API_KEY: undefined,
      },
      async () => {
        await noteWebSearchHealth({
          tools: {
            web: {
              search: {},
            },
          },
        });
      },
    );

    expect(note).toHaveBeenCalledWith(
      expect.stringContaining('web_search provider is set to "auto"'),
      "Web search",
    );
  });

  it("uses the gateway probe result when the gateway has usable web search credentials", async () => {
    await withEnv(
      {
        GEMINI_API_KEY: undefined,
      },
      async () => {
        await noteWebSearchHealth(
          {
            tools: {
              web: {
                search: {
                  provider: "gemini",
                },
              },
            },
          },
          {
            gatewayWebProbe: {
              checked: true,
              ready: true,
              provider: "gemini",
            },
          },
        );
      },
    );

    expect(note).toHaveBeenCalledWith(
      expect.stringContaining("running gateway reports web search is ready"),
      "Web search",
    );
  });

  it("reports deep probe failures even when credentials are present", async () => {
    await withEnv(
      {
        GEMINI_API_KEY: "test-key",
      },
      async () => {
        await noteWebSearchHealth(
          {
            tools: {
              web: {
                search: {
                  provider: "gemini",
                },
              },
            },
          },
          {
            gatewayWebProbe: {
              checked: true,
              ready: false,
              error: "invalid api key",
            },
          },
        );
      },
    );

    expect(note).toHaveBeenCalledWith(
      expect.stringContaining("Gateway web probe failed: invalid api key"),
      "Web search",
    );
  });
});
