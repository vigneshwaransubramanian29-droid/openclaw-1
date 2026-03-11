import crypto from "node:crypto";
import { AGENT_STATUSES, clampWords, createAgentResult } from "./types.js";
import { RETRY_CLASSES } from "./reliability-utils.js";

const DESTRUCTIVE_PATTERN = /\b(delete|remove|drop|truncate|overwrite|destroy|wipe)\b/i;

function dedupeBy(items = [], keyFn) {
  const out = [];
  const seen = new Set();
  for (const item of items) {
    const key = keyFn(item);
    if (!key) {continue;}
    if (seen.has(key)) {continue;}
    seen.add(key);
    out.push(item);
  }
  return out;
}

function dedupeStrings(values = []) {
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
}

function makeTaskId() {
  return `task:${crypto.randomUUID()}`;
}

function parseModuleList(raw) {
  if (!raw) {return [];}
  return dedupeStrings(
    String(raw)
      .split(/[,|;/]/)
      .map((item) => item.trim()),
  ).slice(0, 12);
}

function extractModulesFromTask(taskText) {
  const text = String(taskText || "");
  const match = text.match(/modules?\s*[:=-]\s*([^\n]+)/i);
  if (match?.[1]) {return parseModuleList(match[1]);}

  const forModules = text.match(/for modules?\s+([^\n]+)/i);
  if (forModules?.[1]) {return parseModuleList(forModules[1]);}

  const lines = text.split(/\r?\n/).map((line) => line.trim());
  const moduleLines = lines
    .filter((line) => /^[-*]\s*module[:\s]/i.test(line))
    .map((line) => line.replace(/^[-*]\s*module[:\s]*/i, ""));
  if (moduleLines.length > 0) {return dedupeStrings(moduleLines).slice(0, 12);}

  return [];
}

async function runWithConcurrency(items, limit, worker) {
  const max = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 1;
  const queue = items.map((item, index) => ({ item, index }));
  const results = Array.from({ length: items.length });

  const runners = Array.from({ length: Math.min(max, items.length) }).map(async () => {
    while (queue.length > 0) {
      const current = queue.shift();
      if (!current) {return;}
      results[current.index] = await worker(current.item, current.index);
    }
  });
  await Promise.all(runners);
  return results.filter(Boolean);
}

function normalizeTaskInput(input) {
  if (typeof input === "string") {
    return {
      taskId: makeTaskId(),
      task: input,
      constraints: [],
      plan: { steps: [], progress: [] },
      progress: [],
      deliverables: [],
      history: [],
      mode: "auto",
      destructiveApproved: false,
      modules: extractModulesFromTask(input),
      verifyModules: true,
    };
  }
  const payload = input && typeof input === "object" ? input : {};
  const task = String(payload.task || payload.userIntent || "");
  const explicitModules = Array.isArray(payload.modules) ? payload.modules : [];
  const modules = dedupeStrings(
    explicitModules.length > 0 ? explicitModules : extractModulesFromTask(task),
  ).slice(0, 12);
  return {
    taskId: payload.taskId || makeTaskId(),
    task,
    constraints: Array.isArray(payload.constraints) ? payload.constraints : [],
    plan:
      payload.plan && typeof payload.plan === "object"
        ? payload.plan
        : { steps: [], progress: [] },
    progress: Array.isArray(payload.progress) ? payload.progress : [],
    deliverables: Array.isArray(payload.deliverables) ? payload.deliverables : [],
    history: Array.isArray(payload.history) ? payload.history : [],
    mode: payload.mode || "auto",
    destructiveApproved: !!payload.destructiveApproved,
    modules,
    verifyModules: payload.verifyModules !== false,
  };
}

function normalizeAgentId(agentId) {
  return String(agentId || "")
    .replace(/\[.*\]/g, "")
    .trim();
}

function isAdvisoryNeedsMoreInfo(entry, effectiveRuns) {
  if (entry?.result?.status !== AGENT_STATUSES.NEEDS_MORE_INFO) {
    return false;
  }
  if (normalizeAgentId(entry.agentId) !== "search") {
    return false;
  }
  return effectiveRuns.some(
    (candidate) =>
      normalizeAgentId(candidate?.agentId) !== "search" &&
      candidate?.result?.status === AGENT_STATUSES.SUCCESS,
  );
}

function aggregateStatus(effectiveRuns = []) {
  const blockingRuns = effectiveRuns.filter(
    (entry) => !isAdvisoryNeedsMoreInfo(entry, effectiveRuns),
  );
  const statuses = new Set(blockingRuns.map((entry) => entry?.result?.status).filter(Boolean));
  if (statuses.has(AGENT_STATUSES.FAILED)) {return AGENT_STATUSES.FAILED;}
  if (statuses.has(AGENT_STATUSES.SUCCESS)) {return AGENT_STATUSES.SUCCESS;}
  if (statuses.has(AGENT_STATUSES.NEEDS_MORE_INFO)) {return AGENT_STATUSES.NEEDS_MORE_INFO;}

  const fallbackStatuses = new Set(
    effectiveRuns.map((entry) => entry?.result?.status).filter(Boolean),
  );
  if (fallbackStatuses.has(AGENT_STATUSES.SUCCESS)) {return AGENT_STATUSES.SUCCESS;}
  if (fallbackStatuses.has(AGENT_STATUSES.NEEDS_MORE_INFO)) {
    return AGENT_STATUSES.NEEDS_MORE_INFO;
  }
  return AGENT_STATUSES.SUCCESS;
}

function normalizeRunKey(agentId) {
  return String(agentId || "")
    .replace(/\[(?:try|retry|verify):\d+\]/gi, "")
    .trim();
}

function latestLogicalRuns(pipelineRuns = []) {
  const byKey = new Map();
  for (const entry of pipelineRuns) {
    const key = normalizeRunKey(entry?.agentId);
    byKey.set(key, entry);
  }
  return [...byKey.values()];
}

function mergeSummaries(route, runs) {
  const parts = (runs || [])
    .map((entry) => `${entry.agentId}: ${entry.result.summary}`)
    .filter(Boolean);
  if (parts.length === 0) {
    return clampWords(
      `Handled directly as ${route.intent} with low complexity and no delegation.`,
      80,
    );
  }
  return clampWords(parts.join(" "), 80);
}

export class OrchestratorAgent {
  constructor(params = {}) {
    this.id = "orchestrator";
    this.taskRouter = params.taskRouter;
    this.contextManager = params.contextManager;
    this.messageBus = params.messageBus;
    this.workspaceStore = params.workspaceStore;
    this.compatMode = params.compatMode !== false;
    this.orchestratorBudgetTokens = params.orchestratorBudgetTokens || 2500;
    this.smallTaskTokenThreshold = params.smallTaskTokenThreshold || 700;
    this.defaultPipeline = Array.isArray(params.defaultPipeline)
      ? params.defaultPipeline
      : ["planner", "code", "test", "docs"];
    this.codeFanoutEnabled = params.codeFanoutEnabled !== false;
    this.codeFanoutMaxParallel = params.codeFanoutMaxParallel || 3;
    this.moduleVerificationEnabled = params.moduleVerificationEnabled !== false;
    this.retryUntilSuccess = params.retryUntilSuccess !== false;
    this.maxRetriesPerModule = params.maxRetriesPerModule || 4;
    this.maxPipelineRetries = params.maxPipelineRetries || 3;
  }

  #requiresApproval(taskText, taskInput) {
    if (!DESTRUCTIVE_PATTERN.test(taskText || "")) {return false;}
    return !taskInput.destructiveApproved;
  }

  #storeDecision(taskId, route, mode, contextMeta) {
    if (!this.workspaceStore) {return;}
    this.workspaceStore.put(
      "decisions",
      `route:${taskId}`,
      {
        route,
        mode,
        wasCompacted: !!contextMeta?.wasCompacted,
        tokenEstimate: contextMeta?.tokenEstimate || 0,
        decidedAt: new Date().toISOString(),
      },
      { ttl: "long", taskId, tags: ["decision", route.intent] },
    );
  }

  #resolvePipeline(route) {
    if (Array.isArray(route.selectedAgents) && route.selectedAgents.length > 0) {
      return route.selectedAgents;
    }
    if (route.intent === "general" && route.complexity === "low") {return [];}
    return this.defaultPipeline;
  }

  #buildOrchestratorContext(taskInput) {
    return this.contextManager.buildOrchestratorContext({
      taskId: taskInput.taskId,
      userIntent: taskInput.task,
      constraints: taskInput.constraints,
      plan: taskInput.plan,
      progress: taskInput.progress,
      deliverables: taskInput.deliverables,
      history: taskInput.history,
      budgetTokens: this.orchestratorBudgetTokens,
    });
  }

  #collectArtifacts(runs) {
    return (runs || []).flatMap((entry) => entry.result.artifacts || []);
  }

  #shouldFanOutCode(route, taskInput, pipeline) {
    if (!this.codeFanoutEnabled) {return false;}
    if (!Array.isArray(pipeline) || !pipeline.includes("code")) {return false;}
    if (!Array.isArray(taskInput.modules) || taskInput.modules.length < 2) {return false;}
    return route.intent === "build" || route.complexity !== "low";
  }

  #shouldRetryResult(result) {
    return result?.status !== AGENT_STATUSES.SUCCESS;
  }

  #usesManagedExecution() {
    return (
      typeof this.messageBus?.submitTask === "function" &&
      this.messageBus?.isDirectOnly?.() !== true
    );
  }

  #classifyRetryClass(agentId, taskText, taskInput) {
    if (this.#requiresApproval(taskText, { ...taskInput, destructiveApproved: true })) {
      return RETRY_CLASSES.MANUAL_RETRY;
    }
    if (agentId === "code") {
      return RETRY_CLASSES.GUARDED_RETRY;
    }
    return RETRY_CLASSES.SAFE_RETRY;
  }

  async #runAgentTask(
    agentId,
    taskText,
    orchestratorContext,
    relevantArtifacts,
    taskInput,
    extraContext = {},
  ) {
    const prepared = this.contextManager.prepareSubAgentContext({
      agentId,
      task: taskText,
      orchestratorContext,
      relevantArtifacts,
      budgetTokens: this.contextManager.budgetFor(agentId),
      executionMeta: {
        parent_run_id: orchestratorContext.task_id,
        correlation_id: orchestratorContext.correlation_id || orchestratorContext.task_id,
      },
    });
    const subContext = {
      ...prepared.context,
      ...extraContext,
    };

    if (this.#usesManagedExecution()) {
      const submitted = await this.messageBus.submitTask(agentId, taskText, subContext, {
        retryClass: this.#classifyRetryClass(agentId, taskText, taskInput),
      });
      return submitted.result;
    }

    return await this.messageBus.dispatch(agentId, taskText, subContext);
  }

  async #runModuleCodeAndVerification(
    moduleName,
    taskText,
    orchestratorContext,
    priorRuns,
    taskInput,
  ) {
    const sharedArtifacts = this.#collectArtifacts(priorRuns);
    const shouldVerify = this.moduleVerificationEnabled && taskInput.verifyModules !== false;
    const allRuns = [];
    const managedExecution = this.#usesManagedExecution();
    const maxAttempts =
      !managedExecution && this.retryUntilSuccess && shouldVerify
        ? Math.max(1, this.maxRetriesPerModule)
        : 1;

    let attempt = 1;
    let lastFailureSummary = "";
    while (attempt <= maxAttempts) {
      const moduleTask = [
        taskText,
        "",
        `Module scope: ${moduleName}`,
        "Implement only this module and avoid touching unrelated modules.",
        `Attempt: ${attempt}`,
        lastFailureSummary
          ? `Previous failure summary: ${lastFailureSummary}`
          : "Previous failure summary: none",
      ].join("\n");

      const codeResult = await this.#runAgentTask(
        "code",
        moduleTask,
        orchestratorContext,
        sharedArtifacts,
        taskInput,
        {
          module: moduleName,
          module_scope: "isolated",
          attempt,
        },
      );
      allRuns.push({ agentId: `code[module:${moduleName}][try:${attempt}]`, result: codeResult });

      if (codeResult.status === AGENT_STATUSES.FAILED) {
        lastFailureSummary = codeResult.summary || "code stage failed";
        if (attempt >= maxAttempts || !this.retryUntilSuccess) {break;}
        attempt += 1;
        continue;
      }

      if (!shouldVerify) {break;}

      const verifyTask = [
        taskText,
        "",
        `Verify module: ${moduleName}`,
        "Run focused tests/checks only for this module and report isolated commands/results.",
        `Attempt: ${attempt}`,
      ].join("\n");
      const testResult = await this.#runAgentTask(
        "test",
        verifyTask,
        orchestratorContext,
        [...sharedArtifacts, ...(codeResult.artifacts || [])],
        taskInput,
        {
          module: moduleName,
          module_scope: "isolated",
          attempt,
        },
      );
      allRuns.push({ agentId: `test[module:${moduleName}][try:${attempt}]`, result: testResult });

      if (!this.#shouldRetryResult(testResult)) {break;}
      lastFailureSummary = testResult.summary || "module verification failed";
      if (attempt >= maxAttempts || !this.retryUntilSuccess) {break;}
      attempt += 1;
    }
    return allRuns;
  }

  async #runCodeFanout(route, taskText, orchestratorContext, runs, taskInput) {
    const modules = dedupeStrings(taskInput.modules).slice(0, 12);
    const fanoutRuns = await runWithConcurrency(
      modules,
      this.codeFanoutMaxParallel,
      async (moduleName) =>
        this.#runModuleCodeAndVerification(
          moduleName,
          taskText,
          orchestratorContext,
          runs,
          taskInput,
        ),
    );
    return fanoutRuns.flat();
  }

  async #runGlobalVerificationWithRetries(taskText, orchestratorContext, runs, taskInput) {
    const out = [];
    const managedExecution = this.#usesManagedExecution();
    const maxAttempts =
      !managedExecution && this.retryUntilSuccess ? Math.max(1, this.maxPipelineRetries) : 1;
    let attempt = 1;
    let lastFailureSummary = "";
    let lastTestResult = null;

    while (attempt <= maxAttempts) {
      if (attempt > 1) {
        const retryCodeTask = [
          taskText,
          "",
          `Global retry cycle: ${attempt}`,
          `Previous verification failure: ${lastFailureSummary || "unknown"}`,
        ].join("\n");
        const retryCodeResult = await this.#runAgentTask(
          "code",
          retryCodeTask,
          orchestratorContext,
          [...this.#collectArtifacts(runs), ...this.#collectArtifacts(out)],
          taskInput,
          {
            attempt,
          },
        );
        out.push({ agentId: `code[retry:${attempt}]`, result: retryCodeResult });
        if (retryCodeResult.status === AGENT_STATUSES.FAILED) {break;}
      }

      const testTask = [
        taskText,
        "",
        `Global verification cycle: ${attempt}`,
        "Run strict regression tests and fail if any acceptance criterion is not met.",
      ].join("\n");
      const testResult = await this.#runAgentTask(
        "test",
        testTask,
        orchestratorContext,
        [...this.#collectArtifacts(runs), ...this.#collectArtifacts(out)],
        taskInput,
        {
          attempt,
        },
      );
      out.push({ agentId: `test[verify:${attempt}]`, result: testResult });
      lastTestResult = testResult;
      if (!this.#shouldRetryResult(testResult)) {break;}

      lastFailureSummary = testResult.summary || "verification failed";
      if (!this.retryUntilSuccess || attempt >= maxAttempts) {break;}
      attempt += 1;
    }
    return { runs: out, finalTestResult: lastTestResult };
  }

  #mergeResults(route, pipelineRuns, contextMeta, mode) {
    const effectiveRuns = latestLogicalRuns(pipelineRuns || []);
    const status = aggregateStatus(effectiveRuns);
    const citations = dedupeBy(
      (pipelineRuns || []).flatMap((entry) => entry.result.citations || []),
      (citation) => citation.url?.toLowerCase(),
    ).slice(0, 7);
    const artifacts = (pipelineRuns || []).flatMap((entry) => entry.result.artifacts || []);
    const memorySuggestions = (pipelineRuns || []).flatMap(
      (entry) => entry.result.memory_suggestions || [],
    );
    const followups = dedupeBy(
      [
        ...((pipelineRuns || []).flatMap((entry) => entry.result.followups || [])),
        `Routing intent: ${route.intent} (${route.complexity})`,
      ],
      (item) => String(item || "").toLowerCase(),
    );

    const summary = mergeSummaries(route, pipelineRuns);
    return createAgentResult({
      status,
      summary,
      citations,
      artifacts: [
        ...artifacts,
        {
          type: "doc",
          content: JSON.stringify(
            {
              mode,
              route,
              pipeline: (pipelineRuns || []).map((entry) => ({
                agentId: entry.agentId,
                status: entry.result.status,
              })),
              context: {
                tokenEstimate: contextMeta.tokenEstimate,
                wasCompacted: contextMeta.wasCompacted,
              },
            },
            null,
            2,
          ),
        },
      ],
      memory_suggestions: memorySuggestions,
      followups,
    });
  }

  async #runCompat(route, taskText, orchestratorContext, taskInput, contextMeta) {
    const selected = this.#resolvePipeline(route);
    if (selected.length === 0) {
      return createAgentResult({
        status: AGENT_STATUSES.SUCCESS,
        summary:
          "Compat mode handled request directly with no delegation because route was low-complexity.",
        citations: [],
        artifacts: [],
        memory_suggestions: [
          {
            key: `orchestrator:compat:${taskInput.taskId}`,
            value: { route, delegated: [] },
            ttl: "short",
          },
        ],
        followups: ["Enable multi-agent mode for full delegation pipeline."],
      });
    }

    const firstAgent = selected[0];
    const firstResult = await this.#runAgentTask(
      firstAgent,
      taskText,
      orchestratorContext,
      [],
      taskInput,
    );
    this.contextManager.persistMemorySuggestions(taskInput.taskId, firstResult.memory_suggestions);
    this.#storeDecision(taskInput.taskId, route, "compat", contextMeta);
    return createAgentResult({
      status: firstResult.status,
      summary: clampWords(
        `Compat mode delegated to ${firstAgent} only. ${firstResult.summary || ""}`,
        80,
      ),
      citations: firstResult.citations,
      artifacts: firstResult.artifacts,
      memory_suggestions: firstResult.memory_suggestions,
      followups: dedupeBy(
        [...(firstResult.followups || []), "Set enableMultiAgent=true to run full pipeline."],
        (item) => String(item || "").toLowerCase(),
      ),
    });
  }

  async #runPipeline(route, taskText, orchestratorContext, taskInput, contextMeta) {
    const pipeline = this.#resolvePipeline(route);
    if (pipeline.length === 0) {
      this.#storeDecision(taskInput.taskId, route, "self", contextMeta);
      return createAgentResult({
        status: AGENT_STATUSES.SUCCESS,
        summary: clampWords(
          "Task handled by orchestrator directly because routing marked it as lightweight.",
          80,
        ),
        citations: [],
        artifacts: [],
        memory_suggestions: [],
        followups: ["No delegation needed."],
      });
    }
    const runs = [];
    const codeFanout = this.#shouldFanOutCode(route, taskInput, pipeline);

    for (const agentId of pipeline) {
      if (agentId === "code" && codeFanout) {
        const moduleRuns = await this.#runCodeFanout(
          route,
          taskText,
          orchestratorContext,
          runs,
          taskInput,
        );
        runs.push(...moduleRuns);
        if (moduleRuns.some((entry) => entry.result.status === AGENT_STATUSES.FAILED)) {break;}
        continue;
      }

      if (agentId === "test" && codeFanout && this.moduleVerificationEnabled) {
        continue;
      }

      if (agentId === "test" && !codeFanout && this.retryUntilSuccess) {
        const verification = await this.#runGlobalVerificationWithRetries(
          taskText,
          orchestratorContext,
          runs,
          taskInput,
        );
        runs.push(...verification.runs);
        if (verification.finalTestResult?.status === AGENT_STATUSES.FAILED) {break;}
        continue;
      }

      const relevantArtifacts = this.#collectArtifacts(runs);
      const result = await this.#runAgentTask(
        agentId,
        taskText,
        orchestratorContext,
        relevantArtifacts,
        taskInput,
      );
      runs.push({ agentId, result });
      if (result.status === AGENT_STATUSES.FAILED) {break;}
    }

    const merged = this.#mergeResults(route, runs, contextMeta, "multi-agent");
    this.contextManager.persistMemorySuggestions(taskInput.taskId, merged.memory_suggestions);
    this.#storeDecision(taskInput.taskId, route, "multi-agent", contextMeta);
    return merged;
  }

  async run(input, runtimeOptions = {}) {
    const taskInput = normalizeTaskInput(input);
    const taskText = taskInput.task;
    const route = this.taskRouter.route(taskText, { skipDocs: false, offlineOnly: false });
    const contextMeta = this.#buildOrchestratorContext(taskInput);
    const orchestratorContext = contextMeta.context;
    const estimatedTaskTokens = this.contextManager.estimate(taskText);

    if (this.#requiresApproval(taskText, taskInput)) {
      return createAgentResult({
        status: AGENT_STATUSES.NEEDS_MORE_INFO,
        summary:
          "Request includes potentially destructive actions. Explicit approval is required before delegation.",
        citations: [],
        artifacts: [],
        memory_suggestions: [],
        followups: ["Set destructiveApproved=true and retry."],
      });
    }

    const wantsMultiAgent =
      runtimeOptions.enableMultiAgent === true ||
      taskInput.mode === "multi-agent" ||
      (!this.compatMode && estimatedTaskTokens > this.smallTaskTokenThreshold);

    if (this.compatMode && !wantsMultiAgent) {
      return this.#runCompat(route, taskText, orchestratorContext, taskInput, contextMeta);
    }

    return this.#runPipeline(route, taskText, orchestratorContext, taskInput, contextMeta);
  }
}
