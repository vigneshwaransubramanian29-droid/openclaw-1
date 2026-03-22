import type { PluginLogger } from "../../api.js";
import type { ClawboardMemoryPluginSettings } from "../config/settings.js";
import type {
  ClawboardItem,
  ClawboardListResponse,
  ClawboardLogicalColumn,
} from "../types/clawboard.js";
import { ClawboardItemSchema } from "../types/clawboard.js";
import { createComponentLogger } from "../utils/logger.js";
import {
  coerceStringArray,
  extractArrayPayload,
  extractObjectPayload,
  uniqueStrings,
} from "../utils/validation.js";
import { JsonHttpClient } from "./httpClient.js";

type ClawboardSettings = ClawboardMemoryPluginSettings["clawboard"];
type ClawboardColumns = ClawboardMemoryPluginSettings["workflow"]["columns"];

export class ClawboardClient {
  private readonly http: JsonHttpClient;
  private readonly logger: PluginLogger;

  constructor(
    private readonly settings: ClawboardSettings,
    private readonly columns: ClawboardColumns,
    logger: PluginLogger,
  ) {
    this.http = new JsonHttpClient({
      name: "clawboard-api",
      baseUrl: settings.baseUrl,
      timeoutMs: settings.timeoutMs,
      retry: settings.retry,
      auth: settings.auth,
      logger,
    });
    this.logger = createComponentLogger(logger, "clawboard-client");
  }

  async listItems(params: {
    column: ClawboardLogicalColumn;
    limit?: number;
    agentId?: string;
  }): Promise<ClawboardListResponse> {
    const raw = await this.http.requestJson({
      endpoint: this.settings.endpoints.listItems,
      query: {
        column: this.resolveColumn(params.column),
        limit: params.limit,
        agentId: params.agentId,
      },
    });
    return {
      items: normalizeItemList(raw),
      raw,
    };
  }

  async getItem(itemId: string): Promise<ClawboardItem> {
    const raw = await this.http.requestJson({
      endpoint: this.settings.endpoints.getItem,
      pathParams: { itemId },
    });
    return normalizeItem(raw);
  }

  async createIdea(params: {
    title: string;
    description?: string;
    tags?: string[];
    note?: string;
  }): Promise<ClawboardItem> {
    const raw = await this.http.requestJson({
      endpoint: this.settings.endpoints.createIdea,
      body: {
        title: params.title,
        description: params.description ?? "",
        column: this.resolveColumn("ideas"),
        tags: uniqueStrings(params.tags ?? []),
        note: params.note,
      },
    });
    return normalizeItem(raw);
  }

  async savePromptIdea(params: {
    itemId: string;
    promptDraft: string;
    summary?: string;
    assumptions?: string[];
  }): Promise<unknown> {
    return await this.http.requestJson({
      endpoint: this.settings.endpoints.savePromptIdea,
      pathParams: { itemId: params.itemId },
      body: {
        promptDraft: params.promptDraft,
        summary: params.summary,
        assumptions: uniqueStrings(params.assumptions ?? []),
      },
    });
  }

  async moveItem(params: {
    itemId: string;
    targetColumn: ClawboardLogicalColumn;
    note?: string;
    extra?: Record<string, unknown>;
  }): Promise<unknown> {
    return await this.http.requestJson({
      endpoint: this.settings.endpoints.moveItem,
      pathParams: { itemId: params.itemId },
      body: {
        targetColumn: this.resolveColumn(params.targetColumn),
        note: params.note,
        ...(params.extra ?? {}),
      },
    });
  }

  async addNote(itemId: string, note: string): Promise<unknown> {
    return await this.http.requestJson({
      endpoint: this.settings.endpoints.addNote,
      pathParams: { itemId },
      body: { note },
    });
  }

  async getNextPlanningTask(agentId?: string): Promise<ClawboardItem | null> {
    const raw = await this.http.requestJson({
      endpoint: this.settings.endpoints.nextPlanningTask,
      query: {
        column: this.resolveColumn("planning"),
        agentId,
      },
    });
    const candidate = extractObjectPayload(raw, ["item", "data", "result"]);
    if (candidate) {
      return normalizeItem(candidate);
    }
    const list = normalizeItemList(raw);
    if (list.length > 0) {
      return list[0] ?? null;
    }
    return null;
  }

  async startTask(params: { itemId: string; agentId?: string; note?: string }): Promise<unknown> {
    return await this.http.requestJson({
      endpoint: this.settings.endpoints.startTask,
      pathParams: { itemId: params.itemId },
      body: {
        agentId: params.agentId,
        note: params.note,
      },
    });
  }

  async updateTaskProgress(itemId: string, note: string): Promise<unknown> {
    return await this.http.requestJson({
      endpoint: this.settings.endpoints.updateProgress,
      pathParams: { itemId },
      body: { note },
    });
  }

  async finishTask(params: {
    itemId: string;
    resultSummary: string;
    memoryId?: string;
    artifactLinks?: string[];
  }): Promise<unknown> {
    return await this.http.requestJson({
      endpoint: this.settings.endpoints.finishTask,
      pathParams: { itemId: params.itemId },
      body: {
        resultSummary: params.resultSummary,
        memoryId: params.memoryId,
        artifactLinks: uniqueStrings(params.artifactLinks ?? []),
      },
    });
  }

  async claimTask(itemId: string, agentId: string): Promise<unknown> {
    return await this.http.requestJson({
      endpoint: this.settings.endpoints.claimTask,
      pathParams: { itemId },
      body: { agentId },
    });
  }

  resolveColumn(column: ClawboardLogicalColumn): string {
    return this.columns[column];
  }
}

export function normalizeItem(value: unknown): ClawboardItem {
  const candidate = extractObjectPayload(value, ["item", "data", "result", "card"]);
  if (!candidate) {
    throw new Error("Clawboard API returned an invalid item payload");
  }

  // Map notes: prefer candidate.notes, fall back to ClawBoard's comments array
  const rawNotes = Array.isArray(candidate.notes)
    ? candidate.notes
    : Array.isArray(candidate.comments)
      ? candidate.comments
      : [];
  const normalizedNotes = rawNotes.map((entry: unknown) => {
    if (typeof entry === "string") {
      return { text: entry };
    }
    if (entry && typeof entry === "object") {
      const e = entry as Record<string, unknown>;
      // ClawBoard comment shape: { body, authorUserName, authorAgentName, createdAt }
      return {
        id: typeof e.id === "string" ? e.id : undefined,
        text: typeof e.text === "string" ? e.text : typeof e.body === "string" ? e.body : String(e.body ?? ""),
        author: typeof e.author === "string" ? e.author : typeof e.authorUserName === "string" ? e.authorUserName : typeof e.authorAgentName === "string" ? e.authorAgentName : undefined,
        createdAt: typeof e.createdAt === "string" ? e.createdAt : undefined,
      };
    }
    return { text: String(entry ?? "") };
  });

  // Map tags: ClawBoard returns [{id, name, color}] — extract name strings
  const rawTags = Array.isArray(candidate.tags) ? candidate.tags : [];
  const tagStrings = rawTags
    .map((t: unknown) => {
      if (typeof t === "string") return t;
      if (t && typeof t === "object") {
        const to = t as Record<string, unknown>;
        return typeof to.name === "string" ? to.name : null;
      }
      return null;
    })
    .filter((t): t is string => typeof t === "string" && t.length > 0);

  const parsed = ClawboardItemSchema.safeParse({
    ...candidate,
    title: typeof candidate.title === "string" ? candidate.title : String(candidate.title ?? ""),
    description:
      typeof candidate.description === "string"
        ? candidate.description
        : String(candidate.description ?? ""),
    tags: tagStrings,
    notes: normalizedNotes,
    artifactLinks: coerceStringArray(candidate.artifactLinks),
  });

  if (!parsed.success) {
    throw new Error(
      `Clawboard item validation failed: ${parsed.error.issues[0]?.message ?? "unknown error"}`,
    );
  }

  return parsed.data;
}

function normalizeItemList(value: unknown): ClawboardItem[] {
  const entries = extractArrayPayload(value, ["items", "results", "data", "cards"]);
  const items: ClawboardItem[] = [];
  for (const entry of entries) {
    try {
      items.push(normalizeItem(entry));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      void message;
    }
  }
  return items;
}
