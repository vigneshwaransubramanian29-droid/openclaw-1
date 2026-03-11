import {
  buildEventKey,
  buildIdempotencyKey,
  toJson,
} from "./reliability-utils.js";

export class LifecycleReducer {
  constructor(params = {}) {
    this.journal = params.journal;
    this.now = params.now || (() => Date.now());
  }

  transition(params = {}) {
    return this.journal.transaction(() => {
      const task = this.journal.getTaskById(params.taskId);
      if (!task) {
        throw new Error(`Unknown task: ${params.taskId}`);
      }

      const nextAttempt = params.incrementAttempt ? task.attempt + 1 : (params.attempt ?? task.attempt);
      const eventAttempt = params.eventAttempt ?? nextAttempt;
      const eventKey = params.eventKey || buildEventKey(task.task_id, params.eventType, eventAttempt);
      const existingEvent = this.journal.getEvent(eventKey);
      if (existingEvent) {
        return {
          applied: false,
          reason: "duplicate_event",
          task,
          event: existingEvent,
        };
      }

      if (params.setTerminal && task.terminal_at) {
        return {
          applied: false,
          reason: "terminal_guard",
          task,
          event: null,
        };
      }

      const now = this.now();
      const changes = {
        ...(params.nextState ? { state: params.nextState } : {}),
        ...params.changes,
        state_version: task.state_version + 1,
        updated_at: now,
      };

      if (params.incrementAttempt) {
        changes.attempt = nextAttempt;
        changes.idempotency_key = buildIdempotencyKey(task.task_id, nextAttempt);
      }

      if (params.result !== undefined) {
        changes.result_json = toJson(params.result);
      }

      if (params.failure) {
        changes.failure_code = params.failure.code || "runtime_error";
        changes.failure_message = params.failure.message || "Task failed";
        changes.failure_details_json = toJson(params.failure.details ?? null);
      }

      if (params.clearFailure) {
        changes.failure_code = null;
        changes.failure_message = null;
        changes.failure_details_json = null;
      }

      if (params.reconciled || params.runtimeObservedState) {
        changes.runtime_observed_state = params.runtimeObservedState || task.runtime_observed_state;
        changes.last_runtime_check_at = now;
        changes.reconciliation_version = (task.reconciliation_version || 0) + 1;
      }

      if (params.setTerminal) {
        changes.terminal_at = now;
      }

      const payload = {
        from_state: task.state,
        to_state: changes.state || task.state,
        task_id: task.task_id,
        attempt: eventAttempt,
        ...params.payload,
      };

      const inserted = this.journal.insertEvent({
        event_key: eventKey,
        task_id: task.task_id,
        event_type: params.eventType,
        attempt: eventAttempt,
        payload,
        notifier_next_attempt_at: params.notifierNextAttemptAt,
      });
      if (!inserted.inserted) {
        return {
          applied: false,
          reason: "duplicate_event",
          task,
          event: inserted.event,
        };
      }

      const updated = this.journal.updateTaskCas({
        taskId: task.task_id,
        expectedVersion: task.state_version,
        changes,
        requireOpenTerminal: params.setTerminal,
      });
      if (!updated) {
        throw new Error(`CAS conflict for task ${task.task_id}`);
      }

      return {
        applied: true,
        reason: "updated",
        task: updated,
        event: inserted.event,
      };
    });
  }
}
