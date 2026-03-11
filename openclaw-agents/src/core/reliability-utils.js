import crypto from "node:crypto";

export const TASK_STATES = Object.freeze({
  ACCEPTED: "ACCEPTED",
  QUEUED: "QUEUED",
  DISPATCHING: "DISPATCHING",
  RUNNING: "RUNNING",
  RETRY_WAIT: "RETRY_WAIT",
  COMPLETED: "COMPLETED",
  FAILED: "FAILED",
  DEAD_LETTER: "DEAD_LETTER",
});

export const QUEUE_CLASSES = Object.freeze({
  DIRECT_TASKS: "DIRECT_TASKS",
  LONG_RUNNING_TASKS: "LONG_RUNNING_TASKS",
  RETRY_TASKS: "RETRY_TASKS",
  NOTIFIER_TASKS: "NOTIFIER_TASKS",
});

export const RETRY_CLASSES = Object.freeze({
  SAFE_RETRY: "SAFE_RETRY",
  GUARDED_RETRY: "GUARDED_RETRY",
  MANUAL_RETRY: "MANUAL_RETRY",
});

export const EXECUTION_MODES = Object.freeze({
  DIRECT: "direct",
  SUBAGENT: "subagent",
});

export const RUNTIME_OBSERVED_STATES = Object.freeze({
  RUNNING: "running",
  COMPLETED: "completed",
  MISSING: "missing",
  UNKNOWN: "unknown",
});

const TASK_KEY_OMIT_KEYS = new Set([
  "attempt",
  "child_run_id",
  "child_session_key",
  "correlation_id",
  "idempotency_key",
  "last_heartbeat_at",
  "last_runtime_check_at",
  "lease_expires_at",
  "lease_owner",
  "reconciliation_version",
  "retry_class",
  "runtime_observed_state",
  "task_id",
]);

const TERMINAL_STATES = new Set([
  TASK_STATES.COMPLETED,
  TASK_STATES.FAILED,
  TASK_STATES.DEAD_LETTER,
]);

export function isTerminalState(state) {
  return TERMINAL_STATES.has(String(state || ""));
}

export function normalizeText(value) {
  return String(value || "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function sortObject(value) {
  if (Array.isArray(value)) {
    return value.map((item) => sortObject(item));
  }
  if (!value || typeof value !== "object") {
    return value;
  }

  return Object.keys(value)
    .toSorted()
    .reduce((acc, key) => {
      if (TASK_KEY_OMIT_KEYS.has(key)) {
        return acc;
      }
      acc[key] = sortObject(value[key]);
      return acc;
    }, {});
}

export function stableStringify(value) {
  return JSON.stringify(sortObject(value));
}

export function hashValue(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

export function buildTaskKey(params = {}) {
  return hashValue(
    [
      params.parentRunId || "root",
      normalizeText(params.objective),
      stableStringify(params.input || {}),
      normalizeText(params.agentId),
    ].join("||"),
  );
}

export function buildIdempotencyKey(taskId, attempt) {
  return hashValue(`${taskId}:${Number(attempt || 0)}`);
}

export function buildEventKey(taskId, eventType, attempt) {
  return hashValue(`${taskId}:${eventType}:${Number(attempt || 0)}`);
}

export function createTaskId() {
  return `task:${crypto.randomUUID()}`;
}

export function createRunId() {
  return `run:${crypto.randomUUID()}`;
}

export function createSessionKey(prefix = "session") {
  return `${prefix}:${crypto.randomUUID()}`;
}

export function toJson(value) {
  return JSON.stringify(value ?? null);
}

export function fromJson(value, fallback = null) {
  if (value == null || value === "") {return fallback;}
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export function formatFailure(error) {
  if (!error) {
    return {
      code: "unknown_failure",
      message: "Unknown failure",
      details: null,
    };
  }

  if (typeof error === "string") {
    return {
      code: "runtime_error",
      message: error,
      details: null,
    };
  }

  return {
    code: error.code || "runtime_error",
    message: error.message || String(error),
    details:
      error.details ||
      (error.stack
        ? {
            stack: error.stack,
          }
        : null),
  };
}

export function resolveRetryLimit(maxAttempts = {}, retryClass, fallback = 1) {
  const direct = maxAttempts?.[retryClass];
  if (Number.isFinite(direct) && direct > 0) {
    return Math.max(1, Math.floor(direct));
  }
  return Math.max(1, Math.floor(fallback));
}

export function resolveQueueClass(agentId) {
  const normalized = String(agentId || "").toLowerCase();
  if (normalized === "code" || normalized === "test") {
    return QUEUE_CLASSES.LONG_RUNNING_TASKS;
  }
  return QUEUE_CLASSES.DIRECT_TASKS;
}
