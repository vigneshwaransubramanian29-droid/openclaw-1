import type { PluginLogger } from "../../api.js";
import type { ClawboardMemoryPluginSettings } from "../config/settings.js";
import type { MemoryRecord, MemorySaveInput, MemorySearchHit } from "../types/memory.js";
import { MemoryRecordSchema, MemorySearchHitSchema } from "../types/memory.js";
import {
  coerceStringArray,
  extractArrayPayload,
  extractObjectPayload,
} from "../utils/validation.js";
import { JsonHttpClient } from "./httpClient.js";

type MemorySettings = ClawboardMemoryPluginSettings["memoryApi"];

export class MemoryClient {
  private readonly http: JsonHttpClient;

  constructor(
    private readonly settings: MemorySettings,
    logger: PluginLogger,
  ) {
    this.http = new JsonHttpClient({
      name: "memory-api",
      baseUrl: settings.baseUrl,
      timeoutMs: settings.timeoutMs,
      retry: settings.retry,
      auth: settings.auth,
      logger,
    });
  }

  async search(params: {
    query: string;
    namespace?: string;
    topK?: number;
  }): Promise<MemorySearchHit[]> {
    const raw = await this.http.requestJson({
      endpoint: this.settings.endpoints.search,
      body: {
        query: params.query,
        namespace: params.namespace ?? this.settings.defaultNamespace,
        topK: params.topK,
        ...(this.settings.workspaceId ? { workspaceId: this.settings.workspaceId } : {}),
      },
    });
    const hits = extractArrayPayload(raw, ["results", "memories", "data"]);
    return hits.map((entry) => normalizeSearchHit(entry)).filter(Boolean) as MemorySearchHit[];
  }

  async get(memoryId: string): Promise<MemoryRecord> {
    const raw = await this.http.requestJson({
      endpoint: this.settings.endpoints.get,
      pathParams: { memoryId },
    });
    return normalizeMemoryRecord(raw);
  }

  async save(input: MemorySaveInput): Promise<MemoryRecord> {
    const raw = await this.http.requestJson({
      endpoint: this.settings.endpoints.save,
      body: {
        name: input.title,
        description: input.summary,
        ...(input.facts && input.facts.length > 0
          ? { content: input.facts.join("\n") }
          : {}),
        type: input.type,
        tags: input.tags,
        importance: input.importance,
        ...(this.settings.workspaceId ? { workspaceId: this.settings.workspaceId } : {}),
      },
    });
    return normalizeMemoryRecord(raw);
  }

  async upsertFact(params: { key: string; value: string; namespace?: string }): Promise<unknown> {
    return await this.http.requestJson({
      endpoint: this.settings.endpoints.upsertFact,
      body: {
        name: params.key,
        content: params.value,
        type: "fact",
        ...(this.settings.workspaceId ? { workspaceId: this.settings.workspaceId } : {}),
      },
    });
  }

  async status(): Promise<unknown> {
    return await this.http.requestJson({
      endpoint: this.settings.endpoints.status,
    });
  }
}

function normalizeSearchHit(value: unknown): MemorySearchHit | null {
  const candidate = extractObjectPayload(value, ["memory", "item", "result"]);
  if (!candidate) {
    return null;
  }
  const parsed = MemorySearchHitSchema.safeParse({
    ...candidate,
    id:
      typeof candidate.id === "string"
        ? candidate.id
        : typeof candidate.memoryId === "string"
          ? candidate.memoryId
          : undefined,
    summary:
      typeof candidate.summary === "string"
        ? candidate.summary
        : typeof candidate.description === "string"
          ? candidate.description
          : typeof candidate.snippet === "string"
            ? candidate.snippet
            : typeof candidate.text === "string"
              ? candidate.text
              : "",
    snippet:
      typeof candidate.snippet === "string"
        ? candidate.snippet
        : typeof candidate.description === "string"
          ? candidate.description
          : typeof candidate.summary === "string"
            ? candidate.summary
            : undefined,
    tags: coerceStringArray(candidate.tags),
  });
  return parsed.success ? parsed.data : null;
}

function normalizeMemoryRecord(value: unknown): MemoryRecord {
  const candidate = extractObjectPayload(value, ["memory", "item", "data", "result"]);
  if (!candidate) {
    throw new Error("Memory API returned an invalid memory payload");
  }
  const parsed = MemoryRecordSchema.safeParse({
    ...candidate,
    id:
      typeof candidate.id === "string"
        ? candidate.id
        : typeof candidate.memoryId === "string"
          ? candidate.memoryId
          : undefined,
    title:
      typeof candidate.title === "string"
        ? candidate.title
        : typeof candidate.name === "string"
          ? candidate.name
          : typeof candidate.summary === "string"
            ? candidate.summary.slice(0, 80)
            : typeof candidate.description === "string"
              ? candidate.description.slice(0, 80)
              : "memory",
    summary:
      typeof candidate.summary === "string"
        ? candidate.summary
        : typeof candidate.description === "string"
          ? candidate.description
          : typeof candidate.text === "string"
            ? candidate.text
            : "",
    tags: coerceStringArray(candidate.tags),
    facts: coerceStringArray(candidate.facts),
  });
  if (!parsed.success) {
    throw new Error(
      `Memory payload validation failed: ${parsed.error.issues[0]?.message ?? "unknown error"}`,
    );
  }
  return parsed.data;
}
