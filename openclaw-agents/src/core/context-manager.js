import crypto from "node:crypto";
import { estimateTokens } from "./types.js";

function summarizeText(text, maxWords = 100) {
  if (!text) {return "";}
  const words = String(text).replace(/\s+/g, " ").trim().split(" ");
  if (words.length <= maxWords) {return words.join(" ");}
  return `${words.slice(0, maxWords).join(" ")}...`;
}

function pickRelevant(items, maxItems = 6) {
  if (!Array.isArray(items)) {return [];}
  return items.slice(0, maxItems);
}

function makeRefKey(prefix) {
  return `${prefix}:${crypto.randomUUID()}`;
}

function applyExecutionMeta(target, executionMeta = {}) {
  if (!executionMeta || typeof executionMeta !== "object") {
    return target;
  }
  const next = {
    ...target,
  };
  if (executionMeta.task_id) {next.task_id = executionMeta.task_id;}
  if (executionMeta.attempt != null) {next.attempt = executionMeta.attempt;}
  if (executionMeta.idempotency_key) {next.idempotency_key = executionMeta.idempotency_key;}
  if (executionMeta.retry_class) {next.retry_class = executionMeta.retry_class;}
  next.correlation_id = executionMeta.correlation_id || next.task_id;
  if (executionMeta.parent_run_id) {next.parent_run_id = executionMeta.parent_run_id;}
  return next;
}

export class ContextManager {
  constructor(params = {}) {
    this.workspaceStore = params.workspaceStore;
    this.defaultOrchestratorBudget = params.defaultOrchestratorBudget || 2500;
    this.defaultSubAgentBudget = params.defaultSubAgentBudget || 1200;
    this.agentBudgets = params.agentBudgets || {};
  }

  estimate(value) {
    return estimateTokens(value);
  }

  buildOrchestratorContext(input = {}) {
    const budget = input.budgetTokens || this.defaultOrchestratorBudget;
    const pinnedConstraints = Array.isArray(input.constraints) ? input.constraints : [];
    const history = Array.isArray(input.history) ? input.history : [];

    const context = {
      task_id: input.taskId || makeRefKey("task"),
      user_intent: input.userIntent || "",
      constraints: pinnedConstraints,
      plan: input.plan || { steps: [], progress: [] },
      deliverables: input.deliverables || [],
      progress: input.progress || [],
      history_summary: "",
      history_ref: null,
    };
    applyExecutionMeta(context, input.executionMeta);

    let tokenEstimate = this.estimate(context) + this.estimate(history);
    if (tokenEstimate <= budget) {
      context.history_summary = summarizeText(JSON.stringify(history), 220);
      return { context, tokenEstimate, wasCompacted: false };
    }

    const historySummary = summarizeText(
      history
        .map((h) => {
          if (!h) {return "";}
          const role = h.role || "unknown";
          const content = typeof h.content === "string" ? h.content : JSON.stringify(h.content || {});
          return `${role}: ${content}`;
        })
        .join("\n"),
      120,
    );
    context.history_summary = historySummary;

    const historyRef = makeRefKey("history");
    context.history_ref = historyRef;
    if (this.workspaceStore) {
      this.workspaceStore.put("history", historyRef, history, {
        ttl: "short",
        taskId: context.task_id,
        tags: ["history", "compacted"],
      });
    }

    tokenEstimate = this.estimate(context);
    if (tokenEstimate > budget) {
      context.progress = pickRelevant(context.progress, 4);
      context.deliverables = pickRelevant(context.deliverables, 4);
      context.history_summary = summarizeText(historySummary, 80);
    }

    return { context, tokenEstimate: this.estimate(context), wasCompacted: true };
  }

  budgetFor(agentId, fallback) {
    if (!agentId) {return fallback || this.defaultSubAgentBudget;}
    const configured = this.agentBudgets?.[agentId]?.max_context_tokens;
    if (Number.isFinite(configured) && configured > 0) {return configured;}
    return fallback || this.defaultSubAgentBudget;
  }

  prepareSubAgentContext(params = {}) {
    const budget = params.budgetTokens || this.budgetFor(params.agentId, this.defaultSubAgentBudget);
    const source = params.orchestratorContext || {};
    const relevant = pickRelevant(params.relevantArtifacts, 8);

    const minimal = {
      task_id: source.task_id || params.taskId || makeRefKey("task"),
      intent: source.user_intent || params.task || "",
      constraints: source.constraints || [],
      plan: source.plan || { steps: [], progress: [] },
      relevant_artifacts: relevant,
      history_summary: source.history_summary || "",
      refs: source.history_ref ? [source.history_ref] : [],
    };
    applyExecutionMeta(minimal, params.executionMeta || source);

    let estimate = this.estimate(minimal);
    if (estimate > budget) {
      const blobRef = makeRefKey("blob");
      if (this.workspaceStore) {
        this.workspaceStore.put("blobs", blobRef, minimal, {
          ttl: "short",
          taskId: minimal.task_id,
          tags: ["subagent", params.agentId || "unknown"],
        });
      }
      const compact = {
        task_id: minimal.task_id,
        intent: summarizeText(minimal.intent, 40),
        constraints: pickRelevant(minimal.constraints, 5),
        plan: {
          steps: pickRelevant(minimal.plan?.steps || [], 5),
          progress: pickRelevant(minimal.plan?.progress || [], 5),
        },
        refs: [...minimal.refs, blobRef],
      };
      applyExecutionMeta(compact, params.executionMeta || minimal);
      return { context: compact, tokenEstimate: this.estimate(compact), wasCompacted: true };
    }
    return {
      context: applyExecutionMeta(minimal, params.executionMeta || minimal),
      tokenEstimate: estimate,
      wasCompacted: false,
    };
  }

  hydrateRef(namespace, key) {
    if (!this.workspaceStore || !namespace || !key) {return null;}
    return this.workspaceStore.get(namespace, key);
  }

  persistMemorySuggestions(taskId, suggestions = []) {
    if (!this.workspaceStore || !Array.isArray(suggestions)) {return;}
    for (const suggestion of suggestions) {
      if (!suggestion?.key) {continue;}
      this.workspaceStore.put("memory", suggestion.key, suggestion.value, {
        ttl: suggestion.ttl || "short",
        taskId,
        tags: ["memory-suggestion"],
      });
    }
  }
}
