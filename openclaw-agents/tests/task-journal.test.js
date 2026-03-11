import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SubAgentRegistry } from "../src/core/sub-agent-registry.js";
import { TaskJournal } from "../src/core/task-journal.js";
import { LifecycleReducer } from "../src/core/lifecycle-reducer.js";
import { QueueManager } from "../src/core/queue-manager.js";
import { RuntimeAdapter } from "../src/core/runtime-adapter.js";
import { MessageBus } from "../src/core/message-bus.js";
import { HealthTracker } from "../src/core/health-tracker.js";

function makeTempDbPath(name) {
  return path.join(os.tmpdir(), `openclaw-agents-${name}-${Date.now()}-${Math.random()}.sqlite`);
}

function cleanupDb(filePath) {
  for (const suffix of ["", "-shm", "-wal"]) {
    const current = `${filePath}${suffix}`;
    if (fs.existsSync(current)) {
      fs.unlinkSync(current);
    }
  }
}

test("duplicate submit returns existing task and does not respawn", async () => {
  const dbPath = makeTempDbPath("task-journal");
  const registry = new SubAgentRegistry();
  const agent = {
    calls: 0,
    async run() {
      this.calls += 1;
      return {
        status: "success",
        summary: "planner ok",
        citations: [],
        artifacts: [],
        memory_suggestions: [],
        followups: [],
      };
    },
  };
  registry.register("planner", agent);

  const journal = new TaskJournal({ filePath: dbPath }).open();
  const reducer = new LifecycleReducer({ journal });
  const queueManager = new QueueManager();
  const runtimeAdapter = new RuntimeAdapter({ probes: {} });
  const healthTracker = new HealthTracker();
  const messageBus = new MessageBus({
    registry,
    journal,
    reducer,
    queueManager,
    runtimeAdapter,
    healthTracker,
    maxAttempts: {
      SAFE_RETRY: 3,
    },
  });
  runtimeAdapter.setExecutor(async (agentId, task, context) => {
    return await messageBus.dispatch(agentId, task, context);
  });
  await runtimeAdapter.runStartupProbes();

  try {
    const [first, second] = await Promise.all([
      messageBus.submitTask(
        "planner",
        "plan a release",
        { parent_run_id: "root-run", correlation_id: "root-run" },
        { retryClass: "SAFE_RETRY" },
      ),
      messageBus.submitTask(
        "planner",
        "plan a release",
        { parent_run_id: "root-run", correlation_id: "root-run" },
        { retryClass: "SAFE_RETRY" },
      ),
    ]);

    assert.equal(first.task.task_id, second.task.task_id);
    assert.equal(agent.calls, 1);
    assert.ok(first.existing || second.existing);
    assert.equal(journal.countTasksByState().COMPLETED, 1);
    assert.equal(journal.assertInvariants(), true);
  } finally {
    journal.close();
    cleanupDb(dbPath);
  }
});
