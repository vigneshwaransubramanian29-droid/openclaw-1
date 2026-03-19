import { z } from "zod";

export const ClawboardLogicalColumnSchema = z.enum([
  "ideas",
  "promptIdeas",
  "planning",
  "startedTask",
  "finished",
]);

export type ClawboardLogicalColumn = z.infer<typeof ClawboardLogicalColumnSchema>;

export const ClawboardNoteSchema = z
  .object({
    id: z.string().optional(),
    text: z.string().optional(),
    author: z.string().optional(),
    createdAt: z.string().optional(),
  })
  .passthrough();

export type ClawboardNote = z.infer<typeof ClawboardNoteSchema>;

export const ClawboardItemSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    description: z.string().optional().default(""),
    column: z.string().optional(),
    tags: z.array(z.string()).optional().default([]),
    priority: z.string().optional(),
    promptDraft: z.string().optional(),
    notes: z.array(ClawboardNoteSchema).optional().default([]),
    resultSummary: z.string().nullable().optional(),
    memoryId: z.string().nullable().optional(),
    artifactLinks: z.array(z.string()).optional().default([]),
    assignedAgent: z.string().nullable().optional(),
    updatedAt: z.string().optional(),
  })
  .passthrough();

export type ClawboardItem = z.infer<typeof ClawboardItemSchema>;

export type ClawboardListResponse = {
  items: ClawboardItem[];
  raw: unknown;
};
