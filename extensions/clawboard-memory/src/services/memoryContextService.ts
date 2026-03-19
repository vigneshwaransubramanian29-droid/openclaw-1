import type { PluginLogger } from "../../api.js";
import { MemoryClient } from "../clients/memoryClient.js";
import type { ClawboardItem } from "../types/clawboard.js";
import type { MemoryRecord, MemorySearchHit } from "../types/memory.js";
import { createComponentLogger } from "../utils/logger.js";
import { RetrievalBudgetService } from "./retrievalBudgetService.js";

export type MemoryContextResult = {
  query: string;
  hits: MemorySearchHit[];
  expanded: MemoryRecord[];
  contextText: string;
  warnings: string[];
};

export class MemoryContextService {
  private readonly logger: PluginLogger;

  constructor(
    private readonly memoryClient: MemoryClient,
    private readonly retrievalBudget: RetrievalBudgetService,
    logger: PluginLogger,
  ) {
    this.logger = createComponentLogger(logger, "memory-context");
  }

  async buildContext(params: {
    item: ClawboardItem;
    namespace?: string;
  }): Promise<MemoryContextResult> {
    const query = this.retrievalBudget.buildMemoryQuery(params.item);
    const warnings: string[] = [];

    let hits: MemorySearchHit[] = [];
    try {
      hits = await this.memoryClient.search({
        query,
        namespace: params.namespace,
        topK: this.retrievalBudget.memories(undefined),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`memory search failed: ${message}`);
      warnings.push(`Memory search failed: ${message}`);
      return {
        query,
        hits: [],
        expanded: [],
        contextText: "",
        warnings,
      };
    }

    const expanded: MemoryRecord[] = [];
    for (const hit of hits.slice(0, this.retrievalBudget.expandedMemories(undefined))) {
      try {
        expanded.push(await this.memoryClient.get(hit.id));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        warnings.push(`Memory expansion failed for ${hit.id}: ${message}`);
      }
    }

    const summaryBlock = this.retrievalBudget.summarizeHits(hits);
    const expandedBlock = expanded
      .map((record, index) => {
        const facts = record.facts.length > 0 ? `Facts: ${record.facts.join("; ")}` : "";
        return `${index + 1}. ${record.title}\nSummary: ${record.summary}${facts ? `\n${facts}` : ""}`;
      })
      .join("\n\n");

    const contextText = this.retrievalBudget.context(
      [
        summaryBlock ? `Memory summaries:\n${summaryBlock}` : "",
        expandedBlock ? `Expanded memories:\n${expandedBlock}` : "",
      ]
        .filter(Boolean)
        .join("\n\n"),
    );

    return {
      query,
      hits,
      expanded,
      contextText,
      warnings,
    };
  }
}
