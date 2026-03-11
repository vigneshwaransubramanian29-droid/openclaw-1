import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TaskJournal } from "../src/core/task-journal.js";
import { LifecycleReducer } from "../src/core/lifecycle-reducer.js";
import { QueueManager } from "../src/core/queue-manager.js";
import { HealthTracker } from "../src/core/health-tracker.js";
import { RecoverySweeper } from "../src/core/recovery-sweeper.js";
import {
  QUEUE_CLASSES,
  TASK_STATES,
  buildIdempotencyKey,
} from "../src/core/reliability-utils.js";

function makeTempDbPath(name) {
  return path.join(os.tmpdir(), `openclaw-agents-${name}-${Date.now()}-${Math.random()}.sqlite`);
}

function cleanupDb(filePath) {
  for (const suffix of ["", "-shm", "-wal"]) {
    const current = `${filePath}${suffix}`;
    if (fs.existsSync(current)) {
      try {
        fs.unlinkSync(current);
      } catch (error) {
        if (error?.code !== "EBUSY") {
          throw error;
        }
      }
    }
  }
}

function createHarness(params = {}) {
  let currentTime = params.now ?? 100_000;
  const now = () => currentTime;
  const dbPath = makeTempDbPath(params.name || "recovery");
  const journal = new TaskJournal({ filePath: dbPath, now }).open();
  const reducer = new LifecycleReducer({ journal, now });
  const queueManager = new QueueManager({ now });
  const runtimeAdapter = {
    getFeatureFlags() {
      return { subagents: true, recovery: true };
    },
    async reconcileTask() {
      return params.reconcile();
    },
  };
  const healthTracker = new HealthTracker({ now });
  const sweeper = new RecoverySweeper({
    journal,
    reducer,
    runtimeAdapter,
    healthTracker,
    retryTask: async (task, failure) => {
      reducer.transition({
        taskId: task.task_id,
        eventType: "retry:scheduled",
        nextState: TASK_STATES.RETRY_WAIT,
        failure,
        changes: {
          queue_class: QUEUE_CLASSES.RETRY_TASKS,
          retry_after_at: now(),
        },
      });
      const requeued = reducer.transition({
        taskId: task.task_id,
        eventType: "retry:requeued",
        nextState: TASK_STATES.QUEUED,
        incrementAttempt: true,
        changes: {
          queue_class: QUEUE_CLASSES.RETRY_TASKS,
          retry_after_at: null,
        },
      });
      queueManager.enqueue(task.task_id, QUEUE_CLASSES.RETRY_TASKS, {
        enqueuedAt: now(),
      });
      return requeued.task;
    },
    now,
    leaseMs: 60_000,
    retryGraceMs: 45_000,
    maxAttempts: {
      SAFE_RETRY: 3,
      GUARDED_RETRY: 2,
      MANUAL_RETRY: 1,
    },
  });

  function seedRunningTask({ retryClass = "SAFE_RETRY", attempt = 1, leaseAgeMs = 1_000 }) {
    const taskId = `task-${Math.random()}`;
    journal.reserveTask({
      task_id: taskId,
      task_key: `task-key-${taskId}`,
      agent_id: retryClass === "GUARDED_RETRY" ? "code" : "planner",
      task_payload: { task: "recover me" },
      context: {},
      state: TASK_STATES.RUNNING,
      queue_class:
        retryClass === "GUARDED_RETRY"
          ? QUEUE_CLASSES.LONG_RUNNING_TASKS
          : QUEUE_CLASSES.DIRECT_TASKS,
      retry_class: retryClass,
      execution_mode: "subagent",
      attempt,
      idempotency_key: buildIdempotencyKey(taskId, attempt),
    });
    const seeded = journal.getTaskById(taskId);
    journal.updateTaskCas({
      taskId,
      expectedVersion: seeded.state_version,
      changes: {
        child_run_id: `run-${taskId}`,
        lease_owner: "worker-1",
        lease_expires_at: currentTime - leaseAgeMs,
        last_heartbeat_at: currentTime - leaseAgeMs,
        updated_at: currentTime,
      },
    });
    return journal.getTaskById(taskId);
  }

  return {
    now,
    setNow(value) {
      currentTime = value;
    },
    advance(ms) {
      currentTime += ms;
    },
    dbPath,
    journal,
    queueManager,
    sweeper,
    seedRunningTask,
    cleanup() {
      journal.close();
      cleanupDb(dbPath);
    },
  };
}

test("expired lease plus runtime running renews the lease", async () => {
  const harness = createHarness({
    name: "running",
    reconcile: () => ({
      runtimeObservedState: "running",
      waitResult: { status: "running" },
    }),
  });

  try {
    const task = harness.seedRunningTask({});
    await harness.sweeper.runOnce();
    const updated = harness.journal.getTaskById(task.task_id);
    assert.equal(updated.state, TASK_STATES.RUNNING);
    assert.ok(updated.lease_expires_at > harness.now());
    assert.equal(updated.reconciliation_version, 1);
    assert.equal(updated.runtime_observed_state, "running");
  } finally {
    harness.cleanup();
  }
});

test("expired lease plus runtime completed finalizes the task", async () => {
  const harness = createHarness({
    name: "completed",
    reconcile: () => ({
      runtimeObservedState: "completed",
      waitResult: {
        status: "ok",
        result: {
          status: "success",
          summary: "done",
          citations: [],
          artifacts: [],
          memory_suggestions: [],
          followups: [],
        },
      },
    }),
  });

  try {
    const task = harness.seedRunningTask({});
    await harness.sweeper.runOnce();
    const updated = harness.journal.getTaskById(task.task_id);
    assert.equal(updated.state, TASK_STATES.COMPLETED);
    assert.ok(updated.terminal_at);
    assert.equal(updated.runtime_observed_state, "completed");
  } finally {
    harness.cleanup();
  }
});

test("expired lease plus runtime missing waits for grace, then retries and rotates idempotency", async () => {
  const harness = createHarness({
    name: "retry",
    reconcile: () => ({
      runtimeObservedState: "missing",
      waitResult: { status: "missing" },
    }),
  });

  try {
    const task = harness.seedRunningTask({ retryClass: "SAFE_RETRY", attempt: 1, leaseAgeMs: 1_000 });
    const firstRun = harness.journal.getTaskById(task.task_id);
    await harness.sweeper.runOnce();
    const beforeGrace = harness.journal.getTaskById(task.task_id);
    assert.equal(beforeGrace.state, TASK_STATES.RUNNING);
    assert.equal(beforeGrace.attempt, 1);

    harness.advance(45_001);
    await harness.sweeper.runOnce();
    const retried = harness.journal.getTaskById(task.task_id);
    assert.equal(retried.state, TASK_STATES.QUEUED);
    assert.equal(retried.attempt, 2);
    assert.notEqual(retried.idempotency_key, firstRun.idempotency_key);
    assert.equal(retried.queue_class, QUEUE_CLASSES.RETRY_TASKS);
  } finally {
    harness.cleanup();
  }
});

test("MANUAL_RETRY tasks never auto-retry and go to dead letter after grace", async () => {
  const harness = createHarness({
    name: "manual",
    reconcile: () => ({
      runtimeObservedState: "missing",
      waitResult: { status: "missing" },
    }),
  });

  try {
    const task = harness.seedRunningTask({
      retryClass: "MANUAL_RETRY",
      attempt: 1,
      leaseAgeMs: 50_000,
    });
    await harness.sweeper.runOnce();
    const updated = harness.journal.getTaskById(task.task_id);
    assert.equal(updated.state, TASK_STATES.DEAD_LETTER);
    assert.equal(updated.attempt, 1);
    assert.ok(updated.failure_message.includes("dead letter"));
  } finally {
    harness.cleanup();
  }
});

test("recovery invariants hold across restart and repeated sweeper runs", async () => {
  const harness = createHarness({
    name: "restart",
    reconcile: () => ({
      runtimeObservedState: "missing",
      waitResult: { status: "missing" },
    }),
  });

  try {
    const task = harness.seedRunningTask({ retryClass: "SAFE_RETRY", leaseAgeMs: 50_000 });
    await harness.sweeper.runOnce();
    await harness.sweeper.runOnce();
    const onceRetried = harness.journal.getTaskById(task.task_id);
    assert.equal(onceRetried.attempt, 2);

    harness.journal.close();
    const reopened = new TaskJournal({ filePath: harness.dbPath, now: harness.now }).open();
    assert.equal(reopened.assertInvariants(), true);
    const persisted = reopened.getTaskById(task.task_id);
    assert.equal(persisted.state, TASK_STATES.QUEUED);
    assert.equal(persisted.attempt, 2);
    reopened.close();
  } finally {
    cleanupDb(harness.dbPath);
  }
});
