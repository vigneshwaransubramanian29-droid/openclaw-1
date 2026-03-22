import { Type } from "@sinclair/typebox";
import type { AnyAgentTool, OpenClawPluginToolContext } from "../../api.js";
import { jsonResult, readNumberParam, readStringArrayParam, readStringParam } from "../../api.js";
import { ClawboardClient } from "../clients/clawboardClient.js";
import { IdeaPromptService } from "../services/ideaPromptService.js";
import { PlanningExecutionService } from "../services/planningExecutionService.js";
import { RetrievalBudgetService } from "../services/retrievalBudgetService.js";
import type { ClawboardLogicalColumn } from "../types/clawboard.js";

const LimitSchema = Type.Object(
  {
    limit: Type.Optional(
      Type.Number({
        description: "Maximum number of items to fetch.",
        minimum: 1,
        maximum: 25,
      }),
    ),
  },
  { additionalProperties: false },
);

const CreateIdeaSchema = Type.Object(
  {
    title: Type.String({ description: "Idea title." }),
    description: Type.Optional(Type.String({ description: "Idea description." })),
    tags: Type.Optional(Type.Array(Type.String(), { description: "Optional tags." })),
    note: Type.Optional(Type.String({ description: "Optional initial note." })),
  },
  { additionalProperties: false },
);

const GeneratePromptSchema = Type.Object(
  {
    itemId: Type.String({ description: "Idea item id." }),
    optionalInstructions: Type.Optional(
      Type.String({ description: "Optional operator instructions for prompt generation." }),
    ),
  },
  { additionalProperties: false },
);

const SavePromptIdeaSchema = Type.Object(
  {
    itemId: Type.String({ description: "Idea item id." }),
    promptDraft: Type.String({ description: "Generated prompt draft text." }),
    summary: Type.Optional(Type.String({ description: "Short summary." })),
    assumptions: Type.Optional(Type.Array(Type.String(), { description: "Optional assumptions." })),
  },
  { additionalProperties: false },
);

const MoveItemSchema = Type.Object(
  {
    itemId: Type.String({ description: "Item id." }),
    targetColumn: Type.String({ description: "Logical column key or configured column label." }),
    note: Type.Optional(Type.String({ description: "Optional note." })),
  },
  { additionalProperties: false },
);

const StartTaskSchema = Type.Object(
  {
    itemId: Type.String({ description: "Planning item id." }),
    agentId: Type.Optional(Type.String({ description: "Optional agent id." })),
    note: Type.Optional(Type.String({ description: "Optional start note." })),
  },
  { additionalProperties: false },
);

const FinishTaskSchema = Type.Object(
  {
    itemId: Type.String({ description: "Started task id." }),
    resultSummary: Type.String({ description: "Completion summary." }),
    memoryId: Type.Optional(Type.String({ description: "Linked memory id." })),
    artifactLinks: Type.Optional(Type.Array(Type.String(), { description: "Artifact links." })),
  },
  { additionalProperties: false },
);

const NoteSchema = Type.Object(
  {
    itemId: Type.String({ description: "Item id." }),
    note: Type.String({ description: "Note text." }),
  },
  { additionalProperties: false },
);

const ClaimSchema = Type.Object(
  {
    itemId: Type.String({ description: "Item id." }),
    agentId: Type.String({ description: "Agent id." }),
  },
  { additionalProperties: false },
);

const ProcessIdeaSchema = Type.Object(
  {
    itemId: Type.String({ description: "Idea item id." }),
    optionalInstructions: Type.Optional(Type.String({ description: "Optional extra guidance." })),
    save: Type.Optional(Type.Boolean({ description: "Persist prompt draft back to Clawboard." })),
    moveToPromptIdeas: Type.Optional(
      Type.Boolean({ description: "Move the idea into Prompt Ideas after generation." }),
    ),
  },
  { additionalProperties: false },
);

const ExecutePlanningSchema = Type.Object(
  {
    itemId: Type.Optional(Type.String({ description: "Planning task id. Omit to use next task." })),
    agentId: Type.Optional(Type.String({ description: "Agent id to attribute execution to." })),
    claim: Type.Optional(Type.Boolean({ description: "Claim the task before starting." })),
  },
  { additionalProperties: false },
);

export function createClawboardTools(params: {
  clawboardClient: ClawboardClient;
  ideaPromptService: IdeaPromptService;
  planningExecutionService: PlanningExecutionService;
  retrievalBudget: RetrievalBudgetService;
  toolContext?: OpenClawPluginToolContext;
}): AnyAgentTool[] {
  const workspaceDir = params.toolContext?.workspaceDir ?? process.cwd();

  return [
    {
      name: "clawboard_create_idea",
      label: "Clawboard Create Idea",
      description: "Create a new idea card in the Ideas column for operator capture workflows.",
      parameters: CreateIdeaSchema,
      execute: async (_toolCallId, rawParams) => {
        const item = await params.clawboardClient.createIdea({
          title: readStringParam(rawParams, "title", { required: true }),
          description: readStringParam(rawParams, "description") ?? "",
          tags: readStringArrayParam(rawParams, "tags") ?? [],
          note: readStringParam(rawParams, "note") ?? undefined,
        });
        return jsonResult({ item });
      },
    },
    {
      name: "clawboard_get_ideas",
      label: "Clawboard Get Ideas",
      description: "List items from the Ideas column.",
      parameters: LimitSchema,
      execute: async (_toolCallId, rawParams) => {
        const limit = params.retrievalBudget.ideas(readNumberParam(rawParams, "limit"));
        const response = await params.clawboardClient.listItems({ column: "ideas", limit });
        return jsonResult({ count: response.items.length, items: response.items });
      },
    },
    {
      name: "clawboard_get_prompt_ideas",
      label: "Clawboard Get Prompt Ideas",
      description: "List items from the Prompt Ideas column.",
      parameters: LimitSchema,
      execute: async (_toolCallId, rawParams) => {
        const limit = params.retrievalBudget.promptIdeas(readNumberParam(rawParams, "limit"));
        const response = await params.clawboardClient.listItems({ column: "promptIdeas", limit });
        return jsonResult({ count: response.items.length, items: response.items });
      },
    },
    {
      name: "clawboard_get_planning_tasks",
      label: "Clawboard Get Planning Tasks",
      description: "List approved tasks from the Planning column.",
      parameters: LimitSchema,
      execute: async (_toolCallId, rawParams) => {
        const limit = params.retrievalBudget.planning(readNumberParam(rawParams, "limit"));
        const response = await params.clawboardClient.listItems({ column: "planning", limit });
        return jsonResult({ count: response.items.length, items: response.items });
      },
    },
    {
      name: "clawboard_get_item",
      label: "Clawboard Get Item",
      description: "Fetch one Clawboard item by id.",
      parameters: Type.Object(
        {
          itemId: Type.String({ description: "Clawboard item id." }),
        },
        { additionalProperties: false },
      ),
      execute: async (_toolCallId, rawParams) => {
        const item = await params.clawboardClient.getItem(
          readStringParam(rawParams, "itemId", { required: true }),
        );
        return jsonResult({ item });
      },
    },
    {
      name: "clawboard_generate_prompt_from_idea",
      label: "Clawboard Generate Prompt",
      description: "Generate a polished execution prompt draft from one idea item.",
      parameters: GeneratePromptSchema,
      execute: async (_toolCallId, rawParams) => {
        const result = await params.ideaPromptService.generateFromIdea({
          itemId: readStringParam(rawParams, "itemId", { required: true }),
          workspaceDir,
          optionalInstructions: readStringParam(rawParams, "optionalInstructions") ?? undefined,
        });
        return jsonResult({
          item: result.item,
          promptDraft: result.draft,
        });
      },
    },
    {
      name: "clawboard_save_prompt_idea",
      label: "Clawboard Save Prompt Idea",
      description: "Persist a generated prompt draft back to Clawboard.",
      parameters: SavePromptIdeaSchema,
      execute: async (_toolCallId, rawParams) => {
        const itemId = readStringParam(rawParams, "itemId", { required: true });
        await params.clawboardClient.savePromptIdea({
          itemId,
          promptDraft: readStringParam(rawParams, "promptDraft", { required: true }),
          summary: readStringParam(rawParams, "summary") ?? undefined,
          assumptions: readStringArrayParam(rawParams, "assumptions") ?? [],
        });
        return jsonResult({ itemId, action: "saved" });
      },
    },
    {
      name: "clawboard_move_to_prompt_ideas",
      label: "Clawboard Move To Prompt Ideas",
      description: "Move an idea item into Prompt Ideas, optionally attaching prompt text.",
      parameters: Type.Object(
        {
          itemId: Type.String({ description: "Item id." }),
          promptDraft: Type.Optional(Type.String({ description: "Optional prompt draft." })),
          summary: Type.Optional(Type.String({ description: "Optional summary." })),
        },
        { additionalProperties: false },
      ),
      execute: async (_toolCallId, rawParams) => {
        const itemId = readStringParam(rawParams, "itemId", { required: true });
        await params.clawboardClient.moveItem({
          itemId,
          targetColumn: "promptIdeas",
          extra: {
            promptDraft: readStringParam(rawParams, "promptDraft") ?? undefined,
            summary: readStringParam(rawParams, "summary") ?? undefined,
          },
        });
        return jsonResult({ itemId, targetColumn: "promptIdeas" });
      },
    },
    {
      name: "clawboard_move_to_planning",
      label: "Clawboard Move To Planning",
      description: "Move an approved prompt or task into Planning.",
      parameters: Type.Object(
        {
          itemId: Type.String({ description: "Item id." }),
          note: Type.Optional(Type.String({ description: "Optional move note." })),
        },
        { additionalProperties: false },
      ),
      execute: async (_toolCallId, rawParams) => {
        const itemId = readStringParam(rawParams, "itemId", { required: true });
        await params.clawboardClient.moveItem({
          itemId,
          targetColumn: "planning",
          note: readStringParam(rawParams, "note") ?? undefined,
        });
        return jsonResult({ itemId, targetColumn: "planning" });
      },
    },
    {
      name: "clawboard_get_next_planning_task",
      label: "Clawboard Get Next Planning Task",
      description: "Fetch the next eligible Planning task.",
      parameters: Type.Object(
        {
          agentId: Type.Optional(
            Type.String({ description: "Optional agent id for queue selection." }),
          ),
        },
        { additionalProperties: false },
      ),
      execute: async (_toolCallId, rawParams) => {
        const item = await params.clawboardClient.getNextPlanningTask(
          readStringParam(rawParams, "agentId") ?? undefined,
        );
        return jsonResult({ item });
      },
    },
    {
      name: "clawboard_start_task",
      label: "Clawboard Start Task",
      description: "Move a Planning item into Started Task.",
      parameters: StartTaskSchema,
      execute: async (_toolCallId, rawParams) => {
        const itemId = readStringParam(rawParams, "itemId", { required: true });
        await params.clawboardClient.startTask({
          itemId,
          agentId: readStringParam(rawParams, "agentId") ?? undefined,
          note: readStringParam(rawParams, "note") ?? undefined,
        });
        return jsonResult({ itemId, targetColumn: "startedTask" });
      },
    },
    {
      name: "clawboard_update_task_progress",
      label: "Clawboard Update Task Progress",
      description: "Append a progress note while a task is in Started Task.",
      parameters: NoteSchema,
      execute: async (_toolCallId, rawParams) => {
        const itemId = readStringParam(rawParams, "itemId", { required: true });
        const note = readStringParam(rawParams, "note", { required: true });
        await params.clawboardClient.updateTaskProgress(itemId, note);
        return jsonResult({ itemId, action: "progress_updated" });
      },
    },
    {
      name: "clawboard_finish_task",
      label: "Clawboard Finish Task",
      description: "Move a Started Task item into Finished with summary and memory linkage.",
      parameters: FinishTaskSchema,
      execute: async (_toolCallId, rawParams) => {
        const itemId = readStringParam(rawParams, "itemId", { required: true });
        await params.clawboardClient.finishTask({
          itemId,
          resultSummary: readStringParam(rawParams, "resultSummary", { required: true }),
          memoryId: readStringParam(rawParams, "memoryId") ?? undefined,
          artifactLinks: readStringArrayParam(rawParams, "artifactLinks") ?? [],
        });
        return jsonResult({ itemId, targetColumn: "finished" });
      },
    },
    {
      name: "clawboard_move_item",
      label: "Clawboard Move Item",
      description: "Move an item between supported workflow columns.",
      parameters: MoveItemSchema,
      execute: async (_toolCallId, rawParams) => {
        const itemId = readStringParam(rawParams, "itemId", { required: true });
        const targetColumn = normalizeColumn(
          readStringParam(rawParams, "targetColumn", { required: true }),
        );
        await params.clawboardClient.moveItem({
          itemId,
          targetColumn,
          note: readStringParam(rawParams, "note") ?? undefined,
        });
        return jsonResult({ itemId, targetColumn });
      },
    },
    {
      name: "clawboard_add_note",
      label: "Clawboard Add Note",
      description: "Append a note or operator log entry to an item.",
      parameters: NoteSchema,
      execute: async (_toolCallId, rawParams) => {
        const itemId = readStringParam(rawParams, "itemId", { required: true });
        const note = readStringParam(rawParams, "note", { required: true });
        await params.clawboardClient.addNote(itemId, note);
        return jsonResult({ itemId, action: "note_added" });
      },
    },
    {
      name: "clawboard_claim_task",
      label: "Clawboard Claim Task",
      description: "Claim or assign a task when the API supports task ownership.",
      parameters: ClaimSchema,
      execute: async (_toolCallId, rawParams) => {
        const itemId = readStringParam(rawParams, "itemId", { required: true });
        const agentId = readStringParam(rawParams, "agentId", { required: true });
        await params.clawboardClient.claimTask(itemId, agentId);
        return jsonResult({ itemId, agentId, action: "claimed" });
      },
    },
    {
      name: "clawboard_process_idea_to_prompt",
      label: "Clawboard Process Idea To Prompt",
      description:
        "High-level idea workflow: generate a structured prompt draft, optionally save it, and optionally move the item to Prompt Ideas.",
      parameters: ProcessIdeaSchema,
      execute: async (_toolCallId, rawParams) => {
        const itemId = readStringParam(rawParams, "itemId", { required: true });
        const save = readBooleanParam(rawParams, "save", true);
        const moveToPromptIdeas = readBooleanParam(rawParams, "moveToPromptIdeas", true);
        const result = await params.ideaPromptService.generateFromIdea({
          itemId,
          workspaceDir,
          optionalInstructions: readStringParam(rawParams, "optionalInstructions") ?? undefined,
        });

        if (save) {
          await params.clawboardClient.savePromptIdea({
            itemId,
            promptDraft: result.draft.finalWorkingPrompt,
            summary: result.draft.summary,
            assumptions: result.draft.assumptions,
          });
        }
        if (moveToPromptIdeas) {
          await params.clawboardClient.moveItem({
            itemId,
            targetColumn: "promptIdeas",
            extra: {
              promptDraft: result.draft.finalWorkingPrompt,
              summary: result.draft.summary,
            },
          });
        }

        return jsonResult({
          item: result.item,
          promptDraft: result.draft,
          saved: save,
          movedToPromptIdeas: moveToPromptIdeas,
        });
      },
    },
    {
      name: "clawboard_execute_planning_task",
      label: "Clawboard Execute Planning Task",
      description:
        "High-level execution workflow: pull one approved Planning task, run it, save durable memory, and finish the task.",
      parameters: ExecutePlanningSchema,
      execute: async (_toolCallId, rawParams) => {
        const claim = readBooleanParam(rawParams, "claim", false);
        const itemId = readStringParam(rawParams, "itemId") ?? undefined;
        const agentId = readStringParam(rawParams, "agentId") ?? params.toolContext?.agentId;
        const result = itemId
          ? await params.planningExecutionService.executePlanningTask({
              workspaceDir,
              itemId,
              agentId,
              sessionKey: params.toolContext?.sessionKey,
              triggeredBy: "tool",
              claimBeforeStart: claim,
            })
          : await params.planningExecutionService.executeNextPlanningTask({
              workspaceDir,
              agentId,
              sessionKey: params.toolContext?.sessionKey,
              triggeredBy: "tool",
              claimBeforeStart: claim,
            });
        return jsonResult(result);
      },
    },
  ];
}

function normalizeColumn(value: string): ClawboardLogicalColumn {
  const normalized = value.trim().toLowerCase();
  switch (normalized) {
    case "ideas":
      return "ideas";
    case "promptideas":
    case "prompt-ideas":
    case "prompt ideas":
      return "promptIdeas";
    case "planning":
      return "planning";
    case "started":
    case "startedtask":
    case "started-task":
    case "started task":
      return "startedTask";
    case "finished":
    case "ready":   // ClawBoard has a Ready column — treat as finished for planning flow
      return "finished";
    default:
      throw new Error(`Unsupported targetColumn: ${value}`);
  }
}

function readBooleanParam(
  params: Record<string, unknown>,
  key: string,
  defaultValue: boolean,
): boolean {
  const value = params[key];
  return typeof value === "boolean" ? value : defaultValue;
}
