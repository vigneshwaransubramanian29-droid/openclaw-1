import { resolveAcpDispatchPolicyMessage } from "../acp/policy.js";
import { requireAcpRuntimeBackend } from "../acp/runtime/registry.js";
import { formatCliCommand } from "../cli/command-format.js";
import type { OpenClawConfig } from "../config/config.js";
import { note } from "../terminal/note.js";

const ACP_DEFAULT_AGENT_MISSING_MESSAGE =
  "ACP target agent is not configured. Pass `agentId` in `sessions_spawn` or set `acp.defaultAgent` in config.";

export async function noteAcpHealth(cfg: OpenClawConfig): Promise<void> {
  const policyMessage = resolveAcpDispatchPolicyMessage(cfg);
  if (policyMessage) {
    const fix =
      cfg.acp?.enabled === false
        ? formatCliCommand("openclaw config set acp.enabled true")
        : formatCliCommand("openclaw config set acp.dispatch.enabled true");
    note([policyMessage, `Fix: ${fix}`].join("\n"), "ACP");
    return;
  }

  try {
    requireAcpRuntimeBackend(cfg.acp?.backend);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    note(
      [
        message,
        `Fix: ${formatCliCommand("openclaw doctor --deep")} and install/enable the acpx runtime plugin.`,
      ].join("\n"),
      "ACP",
    );
  }

  const defaultAgent = cfg.acp?.defaultAgent?.trim();
  if (defaultAgent) {
    return;
  }
  note(
    [
      ACP_DEFAULT_AGENT_MISSING_MESSAGE,
      `Fix: ${formatCliCommand("openclaw config set acp.defaultAgent codex")} or pass agentId explicitly when spawning ACP sessions.`,
    ].join("\n"),
    "ACP",
  );
}
