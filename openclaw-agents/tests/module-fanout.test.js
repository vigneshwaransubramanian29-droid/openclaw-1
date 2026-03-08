import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TaskRouter } from "../src/core/task-router.js";
import { ContextManager } from "../src/core/context-manager.js";
import { WorkspaceStore } from "../src/core/workspace-store.js";
import { SubAgentRegistry } from "../src/core/sub-agent-registry.js";
import { MessageBus } from "../src/core/message-bus.js";
import { OrchestratorAgent } from "../src/core/orchestrator-agent.js";

class PassAgent {
  constructor(id) {
    this.id = id;
  }

  async run() {
    return {
      status: "success",
      summary: `${this.id} ok`,
      citations: [],
      artifacts: [{ type: "doc", content: `${this.id}-artifact` }],
      memory_suggestions: [],
      followups: [],
    };
  }
}

class ModuleAwareCodeAgent {
  constructor() {
    this.id = "code";
    this.moduleCalls = new Map();
  }

  async run(task, context) {
    const module = context?.module || "unknown";
    this.moduleCalls.set(module, (this.moduleCalls.get(module) || 0) + 1);
    return {
      status: "success",
      summary: `code ok for ${module}`,
      citations: [],
      artifacts: [{ type: "patch", content: `patch for ${module}` }],
      memory_suggestions: [],
      followups: [],
    };
  }
}

class FlakyModuleTestAgent {
  constructor() {
    this.id = "test";
    this.moduleCalls = new Map();
    this.contextModules = [];
  }

  async run(task, context) {
    const module = context?.module || "unknown";
    this.contextModules.push(module);
    const calls = (this.moduleCalls.get(module) || 0) + 1;
    this.moduleCalls.set(module, calls);

    if (calls < 2) {
      return {
        status: "failed",
        summary: `verification failed for ${module}`,
        citations: [],
        artifacts: [{ type: "doc", content: `fail ${module}` }],
        memory_suggestions: [],
        followups: [],
      };
    }
    return {
      status: "success",
      summary: `verification passed for ${module}`,
      citations: [],
      artifacts: [{ type: "doc", content: `pass ${module}` }],
      memory_suggestions: [],
      followups: [],
    };
  }
}

function makeTempStorePath(name) {
  return path.join(os.tmpdir(), `openclaw-agents-${name}-${Date.now()}.json`);
}

test("module fan-out runs isolated code+test per module and retries until pass", async () => {
  const storePath = makeTempStorePath("module-fanout");
  const store = new WorkspaceStore({ filePath: storePath, maxEntries: 100 });
  const router = new TaskRouter({
    keywords: {
      latest: ["latest"],
      build: ["build", "implement"],
      docs: ["docs"],
      debug: ["error"],
      test: ["test"],
    },
  });
  const contextManager = new ContextManager({
    workspaceStore: store,
    defaultOrchestratorBudget: 2500,
  });

  const codeAgent = new ModuleAwareCodeAgent();
  const testAgent = new FlakyModuleTestAgent();
  const registry = new SubAgentRegistry();
  registry.register("planner", new PassAgent("planner"));
  registry.register("search", new PassAgent("search"));
  registry.register("docs", new PassAgent("docs"));
  registry.register("debug", new PassAgent("debug"));
  registry.register("code", codeAgent);
  registry.register("test", testAgent);

  const messageBus = new MessageBus({ registry });
  const orchestrator = new OrchestratorAgent({
    taskRouter: router,
    contextManager,
    messageBus,
    workspaceStore: store,
    compatMode: false,
    codeFanoutEnabled: true,
    codeFanoutMaxParallel: 2,
    moduleVerificationEnabled: true,
    retryUntilSuccess: true,
    maxRetriesPerModule: 3,
    defaultPipeline: ["planner", "code", "test", "docs"],
  });

  const result = await orchestrator.run(
    {
      task: "build payment platform",
      modules: ["auth", "billing"],
      mode: "multi-agent",
      constraints: [],
      history: [],
    },
    { enableMultiAgent: true },
  );

  assert.equal(result.status, "success");
  assert.equal(codeAgent.moduleCalls.get("auth"), 2);
  assert.equal(codeAgent.moduleCalls.get("billing"), 2);
  assert.equal(testAgent.moduleCalls.get("auth"), 2);
  assert.equal(testAgent.moduleCalls.get("billing"), 2);
  assert.ok(testAgent.contextModules.every((module) => module === "auth" || module === "billing"));
  assert.ok(result.artifacts.some((item) => item.content && String(item.content).includes("auth")));
  assert.ok(result.artifacts.some((item) => item.content && String(item.content).includes("billing")));

  if (fs.existsSync(storePath)) fs.unlinkSync(storePath);
});
