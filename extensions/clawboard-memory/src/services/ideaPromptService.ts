import type { OpenClawPluginApi, PluginLogger } from "../../api.js";
import { ClawboardClient } from "../clients/clawboardClient.js";
import type { ClawboardMemoryPluginSettings } from "../config/settings.js";
import type { ClawboardItem } from "../types/clawboard.js";
import { PromptDraftSchema, type PromptDraft } from "../types/tool.js";
import { runJsonEmbeddedTask } from "../utils/embeddedAgent.js";
import { createComponentLogger } from "../utils/logger.js";

type PromptSettings = ClawboardMemoryPluginSettings["workflow"]["promptGeneration"];

export class IdeaPromptService {
  private readonly logger: PluginLogger;

  constructor(
    private readonly api: OpenClawPluginApi,
    private readonly clawboardClient: ClawboardClient,
    private readonly settings: PromptSettings,
    logger: PluginLogger,
  ) {
    this.logger = createComponentLogger(logger, "idea-prompt");
  }

  async generateFromIdea(params: {
    itemId: string;
    workspaceDir: string;
    optionalInstructions?: string;
  }): Promise<{ item: ClawboardItem; draft: PromptDraft }> {
    const item = await this.clawboardClient.getItem(params.itemId);
    return {
      item,
      draft: await this.generateFromItem({
        item,
        workspaceDir: params.workspaceDir,
        optionalInstructions: params.optionalInstructions,
      }),
    };
  }

  async generateFromItem(params: {
    item: ClawboardItem;
    workspaceDir: string;
    optionalInstructions?: string;
  }): Promise<PromptDraft> {
    const prompt = buildIdeaPrompt({
      item: params.item,
      optionalInstructions: params.optionalInstructions,
    });

    this.logger.info(`generating prompt draft for idea ${params.item.id}`);

    return await runJsonEmbeddedTask({
      api: this.api,
      prompt,
      schema: PromptDraftSchema,
      workspaceDir: params.workspaceDir,
      sessionPrefix: `clawboard-idea-${sanitizeId(params.item.id)}`,
      timeoutMs: this.settings.timeoutMs,
      provider: this.settings.provider,
      model: this.settings.model,
      authProfileId: this.settings.authProfileId,
      extraSystemPrompt:
        "You refine raw ideas into concise execution-ready prompts. Do not execute the task.",
    });
  }
}

function buildIdeaPrompt(params: { item: ClawboardItem; optionalInstructions?: string }): string {
  const noteLines = params.item.notes.map((note) => `- ${note.text ?? ""}`).join("\n");
  return [
    "Transform this Clawboard idea into an execution-ready prompt draft.",
    "Return JSON with these fields only:",
    "- cleanedTitle",
    "- problemStatement",
    "- assumptions",
    "- constraints",
    "- deliverables",
    "- finalWorkingPrompt",
    "- summary",
    "",
    "Workflow rules:",
    "- This is idea refinement only, not execution.",
    "- Planning is the execution queue.",
    "- Keep the output low-context and concrete.",
    "",
    `Idea ID: ${params.item.id}`,
    `Title: ${params.item.title}`,
    `Description: ${params.item.description ?? ""}`,
    `Tags: ${params.item.tags.join(", ") || "(none)"}`,
    `Existing prompt draft: ${params.item.promptDraft ?? "(none)"}`,
    `Notes:\n${noteLines || "(none)"}`,
    params.optionalInstructions
      ? `Operator instructions:\n${params.optionalInstructions}`
      : "Operator instructions: (none)",
  ].join("\n");
}

function sanitizeId(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
}
