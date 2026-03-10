import fs from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { ResolvedSqliteMemoryConfig } from "../agents/memory-search.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { hashText, listMemoryFiles } from "./internal.js";
import {
  listSessionFilesForAgent,
  loadSessionKeyMapForAgent,
  parseSessionTranscript,
  sessionPathForFile,
  type ParsedSessionMessage,
} from "./session-files.js";
import {
  readSqliteMemoryCounts,
  runSqliteImmediateTransaction,
  type SqliteMemoryCounts,
} from "./sqlite-sidecar-schema.js";

const log = createSubsystemLogger("memory");

const LOW_VALUE_ACKS = new Set([
  "ok",
  "okay",
  "thanks",
  "thank you",
  "got it",
  "noted",
  "cool",
  "sure",
  "yep",
]);

type MarkdownStructuredEntry =
  | {
      kind: "fact";
      text: string;
      normalizedText: string;
      canonicalKey: string;
      tags: string[];
      importanceScore: number;
      startLine: number;
      endLine: number;
    }
  | {
      kind: "task";
      description: string;
      normalizedText: string;
      status: "open" | "done";
      tags: string[];
      importanceScore: number;
      startLine: number;
      endLine: number;
    }
  | {
      kind: "summary";
      title?: string;
      summary: string;
      tags: string[];
      importanceScore: number;
      startLine: number;
      endLine: number;
    };

export type SqliteSidecarSyncResult = {
  changed: boolean;
  counts: SqliteMemoryCounts;
};

function normalizeMessageText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function normalizeLookupText(value: string): string {
  return normalizeMessageText(value).toLowerCase();
}

function normalizeCanonicalText(value: string): string {
  return normalizeLookupText(value).replace(/[^\p{L}\p{N}\s]/gu, "");
}

function isPureEmoji(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) {
    return false;
  }
  return /^[\p{Extended_Pictographic}\p{Emoji_Component}\s]+$/u.test(trimmed);
}

function isLowValueAcknowledgement(normalized: string): boolean {
  return LOW_VALUE_ACKS.has(normalized);
}

function shouldStoreSessionMessage(message: ParsedSessionMessage): boolean {
  const normalized = normalizeLookupText(message.text);
  if (!normalized) {
    return false;
  }
  if (normalized.startsWith("/")) {
    return false;
  }
  if (normalized === "no_reply" || normalized === "no reply") {
    return false;
  }
  if (normalized === "heartbeat_ok" || normalized === "heartbeat ok") {
    return false;
  }
  if (isPureEmoji(normalized)) {
    return false;
  }
  if (isLowValueAcknowledgement(normalized)) {
    return false;
  }
  if (message.role === "assistant" && message.model?.trim().toLowerCase() === "delivery-mirror") {
    return false;
  }
  return true;
}

function scoreImportance(params: {
  text: string;
  tags?: string[];
  role?: "user" | "assistant";
  status?: "open" | "done";
  kind: "message" | "fact" | "task" | "summary";
}): number {
  const normalized = normalizeLookupText(params.text);
  let score = params.kind === "summary" ? 0.4 : 0.5;
  if (params.kind === "task" && params.status === "open") {
    score += 0.2;
  }
  if (params.role === "user") {
    score += 0.05;
  }
  if (params.text.includes("?")) {
    score += 0.08;
  }
  if (/\b(remember|important|prefer|preference|deadline|todo|task|decision|always|never)\b/i.test(normalized)) {
    score += 0.15;
  }
  if (params.tags?.some((tag) => ["decision", "preferences", "tasks", "todo"].includes(tag))) {
    score += 0.1;
  }
  return Math.max(0.05, Math.min(1, score));
}

function extractHeadingTags(headings: string[]): string[] {
  const tags = headings
    .map((heading) => heading.trim().toLowerCase())
    .filter(Boolean)
    .map((heading) => heading.replace(/[^\p{L}\p{N}\s-]/gu, "").replace(/\s+/g, "-"));
  return Array.from(new Set(tags));
}

function parseMarkdownStructuredEntries(content: string): MarkdownStructuredEntry[] {
  const lines = content.split("\n");
  const headings: string[] = [];
  const entries: MarkdownStructuredEntry[] = [];
  let paragraphLines: string[] = [];
  let paragraphStart = 0;

  const flushParagraph = (lineNo: number) => {
    if (paragraphLines.length === 0) {
      return;
    }
    const text = normalizeMessageText(paragraphLines.join(" "));
    const startLine = paragraphStart;
    const endLine = Math.max(startLine, lineNo - 1);
    paragraphLines = [];
    paragraphStart = 0;
    if (!text) {
      return;
    }
    const tags = extractHeadingTags(headings);
    if (text.length > 220 || /\.\s+/.test(text)) {
      entries.push({
        kind: "summary",
        title: headings.at(-1),
        summary: text,
        tags,
        importanceScore: scoreImportance({ text, tags, kind: "summary" }),
        startLine,
        endLine,
      });
      return;
    }
    entries.push({
      kind: "fact",
      text,
      normalizedText: normalizeLookupText(text),
      canonicalKey: normalizeCanonicalText(text),
      tags,
      importanceScore: scoreImportance({ text, tags, kind: "fact" }),
      startLine,
      endLine,
    });
  };

  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index] ?? "";
    const lineNo = index + 1;
    const trimmed = rawLine.trim();
    const headingMatch = /^(#{1,6})\s+(.+)$/.exec(trimmed);
    if (headingMatch) {
      flushParagraph(lineNo);
      const depth = headingMatch[1]?.length ?? 1;
      headings.length = Math.max(0, depth - 1);
      headings[depth - 1] = headingMatch[2]?.trim() ?? "";
      continue;
    }
    const taskMatch = /^[-*]\s+\[( |x|X)\]\s+(.+)$/.exec(trimmed);
    if (taskMatch) {
      flushParagraph(lineNo);
      const description = normalizeMessageText(taskMatch[2] ?? "");
      if (!description) {
        continue;
      }
      const tags = extractHeadingTags(headings);
      entries.push({
        kind: "task",
        description,
        normalizedText: normalizeLookupText(description),
        status: taskMatch[1]?.trim().toLowerCase() === "x" ? "done" : "open",
        tags,
        importanceScore: scoreImportance({
          text: description,
          tags,
          status: taskMatch[1]?.trim().toLowerCase() === "x" ? "done" : "open",
          kind: "task",
        }),
        startLine: lineNo,
        endLine: lineNo,
      });
      continue;
    }
    const bulletMatch = /^[-*]\s+(.+)$/.exec(trimmed);
    if (bulletMatch) {
      flushParagraph(lineNo);
      const text = normalizeMessageText(bulletMatch[1] ?? "");
      if (!text) {
        continue;
      }
      const tags = extractHeadingTags(headings);
      entries.push({
        kind: "fact",
        text,
        normalizedText: normalizeLookupText(text),
        canonicalKey: normalizeCanonicalText(text),
        tags,
        importanceScore: scoreImportance({ text, tags, kind: "fact" }),
        startLine: lineNo,
        endLine: lineNo,
      });
      continue;
    }
    if (!trimmed) {
      flushParagraph(lineNo);
      continue;
    }
    if (paragraphLines.length === 0) {
      paragraphStart = lineNo;
    }
    paragraphLines.push(trimmed);
  }

  flushParagraph(lines.length + 1);
  return entries;
}

function replaceFtsRow(
  db: DatabaseSync,
  params: {
    refKey: string;
    kind: "message" | "fact" | "task" | "summary";
    agentId: string;
    sessionId?: string;
    text: string;
    tags?: string;
  },
  ftsAvailable: boolean,
): void {
  if (!ftsAvailable) {
    return;
  }
  db.prepare("DELETE FROM memory_fts WHERE ref_key = ?").run(params.refKey);
  db.prepare(
    "INSERT INTO memory_fts (text, tags, ref_key, kind, agent_id, session_id) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(
    params.text,
    params.tags ?? "",
    params.refKey,
    params.kind,
    params.agentId,
    params.sessionId ?? null,
  );
}

function deleteSourceRows(db: DatabaseSync, sourcePath: string, ftsAvailable: boolean): void {
  const collectRefKeys = (table: "messages" | "facts" | "tasks" | "summaries", kind: string) =>
    (db
      .prepare(`SELECT id FROM ${table} WHERE source_path = ?`)
      .all(sourcePath) as Array<{ id: string }>).map((row) => `${kind}:${row.id}`);
  if (ftsAvailable) {
    for (const refKey of [
      ...collectRefKeys("messages", "message"),
      ...collectRefKeys("facts", "fact"),
      ...collectRefKeys("tasks", "task"),
      ...collectRefKeys("summaries", "summary"),
    ]) {
      db.prepare("DELETE FROM memory_fts WHERE ref_key = ?").run(refKey);
    }
  }
  db.prepare("DELETE FROM messages WHERE source_path = ?").run(sourcePath);
  db.prepare("DELETE FROM facts WHERE source_path = ?").run(sourcePath);
  db.prepare("DELETE FROM tasks WHERE source_path = ?").run(sourcePath);
  db.prepare("DELETE FROM summaries WHERE source_path = ?").run(sourcePath);
}

function updateIngestState(
  db: DatabaseSync,
  params: { sourceKind: string; sourceKey: string; byteOffset: number; sourceHash?: string },
): void {
  db.prepare(
    `
      INSERT INTO ingest_state (source_kind, source_key, byte_offset, source_hash, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(source_kind, source_key) DO UPDATE SET
        byte_offset=excluded.byte_offset,
        source_hash=excluded.source_hash,
        updated_at=excluded.updated_at
    `,
  ).run(
    params.sourceKind,
    params.sourceKey,
    params.byteOffset,
    params.sourceHash ?? null,
    Date.now(),
  );
}

function buildSummaryText(
  messages: Array<{
    role: string;
    text: string;
    createdAt: number;
    sourceStartLine: number;
    sourceEndLine: number;
    id: string;
  }>,
  maxChars: number,
): string {
  const selected = [...messages.slice(0, 4), ...messages.slice(Math.max(messages.length - 4, 4))]
    .filter((entry, index, array) => array.findIndex((candidate) => candidate.id === entry.id) === index)
    .map((entry) => `${entry.role === "user" ? "User" : "Assistant"}: ${entry.text}`);
  const summary = normalizeMessageText(selected.join(" "));
  if (summary.length <= maxChars) {
    return summary;
  }
  return summary.slice(0, Math.max(0, maxChars - 3)).trimEnd() + "...";
}

function pruneSessionMessages(
  db: DatabaseSync,
  params: {
    agentId: string;
    sessionId: string;
    sourcePath: string;
    retention: ResolvedSqliteMemoryConfig["retention"];
    ftsAvailable: boolean;
  },
): boolean {
  const cutoff = Date.now() - params.retention.messageDays * 24 * 60 * 60 * 1000;
  const rows = db.prepare(
    `
      SELECT id, role, text, created_at as createdAt, source_start_line as sourceStartLine,
             source_end_line as sourceEndLine
      FROM messages
      WHERE session_id = ?
      ORDER BY created_at ASC, source_start_line ASC
    `,
  ).all(params.sessionId) as Array<{
    id: string;
    role: string;
    text: string;
    createdAt: number;
    sourceStartLine: number;
    sourceEndLine: number;
  }>;
  if (rows.length === 0) {
    return false;
  }

  const staleRows = rows.filter((row) => row.createdAt < cutoff);
  const overflow = Math.max(0, rows.length - params.retention.maxMessagesPerSession);
  const prunedByCount = overflow > 0 ? rows.slice(0, overflow) : [];
  const pruneIds = new Set([...staleRows, ...prunedByCount].map((row) => row.id));
  if (pruneIds.size === 0) {
    return false;
  }
  const pruned = rows.filter((row) => pruneIds.has(row.id));
  const summaryText = buildSummaryText(pruned, params.retention.summaryMaxChars);
  if (summaryText) {
    const first = pruned[0];
    const last = pruned[pruned.length - 1];
    if (first && last) {
      const summaryId = hashText(
        `${params.sessionId}:${first.id}:${last.id}:${first.sourceStartLine}:${last.sourceEndLine}`,
      );
      db.prepare("DELETE FROM summaries WHERE id = ?").run(summaryId);
      db.prepare(
        `
          INSERT INTO summaries (
            id, agent_id, scope, title, summary, tags, importance_score, source_path,
            source_start_line, source_end_line, session_id, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      ).run(
        summaryId,
        params.agentId,
        "session-prune",
        "Session summary",
        summaryText,
        "session,summary",
        scoreImportance({ text: summaryText, kind: "summary", tags: ["session", "summary"] }),
        params.sourcePath,
        first.sourceStartLine,
        last.sourceEndLine,
        params.sessionId,
        Date.now(),
        Date.now(),
      );
      replaceFtsRow(
        db,
        {
          refKey: `summary:${summaryId}`,
          kind: "summary",
          agentId: params.agentId,
          sessionId: params.sessionId,
          text: summaryText,
          tags: "session,summary",
        },
        params.ftsAvailable,
      );
      db.prepare("DELETE FROM memory_links WHERE from_kind = 'summary' AND from_id = ?").run(summaryId);
      db.prepare(
        `
          INSERT INTO memory_links (from_kind, from_id, to_kind, to_id, relation, created_at)
          VALUES ('summary', ?, 'session', ?, 'summarizes', ?)
        `,
      ).run(summaryId, params.sessionId, Date.now());
    }
  }

  for (const row of pruned) {
    if (params.ftsAvailable) {
      db.prepare("DELETE FROM memory_fts WHERE ref_key = ?").run(`message:${row.id}`);
    }
    db.prepare("DELETE FROM messages WHERE id = ?").run(row.id);
  }
  const updatedCount = (
    db.prepare("SELECT COUNT(*) as c FROM messages WHERE session_id = ?").get(params.sessionId) as
      | { c?: number }
      | undefined
  )?.c ?? 0;
  const lastMessageAt = (
    db.prepare("SELECT MAX(created_at) as maxCreatedAt FROM messages WHERE session_id = ?").get(
      params.sessionId,
    ) as { maxCreatedAt?: number | null } | undefined
  )?.maxCreatedAt;
  db.prepare(
    "UPDATE sessions SET message_count = ?, last_message_at = ?, updated_at = ? WHERE session_id = ?",
  ).run(updatedCount, lastMessageAt ?? Date.now(), Date.now(), params.sessionId);
  return true;
}

async function syncMemoryFiles(params: {
  db: DatabaseSync;
  agentId: string;
  workspaceDir: string;
  extraPaths: string[];
  force?: boolean;
  ftsAvailable: boolean;
}): Promise<boolean> {
  const files = await listMemoryFiles(params.workspaceDir, params.extraPaths);
  const currentRelPaths = new Set(files.map((absPath) => path.relative(params.workspaceDir, absPath).replace(/\\/g, "/")));
  let changed = false;

  runSqliteImmediateTransaction(params.db, () => {
    const existing = params.db
      .prepare(
        "SELECT DISTINCT source_path FROM facts UNION SELECT DISTINCT source_path FROM tasks UNION SELECT DISTINCT source_path FROM summaries",
      )
      .all() as Array<{ source_path: string }>;
    for (const row of existing) {
      const sourcePath = row.source_path;
      if (sourcePath.startsWith("sessions/")) {
        continue;
      }
      if (currentRelPaths.has(sourcePath)) {
        continue;
      }
      deleteSourceRows(params.db, sourcePath, params.ftsAvailable);
      params.db.prepare(
        "DELETE FROM ingest_state WHERE source_kind = 'memory_file' AND source_key = ?",
      ).run(sourcePath);
      changed = true;
    }
  });

  for (const absPath of files) {
    const relPath = path.relative(params.workspaceDir, absPath).replace(/\\/g, "/");
    const content = await fs.readFile(absPath, "utf-8");
    const sourceHash = hashText(content);
    const state = params.db
      .prepare(
        "SELECT source_hash as sourceHash FROM ingest_state WHERE source_kind = 'memory_file' AND source_key = ?",
      )
      .get(relPath) as { sourceHash?: string | null } | undefined;
    if (!params.force && state?.sourceHash === sourceHash) {
      continue;
    }
    const parsed = parseMarkdownStructuredEntries(content);
    runSqliteImmediateTransaction(params.db, () => {
      deleteSourceRows(params.db, relPath, params.ftsAvailable);
      for (const entry of parsed) {
        if (entry.kind === "fact") {
          if (!entry.canonicalKey) {
            continue;
          }
          const id = hashText(`${params.agentId}:${relPath}:${entry.startLine}:${entry.canonicalKey}`);
          params.db.prepare(
            `
              INSERT INTO facts (
                id, agent_id, canonical_key, text, normalized_text, tags, importance_score,
                source_path, source_start_line, source_end_line, session_id, created_at, updated_at, last_seen_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(agent_id, canonical_key) DO UPDATE SET
                id=excluded.id,
                text=excluded.text,
                normalized_text=excluded.normalized_text,
                tags=excluded.tags,
                importance_score=excluded.importance_score,
                source_path=excluded.source_path,
                source_start_line=excluded.source_start_line,
                source_end_line=excluded.source_end_line,
                updated_at=excluded.updated_at,
                last_seen_at=excluded.last_seen_at
            `,
          ).run(
            id,
            params.agentId,
            entry.canonicalKey,
            entry.text,
            entry.normalizedText,
            entry.tags.join(","),
            entry.importanceScore,
            relPath,
            entry.startLine,
            entry.endLine,
            null,
            Date.now(),
            Date.now(),
            Date.now(),
          );
          replaceFtsRow(
            params.db,
            {
              refKey: `fact:${id}`,
              kind: "fact",
              agentId: params.agentId,
              text: entry.text,
              tags: entry.tags.join(" "),
            },
            params.ftsAvailable,
          );
          changed = true;
          continue;
        }
        if (entry.kind === "task") {
          const id = hashText(`${params.agentId}:${relPath}:${entry.startLine}:${entry.normalizedText}:${entry.status}`);
          if (entry.status === "open") {
            params.db.prepare(
              "DELETE FROM tasks WHERE agent_id = ? AND normalized_text = ? AND status = 'open'",
            ).run(params.agentId, entry.normalizedText);
          }
          params.db.prepare(
            `
              INSERT INTO tasks (
                id, agent_id, description, normalized_text, status, tags, importance_score,
                source_path, source_start_line, source_end_line, session_id, created_at, updated_at, last_seen_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `,
          ).run(
            id,
            params.agentId,
            entry.description,
            entry.normalizedText,
            entry.status,
            entry.tags.join(","),
            entry.importanceScore,
            relPath,
            entry.startLine,
            entry.endLine,
            null,
            Date.now(),
            Date.now(),
            Date.now(),
          );
          replaceFtsRow(
            params.db,
            {
              refKey: `task:${id}`,
              kind: "task",
              agentId: params.agentId,
              text: entry.description,
              tags: entry.tags.join(" "),
            },
            params.ftsAvailable,
          );
          changed = true;
          continue;
        }
        const id = hashText(`${params.agentId}:${relPath}:${entry.startLine}:${entry.summary}`);
        params.db.prepare(
          `
            INSERT INTO summaries (
              id, agent_id, scope, title, summary, tags, importance_score,
              source_path, source_start_line, source_end_line, session_id, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
        ).run(
          id,
          params.agentId,
          "memory-file",
          entry.title ?? null,
          entry.summary,
          entry.tags.join(","),
          entry.importanceScore,
          relPath,
          entry.startLine,
          entry.endLine,
          null,
          Date.now(),
          Date.now(),
        );
        replaceFtsRow(
          params.db,
          {
            refKey: `summary:${id}`,
            kind: "summary",
            agentId: params.agentId,
            text: entry.summary,
            tags: entry.tags.join(" "),
          },
          params.ftsAvailable,
        );
        changed = true;
      }
      updateIngestState(params.db, {
        sourceKind: "memory_file",
        sourceKey: relPath,
        byteOffset: content.length,
        sourceHash,
      });
    });
  }

  return changed;
}

async function syncSessionFiles(params: {
  db: DatabaseSync;
  agentId: string;
  force?: boolean;
  ftsAvailable: boolean;
  retention: ResolvedSqliteMemoryConfig["retention"];
}): Promise<boolean> {
  const sessionFiles = await listSessionFilesForAgent(params.agentId);
  const sessionKeyMap = await loadSessionKeyMapForAgent(params.agentId);
  const currentSessionPaths = new Set(sessionFiles.map((absPath) => sessionPathForFile(absPath)));
  let changed = false;

  runSqliteImmediateTransaction(params.db, () => {
    const existing = params.db
      .prepare("SELECT source_path FROM sessions")
      .all() as Array<{ source_path: string }>;
    for (const row of existing) {
      if (currentSessionPaths.has(row.source_path)) {
        continue;
      }
      const sessionIds = (
        params.db.prepare("SELECT session_id FROM sessions WHERE source_path = ?").all(row.source_path) as Array<{
          session_id: string;
        }>
      ).map((entry) => entry.session_id);
      deleteSourceRows(params.db, row.source_path, params.ftsAvailable);
      params.db.prepare("DELETE FROM summaries WHERE source_path = ?").run(row.source_path);
      for (const sessionId of sessionIds) {
        params.db.prepare("DELETE FROM memory_links WHERE to_kind = 'session' AND to_id = ?").run(sessionId);
        params.db.prepare("DELETE FROM sessions WHERE session_id = ?").run(sessionId);
      }
      params.db.prepare(
        "DELETE FROM ingest_state WHERE source_kind = 'session_transcript' AND source_key = ?",
      ).run(row.source_path);
      changed = true;
    }
  });

  for (const absPath of sessionFiles) {
    const relPath = sessionPathForFile(absPath);
    const buffer = await fs.readFile(absPath);
    const sourceState = params.db
      .prepare(
        `
          SELECT byte_offset as byteOffset
          FROM ingest_state
          WHERE source_kind = 'session_transcript' AND source_key = ?
        `,
      )
      .get(relPath) as { byteOffset?: number } | undefined;
    const byteOffset = params.force ? 0 : Math.max(0, sourceState?.byteOffset ?? 0);
    const fullReingest = params.force || byteOffset <= 0 || byteOffset > buffer.byteLength;
    const baseLine = fullReingest
      ? 0
      : buffer
          .subarray(0, Math.min(byteOffset, buffer.byteLength))
          .toString("utf8")
          .split("\n").length - 1;
    const text = fullReingest ? buffer.toString("utf8") : buffer.subarray(byteOffset).toString("utf8");
    const parsed = parseSessionTranscript(text);
    const sessionId = parsed.sessionId ?? path.basename(absPath, ".jsonl");
    const sessionKey = sessionKeyMap.get(path.resolve(absPath)) ?? null;
    const sourceMessages = parsed.messages.map((message) => ({
      ...message,
      sourceLine: message.sourceLine + baseLine,
    }));
    const stat = await fs.stat(absPath);

    runSqliteImmediateTransaction(params.db, () => {
      if (fullReingest) {
        deleteSourceRows(params.db, relPath, params.ftsAvailable);
        params.db.prepare("DELETE FROM memory_links WHERE to_kind = 'session' AND to_id = ?").run(sessionId);
        params.db.prepare("DELETE FROM sessions WHERE session_id = ?").run(sessionId);
      }
      params.db.prepare(
        `
          INSERT INTO sessions (
            session_id, session_key, agent_id, source_path, created_at, last_message_at, message_count, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(session_id) DO UPDATE SET
            session_key=excluded.session_key,
            source_path=excluded.source_path,
            last_message_at=excluded.last_message_at,
            updated_at=excluded.updated_at
        `,
      ).run(
        sessionId,
        sessionKey,
        params.agentId,
        relPath,
        Date.now(),
        stat.mtimeMs,
        0,
        Date.now(),
      );
      for (const message of sourceMessages) {
        if (!shouldStoreSessionMessage(message)) {
          continue;
        }
        const normalizedText = normalizeLookupText(message.text);
        const id = hashText(`${sessionId}:${message.sourceLine}:${message.role}:${normalizedText}`);
        const createdAt = Math.floor(message.timestamp ?? stat.mtimeMs);
        params.db.prepare(
          `
            INSERT OR REPLACE INTO messages (
              id, session_id, role, text, normalized_text, importance_score,
              source_path, source_start_line, source_end_line, created_at, updated_at, is_low_value
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
          `,
        ).run(
          id,
          sessionId,
          message.role,
          normalizeMessageText(message.text),
          normalizedText,
          scoreImportance({ text: message.text, role: message.role, kind: "message" }),
          relPath,
          message.sourceLine,
          message.sourceLine,
          createdAt,
          Date.now(),
        );
        replaceFtsRow(
          params.db,
          {
            refKey: `message:${id}`,
            kind: "message",
            agentId: params.agentId,
            sessionId,
            text: message.text,
            tags: `${message.role} session`,
          },
          params.ftsAvailable,
        );
        changed = true;
      }
      const messageCount = (
        params.db.prepare("SELECT COUNT(*) as c FROM messages WHERE session_id = ?").get(sessionId) as
          | { c?: number }
          | undefined
      )?.c ?? 0;
      const lastMessageAt = (
        params.db.prepare("SELECT MAX(created_at) as maxCreatedAt FROM messages WHERE session_id = ?").get(
          sessionId,
        ) as { maxCreatedAt?: number | null } | undefined
      )?.maxCreatedAt;
      params.db.prepare(
        "UPDATE sessions SET message_count = ?, last_message_at = ?, updated_at = ? WHERE session_id = ?",
      ).run(messageCount, lastMessageAt ?? stat.mtimeMs, Date.now(), sessionId);
      updateIngestState(params.db, {
        sourceKind: "session_transcript",
        sourceKey: relPath,
        byteOffset: buffer.byteLength,
        sourceHash: String(stat.mtimeMs),
      });
      if (
        pruneSessionMessages(params.db, {
          agentId: params.agentId,
          sessionId,
          sourcePath: relPath,
          retention: params.retention,
          ftsAvailable: params.ftsAvailable,
        })
      ) {
        changed = true;
      }
    });
  }

  return changed;
}

export async function syncSqliteSidecarSources(params: {
  db: DatabaseSync;
  agentId: string;
  workspaceDir: string;
  extraPaths: string[];
  sqliteMemory: ResolvedSqliteMemoryConfig;
  ftsAvailable: boolean;
  force?: boolean;
}): Promise<SqliteSidecarSyncResult> {
  let changed = false;
  try {
    if (
      await syncMemoryFiles({
        db: params.db,
        agentId: params.agentId,
        workspaceDir: params.workspaceDir,
        extraPaths: params.extraPaths,
        force: params.force,
        ftsAvailable: params.ftsAvailable,
      })
    ) {
      changed = true;
    }
    if (
      await syncSessionFiles({
        db: params.db,
        agentId: params.agentId,
        force: params.force,
        ftsAvailable: params.ftsAvailable,
        retention: params.sqliteMemory.retention,
      })
    ) {
      changed = true;
    }
  } catch (err) {
    log.warn(`sqlite memory sidecar sync failed: ${String(err)}`);
    throw err;
  }
  return { changed, counts: readSqliteMemoryCounts(params.db) };
}
