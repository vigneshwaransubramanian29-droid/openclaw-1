import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WorkspaceStore } from "../src/core/workspace-store.js";
import { ContextManager } from "../src/core/context-manager.js";

function makeTempStorePath(name) {
  return path.join(os.tmpdir(), `openclaw-agents-${name}-${Date.now()}.json`);
}

test("context manager compacts oversized orchestrator context and stores history ref", () => {
  const storePath = makeTempStorePath("history");
  const store = new WorkspaceStore({ filePath: storePath, maxEntries: 100 });
  const manager = new ContextManager({
    workspaceStore: store,
    defaultOrchestratorBudget: 120,
  });

  const history = Array.from({ length: 50 }).map((_, i) => ({
    role: i % 2 === 0 ? "user" : "assistant",
    content: `message ${i} ${"x".repeat(60)}`,
  }));

  const out = manager.buildOrchestratorContext({
    taskId: "task-ctx-1",
    userIntent: "implement and test context pruning",
    constraints: ["must keep pinned constraints", "compact old messages"],
    history,
  });

  assert.equal(out.wasCompacted, true);
  assert.ok(out.context.history_ref);
  const cachedHistory = store.get("history", out.context.history_ref);
  assert.equal(Array.isArray(cachedHistory), true);
  assert.ok(cachedHistory.length >= 40);

  if (fs.existsSync(storePath)) fs.unlinkSync(storePath);
});

test("context manager compacts oversized sub-agent payload into blob ref", () => {
  const storePath = makeTempStorePath("blob");
  const store = new WorkspaceStore({ filePath: storePath, maxEntries: 100 });
  const manager = new ContextManager({
    workspaceStore: store,
    defaultSubAgentBudget: 80,
  });

  const orchestratorContext = {
    task_id: "task-ctx-2",
    user_intent: "build system",
    constraints: ["avoid breaking behavior"],
    plan: {
      steps: Array.from({ length: 20 }).map((_, i) => `step ${i}`),
      progress: Array.from({ length: 20 }).map((_, i) => `progress ${i}`),
    },
    history_summary: "long summary ".repeat(100),
    history_ref: "history:abc",
  };

  const artifacts = Array.from({ length: 30 }).map((_, i) => ({
    type: "doc",
    content: `artifact ${i} ${"y".repeat(80)}`,
  }));

  const out = manager.prepareSubAgentContext({
    agentId: "code",
    task: "implement module",
    orchestratorContext,
    relevantArtifacts: artifacts,
    budgetTokens: 90,
  });

  assert.equal(out.wasCompacted, true);
  assert.ok(Array.isArray(out.context.refs));
  assert.ok(out.context.refs.length >= 2);
  const blobRef = out.context.refs.find((ref) => String(ref).startsWith("blob:"));
  assert.ok(blobRef);
  const blob = store.get("blobs", blobRef);
  assert.equal(typeof blob, "object");

  if (fs.existsSync(storePath)) fs.unlinkSync(storePath);
});
