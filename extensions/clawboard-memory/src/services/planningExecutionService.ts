import type { OpenClawPluginApi, PluginLogger } from "../../api.js";
import { ClawboardClient } from "../clients/clawboardClient.js";
import { MemoryClient } from "../clients/memoryClient.js";
import type { ClawboardMemoryPluginSettings } from "../config/settings.js";
import type { ClawboardItem } from "../types/clawboard.js";
import type { MemoryRecord } from "../types/memory.js";
import { MemorySaveInputSchema } from "../types/memory.js";
import { ExecutionOutcomeSchema, type ExecutionOutcome } from "../types/tool.js";
import {
  collectTextPayloads,
  extractArtifactLinks,
  runEmbeddedTask,
  runJsonEmbeddedTask,
} from "../utils/embeddedAgent.js";
import { createComponentLogger } from "../utils/logger.js";
import { uniqueStrings } from "../utils/validation.js";
import { BreadcrumbService } from "./breadcrumbService.js";
import { MemoryContextService } from "./memoryContextService.js";

type ExecutionSettings = ClawboardMemoryPluginSettings["workflow"]["execution"];
type AutomationSettings = ClawboardMemoryPluginSettings["workflow"]["automation"]["planningPoll"];

export type PlanningExecutionResult =
  | {
      executed: false;
      reason: "no_planning_task";
    }
  | {
      executed: true;
      item: ClawboardItem;
      resultSummary: string;
      executionText: string;
      memoryRecord: MemoryRecord | null;
      warnings: string[];
    };

export class PlanningExecutionService {
  private readonly logger: PluginLogger;

  constructor(
    private readonly api: OpenClawPluginApi,
    private readonly clawboardClient: ClawboardClient,
    private readonly memoryClient: MemoryClient,
    private readonly memoryContextService: MemoryContextService,
    private readonly breadcrumbService: BreadcrumbService,
    private readonly executionSettings: ExecutionSettings,
    private readonly automationSettings: AutomationSettings,
    logger: PluginLogger,
  ) {
    this.logger = createComponentLogger(logger, "planning-execution");
  }

  async executeNextPlanningTask(params: {
    workspaceDir: string;
    agentId?: string;
    sessionKey?: string;
    triggeredBy?: string;
    claimBeforeStart?: boolean;
  }): Promise<PlanningExecutionResult> {
    const item = await this.clawboardClient.getNextPlanningTask(params.agentId);
    if (!item) {
      return {
        executed: false,
        reason: "no_planning_task",
      };
    }
    return await this.executePlanningTask({
      ...params,
      itemId: item.id,
    });
  }

  async executePlanningTask(params: {
    workspaceDir: string;
    itemId: string;
    agentId?: string;
    sessionKey?: string;
    triggeredBy?: string;
    claimBeforeStart?: boolean;
  }): Promise<PlanningExecutionResult> {
    const warnings: string[] = [];
    const item = await this.clawboardClient.getItem(params.itemId);
    const agentId = params.agentId?.trim() || this.automationSettings.agentId;
    const claimBeforeStart = params.claimBeforeStart ?? this.automationSettings.claimBeforeStart;
    let started = false;

    try {
      if (claimBeforeStart && agentId) {
        try {
          await this.clawboardClient.claimTask(item.id, agentId);
        } catch (error) {
          warnings.push(
            `Task claim failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }

      const memoryContext = await this.memoryContextService.buildContext({
        item,
        namespace: this.executionSettings.memorySearchNamespace,
      });
      warnings.push(...memoryContext.warnings);

      await this.clawboardClient.startTask({
        itemId: item.id,
        agentId,
        note: `Started by OpenClaw (${params.triggeredBy ?? "manual"})`,
      });
      started = true;

      await this.breadcrumbService.write({
        activeTaskId: item.id,
        activeTaskTitle: item.title,
        agentId,
        sessionKey: params.sessionKey,
      });

      if (this.executionSettings.addProgressNotes && memoryContext.query) {
        await this.clawboardClient
          .addNote(
            item.id,
            `Execution context prepared. Memory query: ${memoryContext.query}. Hits: ${memoryContext.hits.length}.`,
          )
          .catch(() => {});
      }

      const executionRun = await runEmbeddedTask({
        api: this.api,
        prompt: buildExecutionPrompt(item, memoryContext.contextText),
        workspaceDir: params.workspaceDir,
        sessionPrefix: `clawboard-task-${sanitizeId(item.id)}`,
        timeoutMs: this.executionSettings.timeoutMs,
        provider: this.executionSettings.provider,
        model: this.executionSettings.model,
        authProfileId: this.executionSettings.authProfileId,
        extraSystemPrompt:
          "You are executing an approved Planning task. Use tools when needed. Keep context compact. Do not move Clawboard stages yourself unless explicitly asked.",
      });

      const executionText = collectTextPayloads(
        (executionRun as { payloads?: Array<{ text?: string; isError?: boolean }> }).payloads,
      );
      if (!executionText) {
        throw new Error("Task execution returned no assistant text");
      }

      const outcome = await this.distillExecutionOutcome({
        item,
        executionText,
        workspaceDir: params.workspaceDir,
        sessionKey: params.sessionKey,
      });
      warnings.push(...outcome.warnings);

      let memoryRecord: MemoryRecord | null = null;
      try {
        memoryRecord = await this.memoryClient.save(
          outcome.memoryDraft ??
            buildFallbackMemoryDraft(item, outcome.resultSummary, params.sessionKey),
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!this.executionSettings.allowFinishWithoutMemorySave) {
          throw error;
        }
        if (this.executionSettings.saveFailureAsWarning) {
          warnings.push(`Memory save failed: ${message}`);
        }
      }

      const artifactLinks = uniqueStrings([
        ...(outcome.artifactLinks ?? []),
        ...extractArtifactLinks(executionText),
      ]);

      await this.clawboardClient.finishTask({
        itemId: item.id,
        resultSummary: outcome.resultSummary,
        memoryId: memoryRecord?.id,
        artifactLinks,
      });

      await this.breadcrumbService.write({
        activeTaskId: undefined,
        activeTaskTitle: undefined,
        lastMemoryId: memoryRecord?.id,
        lastDecision: outcome.memoryDraft?.facts[0] ?? outcome.resultSummary,
        agentId,
        sessionKey: params.sessionKey,
      });

      return {
        executed: true,
        item,
        resultSummary: outcome.resultSummary,
        executionText,
        memoryRecord,
        warnings,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (started) {
        await this.clawboardClient.addNote(item.id, `Execution failed: ${message}`).catch(() => {});
      }
      await this.breadcrumbService.write({
        activeTaskId: item.id,
        activeTaskTitle: item.title,
        lastDecision: `Execution failed: ${message}`,
        agentId,
        sessionKey: params.sessionKey,
      });
      throw error;
    }
  }

  private async distillExecutionOutcome(params: {
    item: ClawboardItem;
    executionText: string;
    workspaceDir: string;
    sessionKey?: string;
  }): Promise<ExecutionOutcome> {
    const prompt = [
      "Distill this completed OpenClaw task into durable, low-context workflow output.",
      "Return JSON with these fields only:",
      "- resultSummary",
      "- artifactLinks",
      "- memoryDraft",
      "- warnings",
      "",
      "Rules:",
      "- resultSummary must be concise and operator-friendly.",
      "- memoryDraft should store only durable decisions, outcomes, or reusable facts.",
      "- Avoid transcript dumps.",
      "",
      `Task ID: ${params.item.id}`,
      `Task title: ${params.item.title}`,
      `Task tags: ${params.item.tags.join(", ") || "(none)"}`,
      `Execution output:\n${params.executionText.slice(0, 12_000)}`,
    ].join("\n");

    const distilled = await runJsonEmbeddedTask({
      api: this.api,
      prompt,
      schema: ExecutionOutcomeSchema,
      workspaceDir: params.workspaceDir,
      sessionPrefix: `clawboard-distill-${sanitizeId(params.item.id)}`,
      timeoutMs: Math.min(this.executionSettings.timeoutMs, 120_000),
      provider: this.executionSettings.provider,
      model: this.executionSettings.model,
      authProfileId: this.executionSettings.authProfileId,
      extraSystemPrompt:
        "You are compressing task outcomes into a small structured summary for Clawboard and durable memory storage.",
    });

    const memoryDraft = distilled.memoryDraft
      ? MemorySaveInputSchema.parse({
          ...distilled.memoryDraft,
          tags: uniqueStrings([
            ...(distilled.memoryDraft.tags ?? []),
            ...params.item.tags,
            "clawboard",
            "openclaw",
          ]),
          taskId: distilled.memoryDraft.taskId ?? params.item.id,
          sourceRef: distilled.memoryDraft.sourceRef ?? params.sessionKey,
        })
      : undefined;

    return {
      ...distilled,
      artifactLinks: uniqueStrings(distilled.artifactLinks),
      memoryDraft,
    };
  }
}

function buildExecutionPrompt(item: ClawboardItem, memoryContext: string): string {
  const noteLines = item.notes.map((note) => `- ${note.text ?? ""}`).join("\n");
  return [
    "Execute this approved Clawboard Planning task.",
    "Workflow rules:",
    "- Planning is the approved execution queue.",
    "- Use tools selectively.",
    "- Prefer the task context first; expand more memory only if needed.",
    "- Keep the final answer concise and implementation-focused.",
    "",
    `Task ID: ${item.id}`,
    `Title: ${item.title}`,
    `Description: ${item.description ?? ""}`,
    `Tags: ${item.tags.join(", ") || "(none)"}`,
    `Prompt draft: ${item.promptDraft ?? "(none)"}`,
    `Notes:\n${noteLines || "(none)"}`,
    memoryContext
      ? `Relevant memory context:\n${memoryContext}`
      : "Relevant memory context: (none)",
  ].join("\n");
}

function buildFallbackMemoryDraft(item: ClawboardItem, resultSummary: string, sessionKey?: string) {
  return MemorySaveInputSchema.parse({
    title: item.title,
    summary: resultSummary,
    type: "outcome",
    tags: uniqueStrings([...item.tags, "clawboard", "openclaw"]),
    taskId: item.id,
    sourceRef: sessionKey,
    importance: 0.75,
    facts: [],
  });
}

function sanitizeId(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
}
