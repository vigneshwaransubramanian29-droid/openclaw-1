import { z } from "zod";
import type { OpenClawPluginConfigSchema } from "../../api.js";

const HttpMethodSchema = z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]);
const AuthModeSchema = z.enum(["none", "bearer", "apiKey", "header"]);

const EndpointInputSchema = z
  .object({
    path: z.string().optional(),
    method: HttpMethodSchema.optional(),
  })
  .strict();

const RetryInputSchema = z
  .object({
    maxAttempts: z.number().int().min(1).max(10).optional(),
    baseDelayMs: z.number().int().min(50).max(10_000).optional(),
  })
  .strict();

const AuthConfigInputSchema = z
  .object({
    mode: AuthModeSchema.optional(),
    headerName: z.string().optional(),
    prefix: z.string().optional(),
    value: z.string().optional(),
    valueEnv: z.string().optional(),
  })
  .strict();

const ClawboardEndpointsInputSchema = z
  .object({
    listItems: EndpointInputSchema.optional(),
    getItem: EndpointInputSchema.optional(),
    createIdea: EndpointInputSchema.optional(),
    savePromptIdea: EndpointInputSchema.optional(),
    moveItem: EndpointInputSchema.optional(),
    addNote: EndpointInputSchema.optional(),
    nextPlanningTask: EndpointInputSchema.optional(),
    startTask: EndpointInputSchema.optional(),
    updateProgress: EndpointInputSchema.optional(),
    finishTask: EndpointInputSchema.optional(),
    claimTask: EndpointInputSchema.optional(),
  })
  .strict();

const MemoryEndpointsInputSchema = z
  .object({
    search: EndpointInputSchema.optional(),
    get: EndpointInputSchema.optional(),
    save: EndpointInputSchema.optional(),
    upsertFact: EndpointInputSchema.optional(),
    status: EndpointInputSchema.optional(),
  })
  .strict();

const ServiceConfigInputSchema = z
  .object({
    baseUrl: z.string().optional(),
    timeoutMs: z.number().int().min(1_000).max(300_000).optional(),
    retry: RetryInputSchema.optional(),
    auth: AuthConfigInputSchema.optional(),
  })
  .strict();

const ClawboardColumnsInputSchema = z
  .object({
    ideas: z.string().optional(),
    promptIdeas: z.string().optional(),
    planning: z.string().optional(),
    startedTask: z.string().optional(),
    finished: z.string().optional(),
  })
  .strict();

const RetrievalBudgetInputSchema = z
  .object({
    maxIdeaResults: z.number().int().min(1).max(25).optional(),
    maxPromptIdeaResults: z.number().int().min(1).max(25).optional(),
    maxPlanningResults: z.number().int().min(1).max(25).optional(),
    maxMemoryResults: z.number().int().min(1).max(20).optional(),
    maxExpandedMemories: z.number().int().min(0).max(5).optional(),
    maxContextChars: z.number().int().min(256).max(20_000).optional(),
    maxPromptKeywords: z.number().int().min(1).max(20).optional(),
  })
  .strict();

const PromptGenerationInputSchema = z
  .object({
    provider: z.string().optional(),
    model: z.string().optional(),
    authProfileId: z.string().optional(),
    timeoutMs: z.number().int().min(1_000).max(300_000).optional(),
  })
  .strict();

const ExecutionInputSchema = z
  .object({
    provider: z.string().optional(),
    model: z.string().optional(),
    authProfileId: z.string().optional(),
    timeoutMs: z.number().int().min(10_000).max(7_200_000).optional(),
    lane: z.string().optional(),
    memorySearchNamespace: z.string().optional(),
    allowFinishWithoutMemorySave: z.boolean().optional(),
    saveFailureAsWarning: z.boolean().optional(),
    addProgressNotes: z.boolean().optional(),
  })
  .strict();

const BreadcrumbInputSchema = z
  .object({
    enabled: z.boolean().optional(),
    fileName: z.string().optional(),
  })
  .strict();

const PlanningPollInputSchema = z
  .object({
    enabled: z.boolean().optional(),
    intervalMs: z.number().int().min(1_000).max(86_400_000).optional(),
    agentId: z.string().optional(),
    claimBeforeStart: z.boolean().optional(),
    stopOnError: z.boolean().optional(),
  })
  .strict();

const WorkflowInputSchema = z
  .object({
    columns: ClawboardColumnsInputSchema.optional(),
    retrieval: RetrievalBudgetInputSchema.optional(),
    promptGeneration: PromptGenerationInputSchema.optional(),
    execution: ExecutionInputSchema.optional(),
    breadcrumb: BreadcrumbInputSchema.optional(),
    automation: z
      .object({
        planningPoll: PlanningPollInputSchema.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const PluginSettingsInputSchema = z
  .object({
    clawboard: ServiceConfigInputSchema.extend({
      endpoints: ClawboardEndpointsInputSchema.optional(),
    })
      .strict()
      .optional(),
    memoryApi: ServiceConfigInputSchema.extend({
      defaultNamespace: z.string().optional(),
      workspaceId: z.string().optional(),
      endpoints: MemoryEndpointsInputSchema.optional(),
    })
      .strict()
      .optional(),
    workflow: WorkflowInputSchema.optional(),
  })
  .strict();

const EndpointSchema = z
  .object({
    path: z.string().optional(),
    method: HttpMethodSchema.optional(),
  })
  .strict();

const RetrySchema = z
  .object({
    maxAttempts: z.number().int().min(1).max(10),
    baseDelayMs: z.number().int().min(50).max(10_000),
  })
  .strict();

const AuthConfigSchema = z
  .object({
    mode: AuthModeSchema,
    headerName: z.string().optional(),
    prefix: z.string().optional(),
    value: z.string().optional(),
    valueEnv: z.string().optional(),
  })
  .strict();

const ClawboardEndpointsSchema = z
  .object({
    listItems: EndpointSchema,
    getItem: EndpointSchema,
    createIdea: EndpointSchema,
    savePromptIdea: EndpointSchema,
    moveItem: EndpointSchema,
    addNote: EndpointSchema,
    nextPlanningTask: EndpointSchema,
    startTask: EndpointSchema,
    updateProgress: EndpointSchema,
    finishTask: EndpointSchema,
    claimTask: EndpointSchema,
  })
  .strict();

const MemoryEndpointsSchema = z
  .object({
    search: EndpointSchema,
    get: EndpointSchema,
    save: EndpointSchema,
    upsertFact: EndpointSchema,
    status: EndpointSchema,
  })
  .strict();

const ServiceConfigSchema = z
  .object({
    baseUrl: z.string().optional(),
    timeoutMs: z.number().int().min(1_000).max(300_000),
    retry: RetrySchema,
    auth: AuthConfigSchema,
  })
  .strict();

const ClawboardColumnsSchema = z
  .object({
    ideas: z.string(),
    promptIdeas: z.string(),
    planning: z.string(),
    startedTask: z.string(),
    finished: z.string(),
  })
  .strict();

const RetrievalBudgetSchema = z
  .object({
    maxIdeaResults: z.number().int().min(1).max(25),
    maxPromptIdeaResults: z.number().int().min(1).max(25),
    maxPlanningResults: z.number().int().min(1).max(25),
    maxMemoryResults: z.number().int().min(1).max(20),
    maxExpandedMemories: z.number().int().min(0).max(5),
    maxContextChars: z.number().int().min(256).max(20_000),
    maxPromptKeywords: z.number().int().min(1).max(20),
  })
  .strict();

const PromptGenerationSchema = z
  .object({
    provider: z.string().optional(),
    model: z.string().optional(),
    authProfileId: z.string().optional(),
    timeoutMs: z.number().int().min(1_000).max(300_000),
  })
  .strict();

const ExecutionSchema = z
  .object({
    provider: z.string().optional(),
    model: z.string().optional(),
    authProfileId: z.string().optional(),
    timeoutMs: z.number().int().min(10_000).max(7_200_000),
    lane: z.string().optional(),
    memorySearchNamespace: z.string().optional(),
    allowFinishWithoutMemorySave: z.boolean(),
    saveFailureAsWarning: z.boolean(),
    addProgressNotes: z.boolean(),
  })
  .strict();

const BreadcrumbSchema = z
  .object({
    enabled: z.boolean(),
    fileName: z.string(),
  })
  .strict();

const PlanningPollSchema = z
  .object({
    enabled: z.boolean(),
    intervalMs: z.number().int().min(1_000).max(86_400_000),
    agentId: z.string(),
    claimBeforeStart: z.boolean(),
    stopOnError: z.boolean(),
  })
  .strict();

const WorkflowSchema = z
  .object({
    columns: ClawboardColumnsSchema,
    retrieval: RetrievalBudgetSchema,
    promptGeneration: PromptGenerationSchema,
    execution: ExecutionSchema,
    breadcrumb: BreadcrumbSchema,
    automation: z
      .object({
        planningPoll: PlanningPollSchema,
      })
      .strict(),
  })
  .strict();

export const ClawboardMemoryPluginSettingsSchema = z
  .object({
    clawboard: ServiceConfigSchema.extend({
      endpoints: ClawboardEndpointsSchema,
    }).strict(),
    memoryApi: ServiceConfigSchema.extend({
      defaultNamespace: z.string().optional(),
      workspaceId: z.string().optional(),
      endpoints: MemoryEndpointsSchema,
    }).strict(),
    workflow: WorkflowSchema,
  })
  .strict();

export type ClawboardMemoryPluginSettings = z.infer<typeof ClawboardMemoryPluginSettingsSchema>;

const DEFAULT_RETRY = {
  maxAttempts: 2,
  baseDelayMs: 250,
} as const;

const DEFAULT_AUTH = {
  mode: "none",
} as const;

const DEFAULT_CLAWBOARD_ENDPOINTS = {
  listItems: { path: "/api/tasks", method: "GET" },
  getItem: { path: "/api/tasks/{itemId}", method: "GET" },
  createIdea: { path: "/api/tasks", method: "POST" },
  savePromptIdea: { path: "/api/tasks/{itemId}/move-to-prompt-ideas", method: "POST" },
  moveItem: { path: "/api/tasks/{itemId}/status", method: "PATCH" },
  addNote: { path: "/api/tasks/{itemId}/comments", method: "POST" },
  nextPlanningTask: { path: "/api/agent/tasks/next-planning", method: "GET" },
  startTask: { path: "/api/agent/tasks/{itemId}/claim", method: "POST" },
  updateProgress: { path: "/api/agent/tasks/{itemId}/progress", method: "POST" },
  finishTask: { path: "/api/agent/tasks/{itemId}/finish", method: "POST" },
  claimTask: { path: "/api/agent/tasks/{itemId}/claim", method: "POST" },
} as const satisfies z.input<typeof ClawboardEndpointsSchema>;

const DEFAULT_MEMORY_ENDPOINTS = {
  search: { path: "/v1/memory/search", method: "POST" },
  get: { path: "/v1/memory/{memoryId}", method: "GET" },
  save: { path: "/v1/memory", method: "POST" },
  upsertFact: { path: "/v1/memory", method: "POST" },
  status: { path: "/v1/health", method: "GET" },
} as const satisfies z.input<typeof MemoryEndpointsSchema>;

const DEFAULT_COLUMNS = {
  ideas: "Ideas",
  promptIdeas: "Prompt Ideas",
  planning: "Planning",
  startedTask: "Started Task",
  finished: "Finished",
} as const satisfies z.input<typeof ClawboardColumnsSchema>;

const DEFAULT_RETRIEVAL = {
  maxIdeaResults: 5,
  maxPromptIdeaResults: 5,
  maxPlanningResults: 3,
  maxMemoryResults: 3,
  maxExpandedMemories: 1,
  maxContextChars: 4_000,
  maxPromptKeywords: 8,
} as const satisfies z.input<typeof RetrievalBudgetSchema>;

const DEFAULT_PROMPT_GENERATION = {
  timeoutMs: 45_000,
} as const satisfies Partial<z.input<typeof PromptGenerationSchema>>;

const DEFAULT_EXECUTION = {
  timeoutMs: 900_000,
  allowFinishWithoutMemorySave: true,
  saveFailureAsWarning: true,
  addProgressNotes: true,
} as const satisfies Partial<z.input<typeof ExecutionSchema>>;

const DEFAULT_BREADCRUMB = {
  enabled: true,
  fileName: "clawboard-memory-breadcrumb.json",
} as const satisfies z.input<typeof BreadcrumbSchema>;

const DEFAULT_PLANNING_POLL = {
  enabled: false,
  intervalMs: 60_000,
  agentId: "main",
  claimBeforeStart: false,
  stopOnError: false,
} as const satisfies z.input<typeof PlanningPollSchema>;

function resolveEndpoint(
  value: z.input<typeof EndpointInputSchema> | undefined,
  fallback: z.input<typeof EndpointSchema>,
): z.infer<typeof EndpointSchema> {
  return EndpointSchema.parse({
    ...fallback,
    ...(value ?? {}),
  });
}

function resolveRetry(
  value: z.input<typeof RetryInputSchema> | undefined,
): z.infer<typeof RetrySchema> {
  return RetrySchema.parse({
    ...DEFAULT_RETRY,
    ...(value ?? {}),
  });
}

function resolveAuth(
  value: z.input<typeof AuthConfigInputSchema> | undefined,
): z.infer<typeof AuthConfigSchema> {
  return AuthConfigSchema.parse({
    ...DEFAULT_AUTH,
    ...(value ?? {}),
  });
}

function resolveClawboardEndpoints(
  value: z.input<typeof ClawboardEndpointsInputSchema> | undefined,
): z.infer<typeof ClawboardEndpointsSchema> {
  return ClawboardEndpointsSchema.parse({
    listItems: resolveEndpoint(value?.listItems, DEFAULT_CLAWBOARD_ENDPOINTS.listItems),
    getItem: resolveEndpoint(value?.getItem, DEFAULT_CLAWBOARD_ENDPOINTS.getItem),
    createIdea: resolveEndpoint(value?.createIdea, DEFAULT_CLAWBOARD_ENDPOINTS.createIdea),
    savePromptIdea: resolveEndpoint(
      value?.savePromptIdea,
      DEFAULT_CLAWBOARD_ENDPOINTS.savePromptIdea,
    ),
    moveItem: resolveEndpoint(value?.moveItem, DEFAULT_CLAWBOARD_ENDPOINTS.moveItem),
    addNote: resolveEndpoint(value?.addNote, DEFAULT_CLAWBOARD_ENDPOINTS.addNote),
    nextPlanningTask: resolveEndpoint(
      value?.nextPlanningTask,
      DEFAULT_CLAWBOARD_ENDPOINTS.nextPlanningTask,
    ),
    startTask: resolveEndpoint(value?.startTask, DEFAULT_CLAWBOARD_ENDPOINTS.startTask),
    updateProgress: resolveEndpoint(
      value?.updateProgress,
      DEFAULT_CLAWBOARD_ENDPOINTS.updateProgress,
    ),
    finishTask: resolveEndpoint(value?.finishTask, DEFAULT_CLAWBOARD_ENDPOINTS.finishTask),
    claimTask: resolveEndpoint(value?.claimTask, DEFAULT_CLAWBOARD_ENDPOINTS.claimTask),
  });
}

function resolveMemoryEndpoints(
  value: z.input<typeof MemoryEndpointsInputSchema> | undefined,
): z.infer<typeof MemoryEndpointsSchema> {
  return MemoryEndpointsSchema.parse({
    search: resolveEndpoint(value?.search, DEFAULT_MEMORY_ENDPOINTS.search),
    get: resolveEndpoint(value?.get, DEFAULT_MEMORY_ENDPOINTS.get),
    save: resolveEndpoint(value?.save, DEFAULT_MEMORY_ENDPOINTS.save),
    upsertFact: resolveEndpoint(value?.upsertFact, DEFAULT_MEMORY_ENDPOINTS.upsertFact),
    status: resolveEndpoint(value?.status, DEFAULT_MEMORY_ENDPOINTS.status),
  });
}

function resolveColumns(
  value: z.input<typeof ClawboardColumnsInputSchema> | undefined,
): z.infer<typeof ClawboardColumnsSchema> {
  return ClawboardColumnsSchema.parse({
    ...DEFAULT_COLUMNS,
    ...(value ?? {}),
  });
}

function resolveRetrieval(
  value: z.input<typeof RetrievalBudgetInputSchema> | undefined,
): z.infer<typeof RetrievalBudgetSchema> {
  return RetrievalBudgetSchema.parse({
    ...DEFAULT_RETRIEVAL,
    ...(value ?? {}),
  });
}

function resolvePromptGeneration(
  value: z.input<typeof PromptGenerationInputSchema> | undefined,
): z.infer<typeof PromptGenerationSchema> {
  return PromptGenerationSchema.parse({
    ...DEFAULT_PROMPT_GENERATION,
    ...(value ?? {}),
  });
}

function resolveExecution(
  value: z.input<typeof ExecutionInputSchema> | undefined,
): z.infer<typeof ExecutionSchema> {
  return ExecutionSchema.parse({
    ...DEFAULT_EXECUTION,
    ...(value ?? {}),
  });
}

function resolveBreadcrumb(
  value: z.input<typeof BreadcrumbInputSchema> | undefined,
): z.infer<typeof BreadcrumbSchema> {
  return BreadcrumbSchema.parse({
    ...DEFAULT_BREADCRUMB,
    ...(value ?? {}),
  });
}

function resolvePlanningPoll(
  value: z.input<typeof PlanningPollInputSchema> | undefined,
): z.infer<typeof PlanningPollSchema> {
  return PlanningPollSchema.parse({
    ...DEFAULT_PLANNING_POLL,
    ...(value ?? {}),
  });
}

const CONFIG_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    clawboard: {
      type: "object",
      additionalProperties: false,
      properties: {
        baseUrl: { type: "string" },
        timeoutMs: { type: "number", minimum: 1000 },
        retry: {
          type: "object",
          additionalProperties: false,
          properties: {
            maxAttempts: { type: "number", minimum: 1, maximum: 10 },
            baseDelayMs: { type: "number", minimum: 50, maximum: 10000 },
          },
        },
        auth: {
          type: "object",
          additionalProperties: false,
          properties: {
            mode: { type: "string", enum: ["none", "bearer", "apiKey", "header"] },
            headerName: { type: "string" },
            prefix: { type: "string" },
            value: { type: "string" },
            valueEnv: { type: "string" },
          },
        },
        endpoints: {
          type: "object",
          additionalProperties: false,
          properties: {
            listItems: {
              type: "object",
              additionalProperties: false,
              properties: {
                path: { type: "string" },
                method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE"] },
              },
            },
            getItem: {
              type: "object",
              additionalProperties: false,
              properties: {
                path: { type: "string" },
                method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE"] },
              },
            },
            createIdea: {
              type: "object",
              additionalProperties: false,
              properties: {
                path: { type: "string" },
                method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE"] },
              },
            },
            savePromptIdea: {
              type: "object",
              additionalProperties: false,
              properties: {
                path: { type: "string" },
                method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE"] },
              },
            },
            moveItem: {
              type: "object",
              additionalProperties: false,
              properties: {
                path: { type: "string" },
                method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE"] },
              },
            },
            addNote: {
              type: "object",
              additionalProperties: false,
              properties: {
                path: { type: "string" },
                method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE"] },
              },
            },
            nextPlanningTask: {
              type: "object",
              additionalProperties: false,
              properties: {
                path: { type: "string" },
                method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE"] },
              },
            },
            startTask: {
              type: "object",
              additionalProperties: false,
              properties: {
                path: { type: "string" },
                method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE"] },
              },
            },
            updateProgress: {
              type: "object",
              additionalProperties: false,
              properties: {
                path: { type: "string" },
                method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE"] },
              },
            },
            finishTask: {
              type: "object",
              additionalProperties: false,
              properties: {
                path: { type: "string" },
                method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE"] },
              },
            },
            claimTask: {
              type: "object",
              additionalProperties: false,
              properties: {
                path: { type: "string" },
                method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE"] },
              },
            },
          },
        },
      },
    },
    memoryApi: {
      type: "object",
      additionalProperties: false,
      properties: {
        baseUrl: { type: "string" },
        defaultNamespace: { type: "string" },
        workspaceId: { type: "string" },
        timeoutMs: { type: "number", minimum: 1000 },
        retry: {
          type: "object",
          additionalProperties: false,
          properties: {
            maxAttempts: { type: "number", minimum: 1, maximum: 10 },
            baseDelayMs: { type: "number", minimum: 50, maximum: 10000 },
          },
        },
        auth: {
          type: "object",
          additionalProperties: false,
          properties: {
            mode: { type: "string", enum: ["none", "bearer", "apiKey", "header"] },
            headerName: { type: "string" },
            prefix: { type: "string" },
            value: { type: "string" },
            valueEnv: { type: "string" },
          },
        },
      },
    },
    workflow: {
      type: "object",
      additionalProperties: false,
      properties: {
        columns: {
          type: "object",
          additionalProperties: false,
          properties: {
            ideas: { type: "string" },
            promptIdeas: { type: "string" },
            planning: { type: "string" },
            startedTask: { type: "string" },
            finished: { type: "string" },
          },
        },
        retrieval: {
          type: "object",
          additionalProperties: false,
          properties: {
            maxIdeaResults: { type: "number", minimum: 1 },
            maxPromptIdeaResults: { type: "number", minimum: 1 },
            maxPlanningResults: { type: "number", minimum: 1 },
            maxMemoryResults: { type: "number", minimum: 1 },
            maxExpandedMemories: { type: "number", minimum: 0 },
            maxContextChars: { type: "number", minimum: 256 },
            maxPromptKeywords: { type: "number", minimum: 1 },
          },
        },
        promptGeneration: {
          type: "object",
          additionalProperties: false,
          properties: {
            provider: { type: "string" },
            model: { type: "string" },
            authProfileId: { type: "string" },
            timeoutMs: { type: "number", minimum: 1000 },
          },
        },
        execution: {
          type: "object",
          additionalProperties: false,
          properties: {
            provider: { type: "string" },
            model: { type: "string" },
            authProfileId: { type: "string" },
            timeoutMs: { type: "number", minimum: 10000 },
            lane: { type: "string" },
            memorySearchNamespace: { type: "string" },
            allowFinishWithoutMemorySave: { type: "boolean" },
            saveFailureAsWarning: { type: "boolean" },
            addProgressNotes: { type: "boolean" },
          },
        },
        breadcrumb: {
          type: "object",
          additionalProperties: false,
          properties: {
            enabled: { type: "boolean" },
            fileName: { type: "string" },
          },
        },
        automation: {
          type: "object",
          additionalProperties: false,
          properties: {
            planningPoll: {
              type: "object",
              additionalProperties: false,
              properties: {
                enabled: { type: "boolean" },
                intervalMs: { type: "number", minimum: 1000 },
                agentId: { type: "string" },
                claimBeforeStart: { type: "boolean" },
                stopOnError: { type: "boolean" },
              },
            },
          },
        },
      },
    },
  },
} as const;

export const clawboardMemoryPluginConfigSchema: OpenClawPluginConfigSchema = {
  safeParse(value: unknown) {
    try {
      return { success: true, data: resolvePluginSettings(value) };
    } catch (error) {
      if (error instanceof z.ZodError) {
        return {
          success: false,
          error: {
            issues: error.issues.map((issue) => ({
              path: issue.path.filter(
                (segment): segment is string | number =>
                  typeof segment === "string" || typeof segment === "number",
              ),
              message: issue.message,
            })),
          },
        };
      }
      return {
        success: false,
        error: {
          issues: [{ path: [], message: error instanceof Error ? error.message : String(error) }],
        },
      };
    }
  },
  jsonSchema: CONFIG_JSON_SCHEMA,
};

export function resolvePluginSettings(rawConfig: unknown): ClawboardMemoryPluginSettings {
  const parsed = PluginSettingsInputSchema.parse(rawConfig ?? {});
  return ClawboardMemoryPluginSettingsSchema.parse({
    clawboard: {
      baseUrl: parsed.clawboard?.baseUrl,
      timeoutMs: parsed.clawboard?.timeoutMs ?? 15_000,
      retry: resolveRetry(parsed.clawboard?.retry),
      auth: resolveAuth(parsed.clawboard?.auth),
      endpoints: resolveClawboardEndpoints(parsed.clawboard?.endpoints),
    },
    memoryApi: {
      baseUrl: parsed.memoryApi?.baseUrl,
      defaultNamespace: parsed.memoryApi?.defaultNamespace,
      workspaceId: parsed.memoryApi?.workspaceId,
      timeoutMs: parsed.memoryApi?.timeoutMs ?? 15_000,
      retry: resolveRetry(parsed.memoryApi?.retry),
      auth: resolveAuth(parsed.memoryApi?.auth),
      endpoints: resolveMemoryEndpoints(parsed.memoryApi?.endpoints),
    },
    workflow: {
      columns: resolveColumns(parsed.workflow?.columns),
      retrieval: resolveRetrieval(parsed.workflow?.retrieval),
      promptGeneration: resolvePromptGeneration(parsed.workflow?.promptGeneration),
      execution: resolveExecution(parsed.workflow?.execution),
      breadcrumb: resolveBreadcrumb(parsed.workflow?.breadcrumb),
      automation: {
        planningPoll: resolvePlanningPoll(parsed.workflow?.automation?.planningPoll),
      },
    },
  });
}
