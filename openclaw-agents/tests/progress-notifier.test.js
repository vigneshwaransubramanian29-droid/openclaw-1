import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TaskJournal } from "../src/core/task-journal.js";
import { LifecycleReducer } from "../src/core/lifecycle-reducer.js";
import { ProgressNotifier } from "../src/core/progress-notifier.js";
import { RuntimeAdapter } from "../src/core/runtime-adapter.js";
import { TASK_STATES, buildIdempotencyKey } from "../src/core/reliability-utils.js";

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

test("notifier failure does not affect terminal task state", async () => {
  const dbPath = makeTempDbPath("notifier");
  const journal = new TaskJournal({ filePath: dbPath }).open();
  const reducer = new LifecycleReducer({ journal });
  const runtimeAdapter = new RuntimeAdapter({
    resolveNotifierTarget: async () => ({ channel: "test" }),
  });

  try {
    journal.reserveTask({
      task_id: "task-notify-1",
      task_key: "notify-key-1",
      agent_id: "planner",
      task_payload: { task: "notify" },
      context: {},
      queue_class: "DIRECT_TASKS",
      retry_class: "SAFE_RETRY",
      execution_mode: "subagent",
      attempt: 1,
      idempotency_key: buildIdempotencyKey("task-notify-1", 1),
    });
    reducer.transition({
      taskId: "task-notify-1",
      eventType: "terminal:completed",
      nextState: TASK_STATES.COMPLETED,
      result: {
        status: "success",
        summary: "done",
        citations: [],
        artifacts: [],
        memory_suggestions: [],
        followups: [],
      },
      setTerminal: true,
      clearFailure: true,
    });

    const notifier = new ProgressNotifier({
      journal,
      runtimeAdapter,
      deliverNotification: async () => {
        throw new Error("telegram offline");
      },
    });

    await notifier.pumpOnce();

    const task = journal.getTaskById("task-notify-1");
    const event = journal.getEventsForTask("task-notify-1")[0];
    assert.equal(task.state, TASK_STATES.COMPLETED);
    assert.equal(task.terminal_at > 0, true);
    assert.equal(event.notifier_last_error, "telegram offline");
  } finally {
    journal.close();
    cleanupDb(dbPath);
  }
});
