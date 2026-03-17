import { resolveDefaultAgentId } from "../../agents/agent-scope.js";
import {
  createWebSearchTool,
  resolveWebSearchProvider,
} from "../../agents/tools/web-search.js";
import { loadConfig } from "../../config/config.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { getMemorySearchManager } from "../../memory/index.js";
import { formatError } from "../server-utils.js";
import type { GatewayRequestHandlers } from "./types.js";

const log = createSubsystemLogger("gateway");

export type DoctorMemoryStatusPayload = {
  agentId: string;
  provider?: string;
  embedding: {
    ok: boolean;
    error?: string;
  };
};

export type DoctorWebStatusPayload = {
  provider?: string;
  search: {
    ok: boolean;
    error?: string;
  };
};

export const doctorHandlers: GatewayRequestHandlers = {
  "doctor.memory.status": async ({ respond }) => {
    const cfg = loadConfig();
    const agentId = resolveDefaultAgentId(cfg);
    const { manager, error } = await getMemorySearchManager({
      cfg,
      agentId,
      purpose: "status",
    });
    if (!manager) {
      const payload: DoctorMemoryStatusPayload = {
        agentId,
        embedding: {
          ok: false,
          error: error ?? "memory search unavailable",
        },
      };
      respond(true, payload, undefined);
      return;
    }

    try {
      const status = manager.status();
      let embedding = await manager.probeEmbeddingAvailability();
      if (!embedding.ok && !embedding.error) {
        embedding = { ok: false, error: "memory embeddings unavailable" };
      }
      const payload: DoctorMemoryStatusPayload = {
        agentId,
        provider: status.provider,
        embedding,
      };
      respond(true, payload, undefined);
    } catch (err) {
      const payload: DoctorMemoryStatusPayload = {
        agentId,
        embedding: {
          ok: false,
          error: `gateway memory probe failed: ${formatError(err)}`,
        },
      };
      respond(true, payload, undefined);
    } finally {
      await manager.close?.().catch((err: unknown) => {
        log.debug(`doctor memory manager close error: ${String(err)}`);
      });
    }
  },
  "doctor.web.status": async ({ respond }) => {
    const cfg = loadConfig();
    const search = cfg.tools?.web?.search;
    const provider = search?.enabled === false ? undefined : resolveWebSearchProvider(search);
    const tool = createWebSearchTool({ config: cfg, sandboxed: false });
    if (!tool) {
      const payload: DoctorWebStatusPayload = {
        provider,
        search: {
          ok: false,
          error: "web search is disabled in config",
        },
      };
      respond(true, payload, undefined);
      return;
    }

    try {
      const result = await tool.execute("doctor-web-status", {
        query: "OpenClaw",
        count: 1,
      });
      const details =
        result && typeof result === "object" && "details" in result
          ? (result.details as Record<string, unknown> | undefined)
          : undefined;
      const errorMessage =
        typeof details?.message === "string"
          ? details.message
          : typeof details?.error === "string"
            ? details.error
            : undefined;
      const payload: DoctorWebStatusPayload = {
        provider:
          typeof details?.provider === "string" ? details.provider : provider ?? undefined,
        search: errorMessage
          ? {
              ok: false,
              error: errorMessage,
            }
          : {
              ok: true,
            },
      };
      respond(true, payload, undefined);
    } catch (err) {
      const payload: DoctorWebStatusPayload = {
        provider,
        search: {
          ok: false,
          error: `gateway web probe failed: ${formatError(err)}`,
        },
      };
      respond(true, payload, undefined);
    }
  },
};
