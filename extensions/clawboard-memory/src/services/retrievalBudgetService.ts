import type { ClawboardItem } from "../types/clawboard.js";
import type { MemorySearchHit } from "../types/memory.js";
import { uniqueStrings } from "../utils/validation.js";

type RetrievalBudgetConfig = {
  maxIdeaResults: number;
  maxPromptIdeaResults: number;
  maxPlanningResults: number;
  maxMemoryResults: number;
  maxExpandedMemories: number;
  maxContextChars: number;
  maxPromptKeywords: number;
};

const STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "in",
  "is",
  "it",
  "of",
  "on",
  "or",
  "that",
  "the",
  "to",
  "with",
]);

export class RetrievalBudgetService {
  constructor(private readonly config: RetrievalBudgetConfig) {}

  ideas(limit?: number): number {
    return this.clampLimit(limit, this.config.maxIdeaResults);
  }

  promptIdeas(limit?: number): number {
    return this.clampLimit(limit, this.config.maxPromptIdeaResults);
  }

  planning(limit?: number): number {
    return this.clampLimit(limit, this.config.maxPlanningResults);
  }

  memories(limit?: number): number {
    return this.clampLimit(limit, this.config.maxMemoryResults);
  }

  expandedMemories(limit?: number): number {
    return this.clampLimit(limit, this.config.maxExpandedMemories);
  }

  context(text: string): string {
    if (text.length <= this.config.maxContextChars) {
      return text;
    }
    return `${text.slice(0, Math.max(0, this.config.maxContextChars - 3)).trimEnd()}...`;
  }

  buildMemoryQuery(item: ClawboardItem): string {
    const words = [
      ...tokenize(item.title),
      ...tokenize(item.description ?? ""),
      ...item.tags,
      ...tokenize(item.promptDraft ?? ""),
    ];
    const keywords = uniqueStrings(
      words.filter((word) => word.length > 2 && !STOPWORDS.has(word.toLowerCase())),
      this.config.maxPromptKeywords,
    );
    return uniqueStrings([item.title, ...item.tags, ...keywords]).join(" | ");
  }

  summarizeHits(hits: MemorySearchHit[]): string {
    const lines = hits.slice(0, this.memories(hits.length)).map((hit, index) => {
      const title = hit.title?.trim() || `memory ${hit.id}`;
      const summary = hit.summary.trim();
      return `${index + 1}. ${title}: ${summary}`;
    });
    return this.context(lines.join("\n"));
  }

  private clampLimit(value: number | undefined, fallback: number): number {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
      return fallback;
    }
    return Math.min(Math.floor(value), fallback);
  }
}

function tokenize(input: string): string[] {
  return input
    .split(/[^A-Za-z0-9_-]+/)
    .map((part) => part.trim())
    .filter(Boolean);
}
