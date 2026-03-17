import {
  resolveWebSearchMissingKeyPayload,
  resolveWebSearchProvider,
  resolveWebSearchProviderApiKey,
} from "../agents/tools/web-search.js";
import { formatCliCommand } from "../cli/command-format.js";
import type { OpenClawConfig } from "../config/config.js";
import { note } from "../terminal/note.js";

export type GatewayWebSearchProbe = {
  checked: boolean;
  ready: boolean;
  provider?: string;
  error?: string;
};

export async function noteWebSearchHealth(
  cfg: OpenClawConfig,
  opts?: {
    gatewayWebProbe?: GatewayWebSearchProbe;
  },
): Promise<void> {
  const search = cfg.tools?.web?.search;
  if (search?.enabled === false) {
    note("Web search is explicitly disabled (tools.web.search.enabled=false).", "Web search");
    return;
  }

  const configuredProvider =
    typeof search?.provider === "string" ? search.provider.trim().toLowerCase() : "";
  const provider = resolveWebSearchProvider(search);
  const gatewayProbeWarning = buildGatewayProbeWarning(opts?.gatewayWebProbe);

  if (configuredProvider && configuredProvider !== "auto") {
    const apiKey = resolveWebSearchProviderApiKey(provider, search);
    if (apiKey) {
      if (gatewayProbeWarning) {
        note(
          [
            `web_search provider resolved to "${provider}" and credentials were found,`,
            "but the gateway probe failed.",
            gatewayProbeWarning,
            "",
            `Verify: ${formatCliCommand("openclaw doctor --deep")}`,
          ].join("\n"),
          "Web search",
        );
      }
      return;
    }

    const missing = resolveWebSearchMissingKeyPayload(provider);
    if (opts?.gatewayWebProbe?.checked && opts.gatewayWebProbe.ready) {
      note(
        [
          `web_search provider is set to "${provider}" but the API key was not found in the CLI environment.`,
          `The running gateway reports web search is ready for provider "${opts.gatewayWebProbe.provider ?? provider}".`,
          `Verify: ${formatCliCommand("openclaw doctor --deep")}`,
        ].join("\n"),
        "Web search",
      );
      return;
    }

    note(
      [
        missing.message,
        gatewayProbeWarning ? gatewayProbeWarning : null,
        "",
        `Verify: ${formatCliCommand("openclaw doctor --deep")}`,
      ]
        .filter(Boolean)
        .join("\n"),
      "Web search",
    );
    return;
  }

  const autoProviders = ["brave", "gemini", "grok", "kimi", "perplexity"] as const;
  const availableProviders = autoProviders.filter((candidate) =>
    Boolean(resolveWebSearchProviderApiKey(candidate, search)),
  );
  if (availableProviders.length > 0) {
    if (gatewayProbeWarning) {
      note(
        [
          `web_search provider auto-detected "${provider}" from available credentials,`,
          "but the gateway probe failed.",
          gatewayProbeWarning,
          "",
          `Verify: ${formatCliCommand("openclaw doctor --deep")}`,
        ].join("\n"),
        "Web search",
      );
    }
    return;
  }

  if (opts?.gatewayWebProbe?.checked && opts.gatewayWebProbe.ready) {
    note(
      [
        'web_search provider is set to "auto" but no API key was found in the CLI environment.',
        `The running gateway reports web search is ready for provider "${opts.gatewayWebProbe.provider ?? provider}".`,
        `Verify: ${formatCliCommand("openclaw doctor --deep")}`,
      ].join("\n"),
      "Web search",
    );
    return;
  }

  note(
    [
      'web_search provider is set to "auto" but no supported provider credentials were found.',
      gatewayProbeWarning ? gatewayProbeWarning : null,
      "",
      "Fix (pick one):",
      "- Set BRAVE_API_KEY, GEMINI_API_KEY, XAI_API_KEY, KIMI_API_KEY or MOONSHOT_API_KEY, PERPLEXITY_API_KEY, or OPENROUTER_API_KEY in the gateway environment",
      `- Configure credentials: ${formatCliCommand("openclaw configure --section web")}`,
      "",
      `Verify: ${formatCliCommand("openclaw doctor --deep")}`,
    ]
      .filter(Boolean)
      .join("\n"),
    "Web search",
  );
}

function buildGatewayProbeWarning(probe: GatewayWebSearchProbe | undefined): string | null {
  if (!probe?.checked || probe.ready) {
    return null;
  }
  const detail = probe.error?.trim();
  return detail ? `Gateway web probe failed: ${detail}` : "Gateway web probe failed.";
}
