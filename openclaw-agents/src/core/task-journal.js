import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  TASK_STATES,
  fromJson,
  isTerminalState,
  toJson,
} from "./reliability-utils.js";

function rowToTask(row) {
  if (!row) {return null;}
  return {
    ...row,
    task_payload: fromJson(row.task_payload_json, {}),
    context: fromJson(row.context_json, {}),
    result: fromJson(row.result_json, null),
    failure_details: fromJson(row.failure_details_json, null),
  };
}

function rowToEvent(row) {
  if (!row) {return null;}
  return {
    ...row,
    payload: fromJson(row.payload_json, null),
  };
}

export class TaskJournal {
  constructor(params = {}) {
    this.filePath = params.filePath;
    this.now = params.now || (() => Date.now());
    this.db = null;
  }

  open() {
    if (this.db) {return this;}
    if (!this.filePath) {
      throw new Error("Task journal filePath is required");
    }

    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    this.db = new DatabaseSync(this.filePath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        task_id TEXT PRIMARY KEY,
        task_key TEXT NOT NULL UNIQUE,
        agent_id TEXT NOT NULL,
        parent_run_id TEXT,
        correlation_id TEXT,
        task_payload_json TEXT NOT NULL,
        context_json TEXT NOT NULL,
        state TEXT NOT NULL,
        state_version INTEGER NOT NULL,
        attempt INTEGER NOT NULL,
        queue_class TEXT NOT NULL,
        retry_class TEXT NOT NULL,
        execution_mode TEXT NOT NULL,
        child_run_id TEXT,
        child_session_key TEXT,
        lease_owner TEXT,
        lease_expires_at INTEGER,
        last_heartbeat_at INTEGER,
        runtime_observed_state TEXT,
        last_runtime_check_at INTEGER,
        reconciliation_version INTEGER NOT NULL DEFAULT 0,
        idempotency_key TEXT NOT NULL,
        result_json TEXT,
        terminal_at INTEGER,
        retry_after_at INTEGER,
        failure_code TEXT,
        failure_message TEXT,
        failure_details_json TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS task_events (
        event_key TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        attempt INTEGER NOT NULL,
        payload_json TEXT,
        notifier_last_sent_at INTEGER,
        notifier_send_count INTEGER NOT NULL DEFAULT 0,
        notifier_last_error TEXT,
        notifier_next_attempt_at INTEGER,
        created_at INTEGER NOT NULL
      );
    `);
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS idx_tasks_state_terminal ON tasks(state, terminal_at)",
    );
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS idx_tasks_lease ON tasks(lease_expires_at, terminal_at)",
    );
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS idx_task_events_task_created ON task_events(task_id, created_at)",
    );
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS idx_task_events_notify ON task_events(notifier_next_attempt_at, notifier_last_sent_at)",
    );
    return this;
  }

  close() {
    this.db?.close();
    this.db = null;
  }

  #ensureOpen() {
    if (!this.db) {
      throw new Error("Task journal is not open");
    }
    return this.db;
  }

  transaction(run) {
    const db = this.#ensureOpen();
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = run();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  reserveTask(input = {}) {
    const db = this.#ensureOpen();
    const now = this.now();
    const inserted = db
      .prepare(
        `
          INSERT OR IGNORE INTO tasks (
            task_id,
            task_key,
            agent_id,
            parent_run_id,
            correlation_id,
            task_payload_json,
            context_json,
            state,
            state_version,
            attempt,
            queue_class,
            retry_class,
            execution_mode,
            idempotency_key,
            created_at,
            updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        input.task_id,
        input.task_key,
        input.agent_id,
        input.parent_run_id || null,
        input.correlation_id || null,
        toJson(input.task_payload || {}),
        toJson(input.context || {}),
        input.state || TASK_STATES.ACCEPTED,
        input.state_version ?? 0,
        input.attempt ?? 1,
        input.queue_class,
        input.retry_class,
        input.execution_mode,
        input.idempotency_key,
        now,
        now,
      );

    const task = this.getTaskByKey(input.task_key);
    return {
      created: Boolean(inserted.changes),
      task,
    };
  }

  getTaskById(taskId) {
    const db = this.#ensureOpen();
    return rowToTask(db.prepare("SELECT * FROM tasks WHERE task_id = ?").get(taskId));
  }

  getTaskByKey(taskKey) {
    const db = this.#ensureOpen();
    return rowToTask(db.prepare("SELECT * FROM tasks WHERE task_key = ?").get(taskKey));
  }

  getTasksByState(states = []) {
    const db = this.#ensureOpen();
    if (!Array.isArray(states) || states.length === 0) {return [];}
    const placeholders = states.map(() => "?").join(", ");
    const rows = db
      .prepare(
        `SELECT * FROM tasks WHERE state IN (${placeholders}) AND terminal_at IS NULL ORDER BY created_at ASC`,
      )
      .all(...states);
    return rows.map((row) => rowToTask(row));
  }

  getExpiredLeaseTasks(beforeMs) {
    const db = this.#ensureOpen();
    const rows = db
      .prepare(
        `
          SELECT * FROM tasks
          WHERE state IN (?, ?)
            AND terminal_at IS NULL
            AND lease_expires_at IS NOT NULL
            AND lease_expires_at <= ?
          ORDER BY lease_expires_at ASC
        `,
      )
      .all(TASK_STATES.DISPATCHING, TASK_STATES.RUNNING, beforeMs);
    return rows.map((row) => rowToTask(row));
  }

  listReadyTasks(now = this.now()) {
    const db = this.#ensureOpen();
    const rows = db
      .prepare(
        `
          SELECT * FROM tasks
          WHERE state IN (?, ?, ?)
            AND terminal_at IS NULL
            AND (retry_after_at IS NULL OR retry_after_at <= ?)
          ORDER BY created_at ASC
        `,
      )
      .all(TASK_STATES.ACCEPTED, TASK_STATES.QUEUED, TASK_STATES.RETRY_WAIT, now);
    return rows.map((row) => rowToTask(row));
  }

  updateTaskCas(params = {}) {
    const db = this.#ensureOpen();
    const keys = Object.keys(params.changes || {});
    if (keys.length === 0) {
      return this.getTaskById(params.taskId);
    }

    const assignments = keys.map((key) => `${key} = ?`).join(", ");
    const values = keys.map((key) => params.changes[key]);
    const clauses = ["task_id = ?", "state_version = ?"];
    const clauseValues = [params.taskId, params.expectedVersion];
    if (params.requireOpenTerminal) {
      clauses.push("terminal_at IS NULL");
    }

    const result = db
      .prepare(
        `
          UPDATE tasks
          SET ${assignments}
          WHERE ${clauses.join(" AND ")}
        `,
      )
      .run(...values, ...clauseValues);
    if (!result.changes) {
      return null;
    }
    return this.getTaskById(params.taskId);
  }

  insertEvent(params = {}) {
    const db = this.#ensureOpen();
    const now = this.now();
    const result = db
      .prepare(
        `
          INSERT OR IGNORE INTO task_events (
            event_key,
            task_id,
            event_type,
            attempt,
            payload_json,
            notifier_next_attempt_at,
            created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        params.event_key,
        params.task_id,
        params.event_type,
        params.attempt,
        toJson(params.payload ?? null),
        params.notifier_next_attempt_at ?? now,
        now,
      );

    return {
      inserted: Boolean(result.changes),
      event: this.getEvent(params.event_key),
    };
  }

  getEvent(eventKey) {
    const db = this.#ensureOpen();
    return rowToEvent(db.prepare("SELECT * FROM task_events WHERE event_key = ?").get(eventKey));
  }

  getEventsForTask(taskId) {
    const db = this.#ensureOpen();
    const rows = db
      .prepare("SELECT * FROM task_events WHERE task_id = ? ORDER BY created_at ASC")
      .all(taskId);
    return rows.map((row) => rowToEvent(row));
  }

  getLastSentEventTimestamp(taskId) {
    const db = this.#ensureOpen();
    const row = db
      .prepare(
        `
          SELECT notifier_last_sent_at
          FROM task_events
          WHERE task_id = ?
            AND notifier_last_sent_at IS NOT NULL
          ORDER BY notifier_last_sent_at DESC
          LIMIT 1
        `,
      )
      .get(taskId);
    return row?.notifier_last_sent_at ?? null;
  }

  listPendingNotifierEvents(params = {}) {
    const db = this.#ensureOpen();
    const now = params.now ?? this.now();
    const limit = params.limit ?? 50;
    const rows = db
      .prepare(
        `
          SELECT * FROM task_events
          WHERE notifier_last_sent_at IS NULL
             OR (notifier_next_attempt_at IS NOT NULL AND notifier_next_attempt_at <= ?)
          ORDER BY created_at ASC
          LIMIT ?
        `,
      )
      .all(now, limit);
    return rows.map((row) => rowToEvent(row));
  }

  updateEventNotifier(eventKey, patch = {}) {
    const db = this.#ensureOpen();
    const keys = Object.keys(patch);
    if (keys.length === 0) {
      return this.getEvent(eventKey);
    }
    const assignments = keys.map((key) => `${key} = ?`).join(", ");
    const values = keys.map((key) => patch[key]);
    db.prepare(`UPDATE task_events SET ${assignments} WHERE event_key = ?`).run(...values, eventKey);
    return this.getEvent(eventKey);
  }

  countTasksByState() {
    const db = this.#ensureOpen();
    const rows = db.prepare("SELECT state, COUNT(*) AS count FROM tasks GROUP BY state").all();
    return rows.reduce((acc, row) => {
      acc[row.state] = row.count;
      return acc;
    }, {});
  }

  assertInvariants() {
    const db = this.#ensureOpen();
    const duplicateKeys = db
      .prepare(
        "SELECT task_key, COUNT(*) AS count FROM tasks GROUP BY task_key HAVING COUNT(*) > 1 LIMIT 1",
      )
      .get();
    if (duplicateKeys) {
      throw new Error(`Duplicate task_key detected: ${duplicateKeys.task_key}`);
    }

    const missingTerminal = db
      .prepare(
        `
          SELECT task_id
          FROM tasks
          WHERE state IN (?, ?, ?)
            AND terminal_at IS NULL
          LIMIT 1
        `,
      )
      .get(TASK_STATES.COMPLETED, TASK_STATES.FAILED, TASK_STATES.DEAD_LETTER);
    if (missingTerminal) {
      throw new Error(`Terminal task missing terminal_at: ${missingTerminal.task_id}`);
    }

    const duplicateCompletion = db
      .prepare(
        `
          SELECT task_id, COUNT(*) AS count
          FROM task_events
          WHERE event_type LIKE 'terminal:%'
          GROUP BY task_id
          HAVING COUNT(*) > 1
          LIMIT 1
        `,
      )
      .get();
    if (duplicateCompletion) {
      throw new Error(`Duplicate completion events for task ${duplicateCompletion.task_id}`);
    }

    const badAttempt = db
      .prepare(
        `
          SELECT task_id
          FROM tasks
          WHERE attempt < 1
          LIMIT 1
        `,
      )
      .get();
    if (badAttempt) {
      throw new Error(`Invalid attempt count for task ${badAttempt.task_id}`);
    }

    return true;
  }

  isTerminalTask(taskId) {
    const task = this.getTaskById(taskId);
    return isTerminalState(task?.state);
  }
}
