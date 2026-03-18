import type {
  AcpRuntime,
  OpenClawPluginService,
  OpenClawPluginServiceContext,
  PluginLogger,
} from "openclaw/plugin-sdk/acpx";
import { registerAcpRuntimeBackend, unregisterAcpRuntimeBackend } from "openclaw/plugin-sdk/acpx";
import { resolveAcpxPluginConfig, type ResolvedAcpxPluginConfig } from "./config.js";
import { ensureAcpx } from "./ensure.js";
import { ACPX_BACKEND_ID, AcpxRuntime } from "./runtime.js";

type AcpxRuntimeLike = AcpRuntime & {
  probeAvailability(): Promise<void>;
  isHealthy(): boolean;
};

type AcpxRuntimeFactoryParams = {
  pluginConfig: ResolvedAcpxPluginConfig;
  queueOwnerTtlSeconds: number;
  logger?: PluginLogger;
};

type CreateAcpxRuntimeServiceParams = {
  pluginConfig?: unknown;
  runtimeFactory?: (params: AcpxRuntimeFactoryParams) => AcpxRuntimeLike;
};

function createDefaultRuntime(params: AcpxRuntimeFactoryParams): AcpxRuntimeLike {
  return new AcpxRuntime(params.pluginConfig, {
    logger: params.logger,
    queueOwnerTtlSeconds: params.queueOwnerTtlSeconds,
  });
}

export function createAcpxRuntimeService(
  params: CreateAcpxRuntimeServiceParams = {},
): OpenClawPluginService {
  let runtime: AcpxRuntimeLike | null = null;
  let lifecycleRevision = 0;
  let healthState: "pending" | "ready" | "failed" = "pending";

  return {
    id: "acpx-runtime",
    async start(ctx: OpenClawPluginServiceContext): Promise<void> {
      const pluginConfig = resolveAcpxPluginConfig({
        rawConfig: params.pluginConfig,
        workspaceDir: ctx.workspaceDir,
      });
      const runtimeFactory = params.runtimeFactory ?? createDefaultRuntime;
      runtime = runtimeFactory({
        pluginConfig,
        queueOwnerTtlSeconds: pluginConfig.queueOwnerTtlSeconds,
        logger: ctx.logger,
      });
      healthState = "pending";

      registerAcpRuntimeBackend({
        id: ACPX_BACKEND_ID,
        runtime,
        healthy: () => {
          if (!runtime) {
            return false;
          }
          if (healthState === "pending") {
            return true;
          }
          if (healthState === "failed") {
            return false;
          }
          return runtime.isHealthy();
        },
      });
      const expectedVersionLabel = pluginConfig.expectedVersion ?? "any";
      const installLabel = pluginConfig.allowPluginLocalInstall ? "enabled" : "disabled";
      ctx.logger.info(
        `acpx runtime backend registered (command: ${pluginConfig.command}, expectedVersion: ${expectedVersionLabel}, pluginLocalInstall: ${installLabel})`,
      );

      lifecycleRevision += 1;
      const currentRevision = lifecycleRevision;
      void (async () => {
        try {
          await ensureAcpx({
            command: pluginConfig.command,
            logger: ctx.logger,
            expectedVersion: pluginConfig.expectedVersion,
            allowInstall: pluginConfig.allowPluginLocalInstall,
            stripProviderAuthEnvVars: pluginConfig.stripProviderAuthEnvVars,
            spawnOptions: {
              strictWindowsCmdWrapper: pluginConfig.strictWindowsCmdWrapper,
            },
          });
          if (currentRevision !== lifecycleRevision) {
            return;
          }
          await runtime?.probeAvailability();
          if (runtime?.isHealthy()) {
            healthState = "ready";
            ctx.logger.info("acpx runtime backend ready");
          } else {
            healthState = "failed";
            ctx.logger.warn("acpx runtime backend probe failed after local install");
          }
        } catch (err) {
          if (currentRevision !== lifecycleRevision) {
            return;
          }
          healthState = "failed";
          ctx.logger.warn(
            `acpx runtime setup failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      })();
    },
    async stop(_ctx: OpenClawPluginServiceContext): Promise<void> {
      lifecycleRevision += 1;
      healthState = "failed";
      unregisterAcpRuntimeBackend(ACPX_BACKEND_ID);
      runtime = null;
    },
  };
}
