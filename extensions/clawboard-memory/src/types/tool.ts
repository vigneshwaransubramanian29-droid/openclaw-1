import { z } from "zod";
import { MemorySaveInputSchema } from "./memory.js";

export const PromptDraftSchema = z.object({
  cleanedTitle: z.string(),
  problemStatement: z.string(),
  assumptions: z.array(z.string()).default([]),
  constraints: z.array(z.string()).default([]),
  deliverables: z.array(z.string()).default([]),
  finalWorkingPrompt: z.string(),
  summary: z.string().optional(),
});

export type PromptDraft = z.infer<typeof PromptDraftSchema>;

export const BreadcrumbSchema = z.object({
  activeTaskId: z.string().optional(),
  activeTaskTitle: z.string().optional(),
  lastMemoryId: z.string().optional(),
  lastDecision: z.string().optional(),
  updatedAt: z.string(),
  sessionKey: z.string().optional(),
  agentId: z.string().optional(),
});

export type BreadcrumbRecord = z.infer<typeof BreadcrumbSchema>;

export const ExecutionOutcomeSchema = z.object({
  resultSummary: z.string(),
  artifactLinks: z.array(z.string()).default([]),
  memoryDraft: MemorySaveInputSchema.optional(),
  warnings: z.array(z.string()).default([]),
});

export type ExecutionOutcome = z.infer<typeof ExecutionOutcomeSchema>;
