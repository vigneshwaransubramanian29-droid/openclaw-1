import type { OpenClawPluginApi } from "../api.js";
import { ClawboardClient } from "./clients/clawboardClient.js";
import { MemoryClient } from "./clients/memoryClient.js";
import { IdeaPromptService } from "./services/ideaPromptService.js";
import { PlanningExecutionService } from "./services/planningExecutionService.js";
import { RetrievalBudgetService } from "./services/retrievalBudgetService.js";

function emitOutput(payload: unknown, asJson: boolean): void {
  if (asJson) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }
  if (typeof payload === "string") {
    console.log(payload);
    return;
  }
  console.log(JSON.stringify(payload, null, 2));
}

export function registerClawboardMemoryCli(params: {
  api: OpenClawPluginApi;
  clawboardClient: ClawboardClient;
  memoryClient: MemoryClient;
  ideaPromptService: IdeaPromptService;
  planningExecutionService: PlanningExecutionService;
  retrievalBudget: RetrievalBudgetService;
}) {
  return ({ program }: { program: import("commander").Command }) => {
    const memory = program.command("memory").description("External Memory API commands");

    memory
      .command("status")
      .option("--json", "JSON output", false)
      .action(async (options: { json?: boolean }) => {
        try {
          const status = await params.memoryClient.status();
          emitOutput(status, options.json === true);
        } catch (error) {
          emitOutput(
            {
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            },
            true,
          );
          process.exitCode = 1;
        }
      });

    memory
      .command("search")
      .requiredOption("--query <query>", "Search query")
      .option("--namespace <namespace>", "Optional namespace")
      .option("--top-k <topK>", "Result limit")
      .option("--json", "JSON output", false)
      .action(
        async (options: { query: string; namespace?: string; topK?: string; json?: boolean }) => {
          const results = await params.memoryClient.search({
            query: options.query,
            namespace: options.namespace,
            topK: options.topK ? Number(options.topK) : params.retrievalBudget.memories(undefined),
          });
          emitOutput({ count: results.length, results }, options.json === true);
        },
      );

    memory
      .command("get")
      .argument("<memoryId>", "Memory id")
      .option("--json", "JSON output", false)
      .action(async (memoryId: string, options: { json?: boolean }) => {
        const memoryRecord = await params.memoryClient.get(memoryId);
        emitOutput(memoryRecord, options.json === true);
      });

    memory
      .command("save")
      .requiredOption("--title <title>", "Memory title")
      .requiredOption("--summary <summary>", "Memory summary")
      .option("--type <type>", "Memory type")
      .option("--tags <tags>", "Comma-separated tags")
      .option("--task-id <taskId>", "Clawboard task id")
      .option("--source-ref <sourceRef>", "Source session or artifact reference")
      .option("--importance <importance>", "Importance 0-1")
      .option("--facts <facts>", "Comma-separated durable facts")
      .option("--namespace <namespace>", "Namespace")
      .option("--json", "JSON output", false)
      .action(
        async (options: {
          title: string;
          summary: string;
          type?: string;
          tags?: string;
          taskId?: string;
          sourceRef?: string;
          importance?: string;
          facts?: string;
          namespace?: string;
          json?: boolean;
        }) => {
          const memoryRecord = await params.memoryClient.save({
            title: options.title,
            summary: options.summary,
            type:
              (options.type as
                | "decision"
                | "fact"
                | "outcome"
                | "architecture"
                | "workflow"
                | "summary"
                | "other"
                | undefined) ?? "summary",
            tags: splitCsv(options.tags),
            taskId: options.taskId,
            sourceRef: options.sourceRef,
            importance: options.importance ? Number(options.importance) : undefined,
            facts: splitCsv(options.facts),
            namespace: options.namespace,
          });
          emitOutput(memoryRecord, options.json === true);
        },
      );

    const clawboard = program.command("clawboard").description("Clawboard workflow commands");

    clawboard
      .command("ideas")
      .option("--limit <limit>", "Result limit")
      .option("--json", "JSON output", false)
      .action(async (options: { limit?: string; json?: boolean }) => {
        const result = await params.clawboardClient.listItems({
          column: "ideas",
          limit: params.retrievalBudget.ideas(options.limit ? Number(options.limit) : undefined),
        });
        emitOutput({ count: result.items.length, items: result.items }, options.json === true);
      });

    clawboard
      .command("planning")
      .option("--limit <limit>", "Result limit")
      .option("--json", "JSON output", false)
      .action(async (options: { limit?: string; json?: boolean }) => {
        const result = await params.clawboardClient.listItems({
          column: "planning",
          limit: params.retrievalBudget.planning(options.limit ? Number(options.limit) : undefined),
        });
        emitOutput({ count: result.items.length, items: result.items }, options.json === true);
      });

    clawboard
      .command("item")
      .argument("<itemId>", "Clawboard item id")
      .option("--json", "JSON output", false)
      .action(async (itemId: string, options: { json?: boolean }) => {
        const item = await params.clawboardClient.getItem(itemId);
        emitOutput(item, options.json === true);
      });

    clawboard
      .command("generate-prompt")
      .argument("<itemId>", "Idea item id")
      .option("--instructions <instructions>", "Optional extra instructions")
      .option("--json", "JSON output", false)
      .action(async (itemId: string, options: { instructions?: string; json?: boolean }) => {
        const result = await params.ideaPromptService.generateFromIdea({
          itemId,
          workspaceDir: params.api.config.agents?.defaults?.workspace ?? process.cwd(),
          optionalInstructions: options.instructions,
        });
        emitOutput(result, options.json === true);
      });

    clawboard
      .command("run-once")
      .option("--item-id <itemId>", "Specific planning item id")
      .option("--agent-id <agentId>", "Execution agent id")
      .option("--json", "JSON output", false)
      .action(async (options: { itemId?: string; agentId?: string; json?: boolean }) => {
        const workspaceDir = params.api.config.agents?.defaults?.workspace ?? process.cwd();
        const result = options.itemId
          ? await params.planningExecutionService.executePlanningTask({
              workspaceDir,
              itemId: options.itemId,
              agentId: options.agentId,
              triggeredBy: "cli",
            })
          : await params.planningExecutionService.executeNextPlanningTask({
              workspaceDir,
              agentId: options.agentId,
              triggeredBy: "cli",
            });
        emitOutput(result, options.json === true);
      });
  };
}

function splitCsv(value?: string): string[] {
  if (!value) {
    return [];
  }
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}
