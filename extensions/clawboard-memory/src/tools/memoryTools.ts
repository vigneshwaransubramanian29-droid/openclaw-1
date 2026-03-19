import { Type } from "@sinclair/typebox";
import type { AnyAgentTool } from "../../api.js";
import { jsonResult, readNumberParam, readStringArrayParam, readStringParam } from "../../api.js";
import { MemoryClient } from "../clients/memoryClient.js";
import type { ClawboardMemoryPluginSettings } from "../config/settings.js";
import { MemorySaveInputSchema } from "../types/memory.js";

const MemorySearchSchema = Type.Object(
  {
    query: Type.String({ description: "Semantic memory query." }),
    namespace: Type.Optional(Type.String({ description: "Optional memory namespace." })),
    topK: Type.Optional(
      Type.Number({
        description: "Maximum number of results to return.",
        minimum: 1,
        maximum: 20,
      }),
    ),
    maxResults: Type.Optional(
      Type.Number({
        description: "Alias for topK.",
        minimum: 1,
        maximum: 20,
      }),
    ),
  },
  { additionalProperties: false },
);

const MemoryGetSchema = Type.Object(
  {
    path: Type.Optional(
      Type.String({
        description:
          "Memory identifier returned by memory_search. Kept as `path` for compatibility.",
      }),
    ),
    memoryId: Type.Optional(Type.String({ description: "Explicit memory identifier." })),
    from: Type.Optional(Type.Number({ description: "Ignored compatibility alias." })),
    lines: Type.Optional(Type.Number({ description: "Ignored compatibility alias." })),
  },
  { additionalProperties: false },
);

const MemorySaveSchema = Type.Object(
  {
    title: Type.String({ description: "Memory title." }),
    summary: Type.String({ description: "Durable summary text." }),
    type: Type.Optional(Type.String({ description: "Memory type." })),
    tags: Type.Optional(Type.Array(Type.String(), { description: "Optional tags." })),
    taskId: Type.Optional(Type.String({ description: "Related Clawboard task id." })),
    sourceRef: Type.Optional(Type.String({ description: "Source session or artifact reference." })),
    importance: Type.Optional(
      Type.Number({ description: "Importance score from 0 to 1.", minimum: 0, maximum: 1 }),
    ),
    facts: Type.Optional(Type.Array(Type.String(), { description: "Optional durable facts." })),
    namespace: Type.Optional(Type.String({ description: "Optional memory namespace." })),
  },
  { additionalProperties: false },
);

const MemoryUpsertFactSchema = Type.Object(
  {
    key: Type.String({ description: "Fact key." }),
    value: Type.String({ description: "Fact value." }),
    namespace: Type.Optional(Type.String({ description: "Optional fact namespace." })),
  },
  { additionalProperties: false },
);

export function createMemoryTools(params: {
  memoryClient: MemoryClient;
  settings: ClawboardMemoryPluginSettings["memoryApi"];
}): AnyAgentTool[] {
  return [
    {
      name: "memory_search",
      label: "Memory Search",
      description:
        "Search the configured external Memory API. Returns compact summaries first to keep context small.",
      parameters: MemorySearchSchema,
      execute: async (_toolCallId, rawParams) => {
        const query = readStringParam(rawParams, "query", { required: true });
        const namespace =
          readStringParam(rawParams, "namespace") ?? params.settings.defaultNamespace;
        const topK = readNumberParam(rawParams, "topK") ?? readNumberParam(rawParams, "maxResults");
        try {
          const hits = await params.memoryClient.search({
            query,
            namespace,
            topK: topK ?? undefined,
          });
          return jsonResult({
            query,
            namespace,
            results: hits.map((hit) => ({
              id: hit.id,
              path: hit.id,
              title: hit.title,
              summary: hit.summary,
              snippet: hit.snippet ?? hit.summary,
              startLine: 1,
              endLine: 1,
              score: hit.score,
              tags: hit.tags,
              sourceRef: hit.sourceRef,
              type: hit.type,
            })),
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return jsonResult({
            query,
            namespace,
            results: [],
            disabled: true,
            unavailable: true,
            error: message,
            warning: "Memory search failed; continue using task context when possible.",
          });
        }
      },
    },
    {
      name: "memory_get",
      label: "Memory Get",
      description:
        "Fetch one memory record from the configured external Memory API after memory_search.",
      parameters: MemoryGetSchema,
      execute: async (_toolCallId, rawParams) => {
        const memoryId =
          readStringParam(rawParams, "memoryId") ??
          readStringParam(rawParams, "path", { required: true, label: "memoryId" });
        try {
          const memory = await params.memoryClient.get(memoryId);
          const text = [
            `Title: ${memory.title}`,
            `Summary: ${memory.summary}`,
            memory.facts.length > 0 ? `Facts: ${memory.facts.join("; ")}` : "",
            memory.tags.length > 0 ? `Tags: ${memory.tags.join(", ")}` : "",
          ]
            .filter(Boolean)
            .join("\n");
          return jsonResult({
            path: memory.id,
            text,
            memory,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return jsonResult({
            path: memoryId,
            text: "",
            disabled: true,
            error: message,
          });
        }
      },
    },
    {
      name: "memory_save",
      label: "Memory Save",
      description: "Save distilled durable memory to the configured external Memory API.",
      parameters: MemorySaveSchema,
      execute: async (_toolCallId, rawParams) => {
        const payload = MemorySaveInputSchema.parse({
          title: readStringParam(rawParams, "title", { required: true }),
          summary: readStringParam(rawParams, "summary", { required: true }),
          type: readStringParam(rawParams, "type") ?? "summary",
          tags: readStringArrayParam(rawParams, "tags") ?? [],
          taskId: readStringParam(rawParams, "taskId") ?? undefined,
          sourceRef: readStringParam(rawParams, "sourceRef") ?? undefined,
          importance: readNumberParam(rawParams, "importance") ?? undefined,
          facts: readStringArrayParam(rawParams, "facts") ?? [],
          namespace: readStringParam(rawParams, "namespace") ?? params.settings.defaultNamespace,
        });
        const memory = await params.memoryClient.save(payload);
        return jsonResult({
          action: "saved",
          memory,
        });
      },
    },
    {
      name: "memory_upsert_fact",
      label: "Memory Upsert Fact",
      description: "Upsert one durable fact in the configured external Memory API.",
      parameters: MemoryUpsertFactSchema,
      execute: async (_toolCallId, rawParams) => {
        const key = readStringParam(rawParams, "key", { required: true });
        const value = readStringParam(rawParams, "value", { required: true });
        const namespace =
          readStringParam(rawParams, "namespace") ?? params.settings.defaultNamespace;
        const result = await params.memoryClient.upsertFact({ key, value, namespace });
        return jsonResult({
          action: "upserted",
          key,
          value,
          namespace,
          result,
        });
      },
    },
  ];
}
