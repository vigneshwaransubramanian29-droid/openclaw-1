import type { OpenClawConfig } from "../../config/config.js";
import type { RuntimeWebSearchMetadata } from "../../secrets/runtime-web-tools.types.js";
import { __testing as runtimeTesting } from "../../web-search/runtime.js";
import type { AnyAgentTool } from "./common.js";
import {
  __testing as coreTesting,
  createWebSearchTool as createWebSearchToolCore,
} from "./web-search-core.js";

export function createWebSearchTool(options?: {
  config?: OpenClawConfig;
  sandboxed?: boolean;
  runtimeWebSearch?: RuntimeWebSearchMetadata;
}): AnyAgentTool | null {
  return createWebSearchToolCore(options);
}

type WebSearchConfig = OpenClawConfig["tools"] extends infer Tools
  ? Tools extends { web?: infer Web }
    ? Web extends { search?: infer Search }
      ? Search
      : undefined
    : undefined
  : undefined;

export type WebSearchProvider = ReturnType<typeof coreTesting.resolveSearchProvider>;

export function resolveWebSearchProvider(search?: WebSearchConfig): WebSearchProvider {
  return coreTesting.resolveSearchProvider(search);
}

export function resolveWebSearchProviderApiKey(
  provider: WebSearchProvider,
  search?: WebSearchConfig,
): string | undefined {
  if (provider === "brave") {
    return coreTesting.resolveSearchApiKey(search);
  }
  if (provider === "gemini") {
    return coreTesting.resolveGeminiApiKey(coreTesting.resolveGeminiConfig(search));
  }
  if (provider === "grok") {
    return coreTesting.resolveGrokApiKey(coreTesting.resolveGrokConfig(search));
  }
  if (provider === "kimi") {
    return coreTesting.resolveKimiApiKey(coreTesting.resolveKimiConfig(search));
  }
  return coreTesting.resolvePerplexityApiKey(coreTesting.resolvePerplexityConfig(search)).apiKey;
}

export function resolveWebSearchMissingKeyPayload(provider: WebSearchProvider) {
  return coreTesting.missingSearchKeyPayload(provider);
}

export const __testing = {
  ...coreTesting,
  resolveSearchProvider: (
    search?: OpenClawConfig["tools"] extends infer Tools
      ? Tools extends { web?: infer Web }
        ? Web extends { search?: infer Search }
          ? Search
          : undefined
        : undefined
      : undefined,
  ) => runtimeTesting.resolveWebSearchProviderId({ search }),
};
