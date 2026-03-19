import type {
  OpenClawPluginService,
  OpenClawPluginServiceContext,
  PluginLogger,
} from "../../api.js";
import type { ClawboardMemoryPluginSettings } from "../config/settings.js";
import { createComponentLogger } from "../utils/logger.js";
import { PlanningExecutionService } from "./planningExecutionService.js";

export function createPlanningPollerService(params: {
  executionService: PlanningExecutionService;
  settings: ClawboardMemoryPluginSettings["workflow"]["automation"]["planningPoll"];
  logger: PluginLogger;
}): OpenClawPluginService {
  const logger = createComponentLogger(params.logger, "planning-poller");
  let timer: ReturnType<typeof setInterval> | null = null;
  let running = false;

  async function tick(ctx: OpenClawPluginServiceContext): Promise<void> {
    if (running) {
      return;
    }
    running = true;
    try {
      const result = await params.executionService.executeNextPlanningTask({
        workspaceDir: ctx.workspaceDir ?? process.cwd(),
        agentId: params.settings.agentId,
        triggeredBy: "planning-poller",
        claimBeforeStart: params.settings.claimBeforeStart,
      });
      if (result.executed) {
        logger.info(`executed planning task ${result.item.id}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(`planning poll failed: ${message}`);
      if (params.settings.stopOnError && timer) {
        clearInterval(timer);
        timer = null;
      }
    } finally {
      running = false;
    }
  }

  return {
    id: "clawboard-planning-poller",
    async start(ctx) {
      if (!params.settings.enabled) {
        return;
      }
      await tick(ctx).catch(() => {});
      timer = setInterval(() => {
        void tick(ctx);
      }, params.settings.intervalMs);
      timer.unref?.();
      logger.info(`planning poller started (${params.settings.intervalMs}ms)`);
    },
    async stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      logger.info("planning poller stopped");
    },
  };
}
