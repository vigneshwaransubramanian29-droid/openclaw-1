import path from "node:path";
import { fileURLToPath } from "node:url";
import { ConfigLoader } from "./core/config-loader.js";
import { WorkspaceStore } from "./core/workspace-store.js";
import { SubAgentRegistry } from "./core/sub-agent-registry.js";
import { TaskRouter } from "./core/task-router.js";
import { ContextManager } from "./core/context-manager.js";
import { MessageBus } from "./core/message-bus.js";
import { ToolProxy } from "./core/tool-proxy.js";
import { OrchestratorAgent } from "./core/orchestrator-agent.js";
import { WebSearchService } from "./search/web-search-service.js";
import { MockSearchProvider } from "./search/providers/mock-provider.js";
import { OpenClawToolProvider } from "./search/providers/openclaw-tool-provider.js";
import { SerpApiProvider } from "./search/providers/serpapi-provider.js";
import { BingSearchProvider } from "./search/providers/bing-provider.js";
import { BraveSearchProvider } from "./search/providers/brave-provider.js";
import { PlannerAgent } from "./agents/planner-agent.js";
import { CodeAgent } from "./agents/code-agent.js";
import { TestAgent } from "./agents/test-agent.js";
import { DocsAgent } from "./agents/docs-agent.js";
import { SearchAgent } from "./agents/search-agent.js";
import { DebugAgent } from "./agents/debug-agent.js";

function bool(value, fallback = false) {
  if (value === undefined || value === null) return fallback;
  return !!value;
}

function buildProviders(websearchConfig = {}, runtime = {}) {
  const providers = {};
  const providerConfig = websearchConfig.providers || {};

  if (providerConfig.openclaw?.enabled !== false) {
    providers.openclaw = new OpenClawToolProvider({
      searchFn: runtime.openclawSearchFn,
    });
  }
  if (providerConfig.serpapi?.enabled) {
    providers.serpapi = new SerpApiProvider({
      apiKey: providerConfig.serpapi.api_key,
      baseUrl: providerConfig.serpapi.base_url,
    });
  }
  if (providerConfig.bing?.enabled) {
    providers.bing = new BingSearchProvider({
      apiKey: providerConfig.bing.api_key,
      baseUrl: providerConfig.bing.base_url,
    });
  }
  if (providerConfig.brave?.enabled) {
    providers.brave = new BraveSearchProvider({
      apiKey: providerConfig.brave.api_key,
      baseUrl: providerConfig.brave.base_url,
    });
  }

  if (Object.keys(providers).length === 0) {
    providers.mock = new MockSearchProvider({
      id: "mock",
      lookup: async () => [],
    });
  }
  return providers;
}

function makeAgentMeta(agentConfig, agentId) {
  const raw = agentConfig?.definitions?.[agentId] || {};
  return {
    name: raw.name || agentId,
    purpose: raw.purpose || "",
    token_budget: raw.token_budget || {},
  };
}

export function createSystem(options = {}) {
  const currentFile = fileURLToPath(import.meta.url);
  const srcDir = path.dirname(currentFile);
  const projectRoot = options.projectRoot || path.resolve(srcDir, "..");
  const configDir = options.configDir || path.join(projectRoot, "config");

  const loader = new ConfigLoader(configDir);
  const config = loader.loadAll();

  const agentConfig = config.agents || {};
  const routingConfig = config.routing || {};
  const websearchConfig = config.websearch || {};

  const workspaceStore = new WorkspaceStore({
    filePath: options.workspaceStorePath || path.join(projectRoot, ".workspace-store.json"),
    maxEntries: agentConfig.workspace_store?.max_entries || 4000,
  });
  workspaceStore.evictExpired();

  const router = new TaskRouter(routingConfig);
  const registry = new SubAgentRegistry();
  const toolProxy = new ToolProxy({
    agentPolicies: agentConfig.agent_policies || {},
  });

  const providers = buildProviders(websearchConfig, options);
  const webSearchService = new WebSearchService({
    providers,
    defaultProvider: websearchConfig.default_provider,
    providerOrder: websearchConfig.provider_order,
    cacheTtlHours: websearchConfig.cache?.ttl_hours || 24,
    retries: websearchConfig.retries?.max_attempts ?? 2,
    rateLimits: websearchConfig.rate_limits || {},
    synonyms: websearchConfig.query_optimization?.synonyms || {},
    operatorTemplates: websearchConfig.query_optimization?.operator_templates || {},
    fallbackQuerySuffixes: websearchConfig.query_optimization?.fallback_suffixes || [],
    authoritativeDomains: websearchConfig.scoring?.authority_domains || [],
    minStrongResults: websearchConfig.scoring?.min_strong_results || 3,
    titleSimilarityThreshold: websearchConfig.scoring?.title_similarity_threshold || 0.92,
    workspaceStore,
  });

  const contextManager = new ContextManager({
    workspaceStore,
    defaultOrchestratorBudget: agentConfig.orchestrator?.max_context_tokens || 2500,
    defaultSubAgentBudget: agentConfig.defaults?.max_context_tokens || 1200,
    agentBudgets: agentConfig.agent_budgets || {},
  });

  const plannerAgent = new PlannerAgent();
  const codeAgent = new CodeAgent({ toolProxy });
  const testAgent = new TestAgent({ toolProxy });
  const docsAgent = new DocsAgent({ toolProxy });
  const debugAgent = new DebugAgent({ toolProxy });
  const searchBudget = agentConfig.agent_budgets?.search || {};
  const searchAgent = new SearchAgent({
    webSearchService,
    toolProxy,
    maxContextTokens: searchBudget.max_context_tokens || 600,
    maxOutputTokens: searchBudget.max_output_tokens || 350,
  });

  registry.register("planner", plannerAgent, makeAgentMeta(agentConfig, "planner"));
  registry.register("code", codeAgent, makeAgentMeta(agentConfig, "code"));
  registry.register("test", testAgent, makeAgentMeta(agentConfig, "test"));
  registry.register("docs", docsAgent, makeAgentMeta(agentConfig, "docs"));
  registry.register("debug", debugAgent, makeAgentMeta(agentConfig, "debug"));
  registry.register("search", searchAgent, makeAgentMeta(agentConfig, "search"));

  const messageBus = new MessageBus({ registry });
  const orchestrator = new OrchestratorAgent({
    taskRouter: router,
    contextManager,
    messageBus,
    workspaceStore,
    compatMode: bool(agentConfig.compat_mode, true),
    orchestratorBudgetTokens: agentConfig.orchestrator?.max_context_tokens || 2500,
    smallTaskTokenThreshold: agentConfig.orchestrator?.small_task_token_threshold || 700,
    defaultPipeline: agentConfig.orchestrator?.default_pipeline || ["planner", "code", "test", "docs"],
    retryUntilSuccess: bool(agentConfig.orchestrator?.retry_until_success, true),
    maxPipelineRetries: agentConfig.orchestrator?.max_pipeline_retries || 3,
    maxRetriesPerModule: agentConfig.orchestrator?.max_module_retries || 4,
    codeFanoutEnabled: bool(agentConfig.orchestrator?.code_fanout?.enabled, true),
    codeFanoutMaxParallel: agentConfig.orchestrator?.code_fanout?.max_parallel || 3,
    moduleVerificationEnabled: bool(agentConfig.orchestrator?.code_fanout?.verify_each_module, true),
  });

  registry.register("orchestrator", orchestrator, {
    name: "main_orchestrator",
    purpose: "routes and merges sub-agent outputs",
  });

  return {
    config,
    registry,
    toolProxy,
    contextManager,
    workspaceStore,
    webSearchService,
    messageBus,
    orchestrator,
  };
}

function parseCliArgs(argv) {
  const args = { task: "", modules: [], enableMultiAgent: false, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--task" && i + 1 < argv.length) {
      args.task = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--modules" && i + 1 < argv.length) {
      args.modules = String(argv[i + 1])
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
      i += 1;
      continue;
    }
    if (arg === "--multi") {
      args.enableMultiAgent = true;
      continue;
    }
    if (arg === "--json") {
      args.json = true;
    }
  }
  return args;
}

async function runCli() {
  const args = parseCliArgs(process.argv.slice(2));
  if (!args.task) {
    // eslint-disable-next-line no-console
    console.log('Usage: npm start -- --task "your task" [--modules "a,b"] [--multi] [--json]');
    process.exitCode = 1;
    return;
  }

  const system = createSystem();
  const result = await system.orchestrator.run(
    {
      task: args.task,
      modules: args.modules,
      mode: args.enableMultiAgent ? "multi-agent" : "auto",
      constraints: [],
      history: [],
    },
    { enableMultiAgent: args.enableMultiAgent },
  );

  if (args.json) {
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  // eslint-disable-next-line no-console
  console.log(`status: ${result.status}`);
  // eslint-disable-next-line no-console
  console.log(`summary: ${result.summary}`);
  // eslint-disable-next-line no-console
  console.log(`citations: ${result.citations.length}`);
  // eslint-disable-next-line no-console
  console.log(`artifacts: ${result.artifacts.length}`);
}

const isMain = (() => {
  const current = fileURLToPath(import.meta.url);
  const entry = process.argv[1] ? path.resolve(process.argv[1]) : "";
  return current === entry;
})();

if (isMain) {
  runCli().catch((error) => {
    // eslint-disable-next-line no-console
    console.error(error);
    process.exitCode = 1;
  });
}
