import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TaskJournal } from "../src/core/task-journal.js";
import { LifecycleReducer } from "../src/core/lifecycle-reducer.js";
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

test("duplicate event_key is ignored and second terminal transition is rejected", () => {
  const dbPath = makeTempDbPath("reducer");
  const journal = new TaskJournal({ filePath: dbPath }).open();
  const reducer = new LifecycleReducer({ journal });

  try {
    journal.reserveTask({
      task_id: "task-reducer-1",
      task_key: "task-key-1",
      agent_id: "planner",
      task_payload: { task: "plan" },
      context: {},
      queue_class: "DIRECT_TASKS",
      retry_class: "SAFE_RETRY",
      execution_mode: "subagent",
      attempt: 1,
      idempotency_key: buildIdempotencyKey("task-reducer-1", 1),
    });

    const accepted = reducer.transition({
      taskId: "task-reducer-1",
      eventType: "progress:accepted",
      nextState: TASK_STATES.ACCEPTED,
    });
    const duplicateAccepted = reducer.transition({
      taskId: "task-reducer-1",
      eventType: "progress:accepted",
      nextState: TASK_STATES.ACCEPTED,
    });
    assert.equal(accepted.applied, true);
    assert.equal(duplicateAccepted.applied, false);
    assert.equal(duplicateAccepted.reason, "duplicate_event");

    const completed = reducer.transition({
      taskId: "task-reducer-1",
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
    const secondTerminal = reducer.transition({
      taskId: "task-reducer-1",
      eventType: "terminal:failed",
      nextState: TASK_STATES.FAILED,
      failure: {
        code: "should_ignore",
        message: "ignored",
        details: null,
      },
      setTerminal: true,
    });

    const task = journal.getTaskById("task-reducer-1");
    assert.equal(completed.applied, true);
    assert.equal(secondTerminal.applied, false);
    assert.equal(secondTerminal.reason, "terminal_guard");
    assert.equal(task.state, TASK_STATES.COMPLETED);
    assert.equal(journal.assertInvariants(), true);
  } finally {
    journal.close();
    cleanupDb(dbPath);
  }
});
