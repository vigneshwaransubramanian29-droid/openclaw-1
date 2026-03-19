import { describe, expect, it } from "vitest";
import { RetrievalBudgetService } from "./retrievalBudgetService.js";

describe("RetrievalBudgetService", () => {
  const service = new RetrievalBudgetService({
    maxIdeaResults: 5,
    maxPromptIdeaResults: 5,
    maxPlanningResults: 3,
    maxMemoryResults: 2,
    maxExpandedMemories: 1,
    maxContextChars: 200,
    maxPromptKeywords: 4,
  });

  it("builds a compact memory query from task context", () => {
    const query = service.buildMemoryQuery({
      id: "cb_101",
      title: "Integrate OpenClaw plugin with Clawboard memory workflow",
      description:
        "Need plugin first workflow execution with planning queue and durable memory context",
      tags: ["openclaw", "memory", "workflow"],
      promptDraft: "Use planning items as the execution queue and keep memory retrieval compact.",
      notes: [],
      artifactLinks: [],
    });

    expect(query).toContain("Integrate OpenClaw plugin with Clawboard memory workflow");
    expect(query).toContain("openclaw");
    expect(query).not.toContain(" and ");
  });

  it("enforces result and context budgets", () => {
    const summary = service.summarizeHits([
      { id: "m1", title: "One", summary: "First summary entry for retrieval budgeting." },
      { id: "m2", title: "Two", summary: "Second summary entry for retrieval budgeting." },
      { id: "m3", title: "Three", summary: "Third summary entry should be clipped by the limit." },
    ]);

    expect(summary).toContain("1. One:");
    expect(summary).toContain("2. Two:");
    expect(summary).not.toContain("3. Three:");
    expect(service.memories(99)).toBe(2);
    expect(service.expandedMemories(99)).toBe(1);

    const tightContextService = new RetrievalBudgetService({
      maxIdeaResults: 5,
      maxPromptIdeaResults: 5,
      maxPlanningResults: 3,
      maxMemoryResults: 2,
      maxExpandedMemories: 1,
      maxContextChars: 60,
      maxPromptKeywords: 4,
    });

    expect(tightContextService.context("x".repeat(100))).toHaveLength(60);
  });
});
