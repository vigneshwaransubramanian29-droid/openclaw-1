import { listAgentIds } from "../agents/agent-scope.js";
import { resolveMemorySearchConfig } from "../agents/memory-search.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolveMemoryBackendConfig } from "../memory/backend-config.js";
import { getMemorySearchManager } from "../memory/index.js";

export async function startGatewayMemoryBackend(params: {
  cfg: OpenClawConfig;
  log: { info?: (msg: string) => void; warn: (msg: string) => void };
}): Promise<void> {
  const agentIds = listAgentIds(params.cfg);
  for (const agentId of agentIds) {
    if (!resolveMemorySearchConfig(params.cfg, agentId)) {
      continue;
    }
    const memorySearch = resolveMemorySearchConfig(params.cfg, agentId);
    if (!memorySearch) {
      continue;
    }
    const resolved = resolveMemoryBackendConfig({ cfg: params.cfg, agentId });
    const shouldInitQmd = resolved.backend === "qmd" && Boolean(resolved.qmd);
    const shouldInitSqliteSidecar = memorySearch.sqliteMemory.enabled;
    if (!shouldInitQmd && !shouldInitSqliteSidecar) {
      continue;
    }

    const { manager, error } = await getMemorySearchManager({ cfg: params.cfg, agentId });
    if (!manager) {
      params.log.warn(
        `qmd memory startup initialization failed for agent "${agentId}": ${error ?? "unknown error"}`,
      );
      continue;
    }
    const armed: string[] = [];
    if (shouldInitQmd) {
      armed.push("qmd");
    }
    if (shouldInitSqliteSidecar) {
      armed.push("sqlite sidecar");
    }
    params.log.info?.(
      `${armed.join(" + ")} memory startup initialization armed for agent "${agentId}"`,
    );
  }
}
