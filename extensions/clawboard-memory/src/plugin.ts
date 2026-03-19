import path from "node:path";
import { definePluginEntry, type OpenClawPluginApi } from "../api.js";
import { registerClawboardMemoryCli } from "./cli.js";
import { ClawboardClient } from "./clients/clawboardClient.js";
import { MemoryClient } from "./clients/memoryClient.js";
import { clawboardMemoryPluginConfigSchema, resolvePluginSettings } from "./config/settings.js";
import { BreadcrumbService } from "./services/breadcrumbService.js";
import { IdeaPromptService } from "./services/ideaPromptService.js";
import { MemoryContextService } from "./services/memoryContextService.js";
import { PlanningExecutionService } from "./services/planningExecutionService.js";
import { createPlanningPollerService } from "./services/planningPollerService.js";
import { RetrievalBudgetService } from "./services/retrievalBudgetService.js";
import { createClawboardTools } from "./tools/clawboardTools.js";
import { createMemoryTools } from "./tools/memoryTools.js";

function resolveBreadcrumbPath(api: OpenClawPluginApi, fileName: string): string {
  return path.join(api.runtime.state.resolveStateDir(), "plugins", "clawboard-memory", fileName);
}

export default definePluginEntry({
  id: "clawboard-memory",
  name: "Clawboard + Memory API",
  description:
    "Plugin-first Clawboard workflow orchestration backed by an external durable Memory API.",
  kind: "memory",
  configSchema: clawboardMemoryPluginConfigSchema,
  register(api) {
    const settings = resolvePluginSettings(api.pluginConfig);
    const clawboardClient = new ClawboardClient(
      settings.clawboard,
      settings.workflow.columns,
      api.logger,
    );
    const memoryClient = new MemoryClient(settings.memoryApi, api.logger);
    const retrievalBudget = new RetrievalBudgetService(settings.workflow.retrieval);
    const breadcrumbService = new BreadcrumbService(
      resolveBreadcrumbPath(api, settings.workflow.breadcrumb.fileName),
      api.logger,
    );
    const memoryContextService = new MemoryContextService(
      memoryClient,
      retrievalBudget,
      api.logger,
    );
    const ideaPromptService = new IdeaPromptService(
      api,
      clawboardClient,
      settings.workflow.promptGeneration,
      api.logger,
    );
    const planningExecutionService = new PlanningExecutionService(
      api,
      clawboardClient,
      memoryClient,
      memoryContextService,
      breadcrumbService,
      settings.workflow.execution,
      settings.workflow.automation.planningPoll,
      api.logger,
    );

    api.registerTool(
      (ctx) => [
        ...createMemoryTools({
          memoryClient,
          settings: settings.memoryApi,
        }),
        ...createClawboardTools({
          clawboardClient,
          ideaPromptService,
          planningExecutionService,
          retrievalBudget,
          toolContext: ctx,
        }),
      ],
      {
        names: [
          "memory_search",
          "memory_get",
          "memory_save",
          "memory_upsert_fact",
          "clawboard_create_idea",
          "clawboard_get_ideas",
          "clawboard_get_prompt_ideas",
          "clawboard_get_planning_tasks",
          "clawboard_get_item",
          "clawboard_generate_prompt_from_idea",
          "clawboard_save_prompt_idea",
          "clawboard_move_to_prompt_ideas",
          "clawboard_move_to_planning",
          "clawboard_get_next_planning_task",
          "clawboard_start_task",
          "clawboard_update_task_progress",
          "clawboard_finish_task",
          "clawboard_move_item",
          "clawboard_add_note",
          "clawboard_claim_task",
          "clawboard_process_idea_to_prompt",
          "clawboard_execute_planning_task",
        ],
      },
    );

    api.registerCli(
      registerClawboardMemoryCli({
        api,
        clawboardClient,
        memoryClient,
        ideaPromptService,
        planningExecutionService,
        retrievalBudget,
      }),
      { commands: ["memory", "clawboard"] },
    );

    api.registerService(
      createPlanningPollerService({
        executionService: planningExecutionService,
        settings: settings.workflow.automation.planningPoll,
        logger: api.logger,
      }),
    );

    api.on("before_prompt_build", async () => ({
      prependSystemContext: [
        "## Clawboard Workflow",
        "When Clawboard tools are available, treat Clawboard as workflow state and the external Memory API as durable memory.",
        "Ideas are intake only. Generate prompt drafts first. Only Planning is the approved execution queue.",
        "memory_search and memory_get point to the configured external Memory API; use them selectively and keep retrieval small.",
      ].join("\n"),
    }));
  },
});
