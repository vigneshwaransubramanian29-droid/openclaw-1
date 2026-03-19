import { z } from "zod";

export const MemoryTypeSchema = z.enum([
  "decision",
  "fact",
  "outcome",
  "architecture",
  "workflow",
  "summary",
  "other",
]);

export type MemoryType = z.infer<typeof MemoryTypeSchema>;

export const MemorySearchHitSchema = z
  .object({
    id: z.string(),
    title: z.string().optional(),
    summary: z.string(),
    snippet: z.string().optional(),
    type: MemoryTypeSchema.optional(),
    tags: z.array(z.string()).optional().default([]),
    score: z.number().optional(),
    namespace: z.string().optional(),
    sourceRef: z.string().optional(),
  })
  .passthrough();

export type MemorySearchHit = z.infer<typeof MemorySearchHitSchema>;

export const MemoryRecordSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    summary: z.string(),
    type: MemoryTypeSchema.optional(),
    tags: z.array(z.string()).optional().default([]),
    taskId: z.string().optional(),
    sourceRef: z.string().optional(),
    importance: z.number().optional(),
    facts: z.array(z.string()).optional().default([]),
    namespace: z.string().optional(),
  })
  .passthrough();

export type MemoryRecord = z.infer<typeof MemoryRecordSchema>;

export const MemorySaveInputSchema = z.object({
  title: z.string(),
  summary: z.string(),
  type: MemoryTypeSchema.default("summary"),
  tags: z.array(z.string()).optional().default([]),
  taskId: z.string().optional(),
  sourceRef: z.string().optional(),
  importance: z.number().min(0).max(1).optional(),
  facts: z.array(z.string()).optional().default([]),
  namespace: z.string().optional(),
});

export type MemorySaveInput = z.infer<typeof MemorySaveInputSchema>;
