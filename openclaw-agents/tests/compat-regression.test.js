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

class DummyAgent {
  constructor(id) {
    this.id = id;
  }

  async run() {
    return {
      status: "success",
      summary: `${this.id} executed`,
      citations: [],
      artifacts: [{ type: "doc", content: `${this.id}-artifact` }],
      memory_suggestions: [],
      followups: [],
    };
  }
}

function makeTempStorePath(name) {
  return path.join(os.tmpdir(), `openclaw-agents-${name}-${Date.now()}.json`);
}

test("compat mode preserves single-agent legacy path while multi-agent can be enabled", async () => {
  const storePath = makeTempStorePath("compat");
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

  const registry = new SubAgentRegistry();
  for (const id of ["planner", "search", "code", "test", "docs", "debug"]) {
    registry.register(id, new DummyAgent(id));
  }
  const messageBus = new MessageBus({ registry });
  const orchestrator = new OrchestratorAgent({
    taskRouter: router,
    contextManager,
    messageBus,
    workspaceStore: store,
    compatMode: true,
    defaultPipeline: ["planner", "search", "code", "test", "docs"],
  });

  const compatResult = await orchestrator.run(
    {
      task: "build latest feature with tests and docs",
      history: [],
      constraints: [],
    },
    { enableMultiAgent: false },
  );

  assert.equal(compatResult.status, "success");
  assert.equal(messageBus.trace.length, 1);
  assert.ok(compatResult.summary.toLowerCase().includes("compat mode delegated"));

  messageBus.trace.length = 0;
  const multiResult = await orchestrator.run(
    {
      task: "build latest feature with tests and docs",
      history: [],
      constraints: [],
      mode: "multi-agent",
    },
    { enableMultiAgent: true },
  );

  assert.equal(multiResult.status, "success");
  assert.ok(messageBus.trace.length >= 3);
  assert.ok(multiResult.artifacts.length >= 3);

  if (fs.existsSync(storePath)) {fs.unlinkSync(storePath);}
});

test("degraded direct-only mode preserves current direct wrapper behavior", async () => {
  const storePath = makeTempStorePath("degraded-direct");
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

  const registry = new SubAgentRegistry();
  for (const id of ["planner", "search", "code", "test", "docs", "debug"]) {
    registry.register(id, new DummyAgent(id));
  }
  const messageBus = new MessageBus({ registry, directOnly: true });
  const orchestrator = new OrchestratorAgent({
    taskRouter: router,
    contextManager,
    messageBus,
    workspaceStore: store,
    compatMode: false,
    retryUntilSuccess: true,
    defaultPipeline: ["planner", "search", "code", "test", "docs"],
  });

  const result = await orchestrator.run(
    {
      task: "build latest feature with tests and docs",
      history: [],
      constraints: [],
      mode: "multi-agent",
    },
    { enableMultiAgent: true },
  );

  assert.equal(messageBus.isDirectOnly(), true);
  assert.equal(result.status, "success");
  assert.ok(messageBus.trace.length >= 3);

  if (fs.existsSync(storePath)) {fs.unlinkSync(storePath);}
});
