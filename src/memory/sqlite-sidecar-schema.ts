import fs from "node:fs";
import type { DatabaseSync } from "node:sqlite";

export const SQLITE_MEMORY_SCHEMA_VERSION = 1;

export type SqliteMemoryCounts = {
  sessions: number;
  messages: number;
  facts: number;
  tasks: number;
  summaries: number;
  memoryLinks: number;
};

export type SqliteMemorySchemaState = {
  ftsAvailable: boolean;
  ftsError?: string;
};

export function backupSqliteSidecarFiles(dbPath: string): string[] {
  const stamp = new Date().toISOString().replaceAll(":", "-");
  const created: string[] = [];
  for (const suffix of ["", "-wal", "-shm"]) {
    const source = `${dbPath}${suffix}`;
    try {
      fs.accessSync(source);
    } catch {
      continue;
    }
    const target = `${source}.backup-${stamp}`;
    fs.copyFileSync(source, target);
    created.push(target);
  }
  return created;
}

export function runSqliteImmediateTransaction<T>(db: DatabaseSync, run: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = run();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {}
    throw err;
  }
}

export function ensureSqliteMemorySidecarSchema(params: {
  db: DatabaseSync;
  dbPath: string;
}): SqliteMemorySchemaState {
  const versionRow = params.db
    .prepare("PRAGMA user_version")
    .get() as { user_version?: number } | undefined;
  const currentVersion = versionRow?.user_version ?? 0;
  if (currentVersion > SQLITE_MEMORY_SCHEMA_VERSION) {
    backupSqliteSidecarFiles(params.dbPath);
    throw new Error(
      `sqlite memory sidecar schema ${currentVersion} is newer than supported version ${SQLITE_MEMORY_SCHEMA_VERSION}`,
    );
  }
  if (currentVersion > 0 && currentVersion < SQLITE_MEMORY_SCHEMA_VERSION) {
    backupSqliteSidecarFiles(params.dbPath);
  }

  return runSqliteImmediateTransaction(params.db, () => {
    params.db.exec("PRAGMA foreign_keys = ON");
    params.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        session_id TEXT PRIMARY KEY,
        session_key TEXT,
        agent_id TEXT NOT NULL,
        source_path TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_message_at INTEGER NOT NULL,
        message_count INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      );
    `);
    params.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        text TEXT NOT NULL,
        normalized_text TEXT NOT NULL,
        importance_score REAL NOT NULL,
        source_path TEXT NOT NULL,
        source_start_line INTEGER NOT NULL,
        source_end_line INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        is_low_value INTEGER NOT NULL DEFAULT 0
      );
    `);
    params.db.exec(`
      CREATE TABLE IF NOT EXISTS facts (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        canonical_key TEXT NOT NULL,
        text TEXT NOT NULL,
        normalized_text TEXT NOT NULL,
        tags TEXT,
        importance_score REAL NOT NULL,
        source_path TEXT NOT NULL,
        source_start_line INTEGER NOT NULL,
        source_end_line INTEGER NOT NULL,
        session_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL
      );
    `);
    params.db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        description TEXT NOT NULL,
        normalized_text TEXT NOT NULL,
        status TEXT NOT NULL,
        tags TEXT,
        importance_score REAL NOT NULL,
        source_path TEXT NOT NULL,
        source_start_line INTEGER NOT NULL,
        source_end_line INTEGER NOT NULL,
        session_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL
      );
    `);
    params.db.exec(`
      CREATE TABLE IF NOT EXISTS summaries (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        scope TEXT NOT NULL,
        title TEXT,
        summary TEXT NOT NULL,
        tags TEXT,
        importance_score REAL NOT NULL,
        source_path TEXT NOT NULL,
        source_start_line INTEGER NOT NULL,
        source_end_line INTEGER NOT NULL,
        session_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    params.db.exec(`
      CREATE TABLE IF NOT EXISTS memory_links (
        from_kind TEXT NOT NULL,
        from_id TEXT NOT NULL,
        to_kind TEXT NOT NULL,
        to_id TEXT NOT NULL,
        relation TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);
    params.db.exec(`
      CREATE TABLE IF NOT EXISTS ingest_state (
        source_kind TEXT NOT NULL,
        source_key TEXT NOT NULL,
        byte_offset INTEGER NOT NULL DEFAULT 0,
        source_hash TEXT,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (source_kind, source_key)
      );
    `);
    params.db.exec(`
      CREATE TABLE IF NOT EXISTS sidecar_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);

    params.db.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_session_key ON sessions(session_key) WHERE session_key IS NOT NULL",
    );
    params.db.exec(
      "CREATE INDEX IF NOT EXISTS idx_sessions_last_message_at ON sessions(last_message_at)",
    );
    params.db.exec(
      "CREATE INDEX IF NOT EXISTS idx_messages_session_id_created_at ON messages(session_id, created_at)",
    );
    params.db.exec(
      "CREATE INDEX IF NOT EXISTS idx_messages_importance_score ON messages(importance_score)",
    );
    params.db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_facts_canonical ON facts(agent_id, canonical_key)");
    params.db.exec("CREATE INDEX IF NOT EXISTS idx_facts_last_seen_at ON facts(last_seen_at)");
    params.db.exec(
      "CREATE INDEX IF NOT EXISTS idx_facts_importance_score ON facts(importance_score)",
    );
    params.db.exec("CREATE INDEX IF NOT EXISTS idx_facts_tags ON facts(tags)");
    params.db.exec("CREATE INDEX IF NOT EXISTS idx_tasks_status_updated_at ON tasks(status, updated_at)");
    params.db.exec(
      "CREATE INDEX IF NOT EXISTS idx_tasks_importance_score ON tasks(importance_score)",
    );
    params.db.exec("CREATE INDEX IF NOT EXISTS idx_tasks_tags ON tasks(tags)");
    params.db.exec(
      "CREATE INDEX IF NOT EXISTS idx_summaries_session_id_created_at ON summaries(session_id, created_at)",
    );
    params.db.exec(
      "CREATE INDEX IF NOT EXISTS idx_summaries_importance_score ON summaries(importance_score)",
    );
    params.db.exec("CREATE INDEX IF NOT EXISTS idx_summaries_tags ON summaries(tags)");
    params.db.exec(
      "CREATE INDEX IF NOT EXISTS idx_memory_links_from ON memory_links(from_kind, from_id)",
    );
    params.db.exec(
      "CREATE INDEX IF NOT EXISTS idx_memory_links_to ON memory_links(to_kind, to_id)",
    );

    let ftsAvailable = false;
    let ftsError: string | undefined;
    try {
      params.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
          text,
          tags,
          ref_key UNINDEXED,
          kind UNINDEXED,
          agent_id UNINDEXED,
          session_id UNINDEXED
        );
      `);
      ftsAvailable = true;
    } catch (err) {
      ftsError = err instanceof Error ? err.message : String(err);
    }

    params.db.exec(`PRAGMA user_version = ${SQLITE_MEMORY_SCHEMA_VERSION}`);
    return { ftsAvailable, ...(ftsError ? { ftsError } : {}) };
  });
}

export function readSqliteMemoryCounts(db: DatabaseSync): SqliteMemoryCounts {
  const count = (table: string) =>
    ((db.prepare(`SELECT COUNT(*) as c FROM ${table}`).get() as { c?: number } | undefined)?.c ??
      0);
  return {
    sessions: count("sessions"),
    messages: count("messages"),
    facts: count("facts"),
    tasks: count("tasks"),
    summaries: count("summaries"),
    memoryLinks: count("memory_links"),
  };
}
