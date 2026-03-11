import {
  TASK_STATES,
  formatFailure,
  isTerminalState,
  resolveRetryLimit,
} from "./reliability-utils.js";

export class RecoverySweeper {
  constructor(params = {}) {
    this.journal = params.journal;
    this.reducer = params.reducer;
    this.runtimeAdapter = params.runtimeAdapter;
    this.healthTracker = params.healthTracker;
    this.retryTask = params.retryTask;
    this.now = params.now || (() => Date.now());
    this.leaseMs = params.leaseMs || 60_000;
    this.retryGraceMs = params.retryGraceMs || 45_000;
    this.maxAttempts = params.maxAttempts || {};
    this.intervalMs = params.intervalMs || 30_000;
    this.timer = null;
  }

  start() {
    if (this.timer) {return;}
    this.timer = setInterval(() => {
      void this.runOnce();
    }, this.intervalMs);
    this.timer.unref?.();
  }

  stop() {
    if (!this.timer) {return;}
    clearInterval(this.timer);
    this.timer = null;
  }

  async runOnce() {
    const expired = this.journal.getExpiredLeaseTasks(this.now());
    for (const task of expired) {
      if (!task || isTerminalState(task.state)) {continue;}
      try {
        await this.#reconcileExpiredTask(task);
      } catch (error) {
        this.healthTracker?.reportAdapterFailure(error);
      }
    }
  }

  async #reconcileExpiredTask(task) {
    const now = this.now();
    const reconciliation = await this.runtimeAdapter.reconcileTask(task);
    const observed = reconciliation.runtimeObservedState;

    if (observed === "running") {
      this.reducer.transition({
        taskId: task.task_id,
        eventType: `reconcile:running:${(task.reconciliation_version || 0) + 1}`,
        nextState: TASK_STATES.RUNNING,
        changes: {
          lease_owner: task.lease_owner,
          lease_expires_at: now + this.leaseMs,
          last_heartbeat_at: now,
        },
        runtimeObservedState: observed,
        reconciled: true,
      });
      return;
    }

    if (observed === "completed") {
      const waited = reconciliation.waitResult || {};
      const rawResult = waited.result || task.result;
      const success = waited.status === "ok" && rawResult?.status !== "failed";
      this.reducer.transition({
        taskId: task.task_id,
        eventType: success ? "terminal:completed" : "terminal:failed",
        nextState: success ? TASK_STATES.COMPLETED : TASK_STATES.FAILED,
        result: rawResult || null,
        failure: success ? null : formatFailure(waited.error || rawResult?.summary || "Task failed"),
        runtimeObservedState: observed,
        reconciled: true,
        setTerminal: true,
        clearFailure: success,
      });
      return;
    }

    this.reducer.transition({
      taskId: task.task_id,
      eventType: `reconcile:${observed}:${(task.reconciliation_version || 0) + 1}`,
      changes: {},
      runtimeObservedState: observed,
      reconciled: true,
    });

    const graceDeadline = (task.lease_expires_at || now) + this.retryGraceMs;
    if (now < graceDeadline) {
      return;
    }

    const maxAttempts = resolveRetryLimit(this.maxAttempts, task.retry_class, 1);
    const canRetry =
      task.retry_class !== "MANUAL_RETRY" &&
      task.attempt < maxAttempts &&
      (observed === "missing" || observed === "unknown");

    if (canRetry) {
      await this.retryTask(task, {
        code: "runtime_reconciliation_retry",
        message: `Recovered expired lease after runtime reported ${observed}`,
        details: {
          observed,
          waited: reconciliation.waitResult || null,
        },
      });
      return;
    }

    this.reducer.transition({
      taskId: task.task_id,
      eventType: "terminal:dead_letter",
      nextState: TASK_STATES.DEAD_LETTER,
      failure: {
        code: "runtime_reconciliation_dead_letter",
        message: `Task moved to dead letter after runtime reported ${observed}`,
        details: {
          observed,
          attempt: task.attempt,
          retry_class: task.retry_class,
        },
      },
      runtimeObservedState: observed,
      reconciled: true,
      setTerminal: true,
    });
  }
}
