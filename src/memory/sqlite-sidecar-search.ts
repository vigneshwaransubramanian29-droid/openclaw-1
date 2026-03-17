import type { DatabaseSync } from "node:sqlite";
import type { ResolvedSqliteMemoryConfig } from "../agents/memory-search.js";
import type {
  MemorySearchBackend,
  MemorySearchResult,
  MemorySearchResultBackend,
} from "./types.js";

type SidecarSearchRow = {
  path: string;
  startLine: number;
  endLine: number;
  snippet: string;
  importanceScore?: number;
  createdAt?: number;
  updatedAt?: number;
  status?: string;
};

type SqliteSearchValue = string | number | null;

function normalizeLookupText(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

function buildFtsQuery(raw: string): string | null {
  const tokens = normalizeLookupText(raw)
    .split(/[^a-z0-9_]+/i)
    .filter((token) => token.length >= 2)
    .slice(0, 8);
  if (tokens.length === 0) {
    const trimmed = raw.trim().replace(/"/g, '""');
    return trimmed ? `"${trimmed}"` : null;
  }
  // Use OR so partial matches surface (e.g. "wife name" finds "Wife: Sarah").
  // FTS5 ranks by BM25 so docs matching more tokens still rank higher.
  return tokens.map((token) => `"${token.replace(/"/g, '""')}"*`).join(" OR ");
}

function buildLikePattern(raw: string): string {
  // Use the longest token as the LIKE anchor — simpler and avoids requiring
  // tokens in sequence (e.g. "wife name" should find "Wife: Sarah").
  const tokens = normalizeLookupText(raw).split(/\s+/).filter(Boolean);
  const anchor = tokens.reduce((a, b) => (a.length >= b.length ? a : b), tokens[0] ?? raw.trim());
  return `%${anchor}%`;
}

function toMemoryResult(row: SidecarSearchRow, score: number): MemorySearchResult {
  return {
    path: row.path,
    startLine: row.startLine,
    endLine: row.endLine,
    score: Math.max(0.01, Math.min(1, score)),
    snippet: row.snippet,
    source: row.path.startsWith("sessions/") ? "sessions" : "memory",
    backend: "sqlite-sidecar",
    backends: ["sqlite-sidecar"],
  };
}

function normalizeBackends(result: MemorySearchResult): MemorySearchBackend[] {
  if (Array.isArray(result.backends) && result.backends.length > 0) {
    return Array.from(new Set(result.backends));
  }
  if (result.backend === "primary" || result.backend === "sqlite-sidecar") {
    return [result.backend];
  }
  return [];
}

function mergeBackendState(backends: MemorySearchBackend[]): MemorySearchResultBackend | undefined {
  if (backends.length === 0) {
    return undefined;
  }
  if (backends.length === 1) {
    return backends[0];
  }
  return "merged";
}

function compareResults(left: MemorySearchResult, right: MemorySearchResult): number {
  if (right.score !== left.score) {
    return right.score - left.score;
  }
  if (left.path !== right.path) {
    return left.path.localeCompare(right.path);
  }
  if (left.startLine !== right.startLine) {
    return left.startLine - right.startLine;
  }
  return left.endLine - right.endLine;
}

function dedupeResults(results: MemorySearchResult[]): MemorySearchResult[] {
  const merged = new Map<string, MemorySearchResult>();
  for (const result of results) {
    const key = `${normalizeLookupText(result.snippet)}|${result.path}|${result.startLine}|${result.endLine}`;
    const existing = merged.get(key);
    if (!existing) {
      const backends = normalizeBackends(result);
      merged.set(key, {
        ...result,
        backend: mergeBackendState(backends) ?? result.backend,
        backends: backends.length > 0 ? backends : result.backends,
      });
      continue;
    }

    const backends = Array.from(new Set([...normalizeBackends(existing), ...normalizeBackends(result)]));
    merged.set(key, {
      ...existing,
      score: Math.max(existing.score, result.score),
      citation: existing.citation ?? result.citation,
      source: existing.source,
      backend: mergeBackendState(backends) ?? existing.backend ?? result.backend,
      backends,
    });
  }
  return [...merged.values()].sort(compareResults);
}

function searchStage(params: {
  db: DatabaseSync;
  ftsAvailable: boolean;
  ftsQuery: string | null;
  likePattern: string;
  sqlFts: string;
  sqlLike: string;
  valuesFts: SqliteSearchValue[];
  valuesLike: SqliteSearchValue[];
}): SidecarSearchRow[] {
  if (params.ftsAvailable && params.ftsQuery) {
    return params.db.prepare(params.sqlFts).all(...params.valuesFts) as SidecarSearchRow[];
  }
  return params.db.prepare(params.sqlLike).all(...params.valuesLike) as SidecarSearchRow[];
}

export function searchSqliteSidecar(params: {
  db: DatabaseSync;
  agentId: string;
  query: string;
  ftsAvailable: boolean;
  sqliteMemory: ResolvedSqliteMemoryConfig;
  maxResults?: number;
  sessionKey?: string;
}): MemorySearchResult[] {
  const target = Math.min(
    params.maxResults ?? params.sqliteMemory.retrieval.maxResults,
    params.sqliteMemory.retrieval.maxResults,
  );
  if (target <= 0) {
    return [];
  }
  const ftsQuery = buildFtsQuery(params.query);
  const likePattern = buildLikePattern(params.query);
  const results: MemorySearchResult[] = [];

  const pushStage = (
    rows: SidecarSearchRow[],
    limit: number,
    baseScore: number,
    timeField: "createdAt" | "updatedAt" | null,
  ) => {
    const ranked = rows
      .map((row) => {
        const timeValue = timeField ? Number(row[timeField] ?? 0) : 0;
        const recencyBoost = timeValue > 0 ? Math.min(0.08, (Date.now() - timeValue) / -86_400_000_000) : 0;
        const importanceBoost = Math.min(0.12, Number(row.importanceScore ?? 0) * 0.12);
        const openTaskBoost = row.status === "open" ? 0.05 : 0;
        return toMemoryResult(row, baseScore + recencyBoost + importanceBoost + openTaskBoost);
      })
      .slice(0, limit);
    results.push(...ranked);
  };

  if (params.sessionKey && params.sqliteMemory.retrieval.sessionLimit > 0 && results.length < target) {
    const exactSessionRows = searchStage({
      db: params.db,
      ftsAvailable: params.ftsAvailable,
      ftsQuery,
      likePattern,
      sqlFts: `
        SELECT
          m.source_path as path,
          m.source_start_line as startLine,
          m.source_end_line as endLine,
          m.text as snippet,
          m.importance_score as importanceScore,
          m.created_at as createdAt
        FROM memory_fts f
        INNER JOIN messages m ON f.ref_key = ('message:' || m.id)
        INNER JOIN sessions s ON s.session_id = m.session_id
        WHERE f.kind = 'message' AND f.agent_id = ? AND s.session_key = ? AND memory_fts MATCH ?
        ORDER BY m.created_at DESC, m.importance_score DESC
        LIMIT ?
      `,
      sqlLike: `
        SELECT
          m.source_path as path,
          m.source_start_line as startLine,
          m.source_end_line as endLine,
          m.text as snippet,
          m.importance_score as importanceScore,
          m.created_at as createdAt
        FROM messages m
        INNER JOIN sessions s ON s.session_id = m.session_id
        WHERE s.agent_id = ? AND s.session_key = ? AND m.normalized_text LIKE ?
        ORDER BY m.created_at DESC, m.importance_score DESC
        LIMIT ?
      `,
      valuesFts: [params.agentId, params.sessionKey.toLowerCase(), ftsQuery, params.sqliteMemory.retrieval.sessionLimit],
      valuesLike: [params.agentId, params.sessionKey.toLowerCase(), likePattern, params.sqliteMemory.retrieval.sessionLimit],
    });
    pushStage(exactSessionRows, Math.min(target - results.length, params.sqliteMemory.retrieval.sessionLimit), 0.96, "createdAt");
  }

  if (params.sqliteMemory.retrieval.recentLimit > 0 && results.length < target) {
    const recentCutoff = Date.now() - params.sqliteMemory.retrieval.recentWindowDays * 24 * 60 * 60 * 1000;
    const recentRows = searchStage({
      db: params.db,
      ftsAvailable: params.ftsAvailable,
      ftsQuery,
      likePattern,
      sqlFts: `
        SELECT
          m.source_path as path,
          m.source_start_line as startLine,
          m.source_end_line as endLine,
          m.text as snippet,
          m.importance_score as importanceScore,
          m.created_at as createdAt
        FROM memory_fts f
        INNER JOIN messages m ON f.ref_key = ('message:' || m.id)
        INNER JOIN sessions s ON s.session_id = m.session_id
        WHERE f.kind = 'message'
          AND f.agent_id = ?
          AND m.created_at >= ?
          AND (? IS NULL OR s.session_key != ?)
          AND memory_fts MATCH ?
        ORDER BY m.created_at DESC, m.importance_score DESC
        LIMIT ?
      `,
      sqlLike: `
        SELECT
          m.source_path as path,
          m.source_start_line as startLine,
          m.source_end_line as endLine,
          m.text as snippet,
          m.importance_score as importanceScore,
          m.created_at as createdAt
        FROM messages m
        INNER JOIN sessions s ON s.session_id = m.session_id
        WHERE s.agent_id = ?
          AND m.created_at >= ?
          AND (? IS NULL OR s.session_key != ?)
          AND m.normalized_text LIKE ?
        ORDER BY m.created_at DESC, m.importance_score DESC
        LIMIT ?
      `,
      valuesFts: [
        params.agentId,
        recentCutoff,
        params.sessionKey?.toLowerCase() ?? null,
        params.sessionKey?.toLowerCase() ?? null,
        ftsQuery,
        params.sqliteMemory.retrieval.recentLimit,
      ],
      valuesLike: [
        params.agentId,
        recentCutoff,
        params.sessionKey?.toLowerCase() ?? null,
        params.sessionKey?.toLowerCase() ?? null,
        likePattern,
        params.sqliteMemory.retrieval.recentLimit,
      ],
    });
    pushStage(recentRows, Math.min(target - results.length, params.sqliteMemory.retrieval.recentLimit), 0.86, "createdAt");
  }

  if (params.sqliteMemory.retrieval.factTaskLimit > 0 && results.length < target) {
    const factRows = searchStage({
      db: params.db,
      ftsAvailable: params.ftsAvailable,
      ftsQuery,
      likePattern,
      sqlFts: `
        SELECT
          facts.source_path as path,
          facts.source_start_line as startLine,
          facts.source_end_line as endLine,
          facts.text as snippet,
          facts.importance_score as importanceScore,
          facts.updated_at as updatedAt
        FROM memory_fts f
        INNER JOIN facts ON f.ref_key = ('fact:' || facts.id)
        WHERE f.kind = 'fact' AND f.agent_id = ? AND memory_fts MATCH ?
        ORDER BY facts.importance_score DESC, facts.last_seen_at DESC
        LIMIT ?
      `,
      sqlLike: `
        SELECT
          source_path as path,
          source_start_line as startLine,
          source_end_line as endLine,
          text as snippet,
          importance_score as importanceScore,
          updated_at as updatedAt
        FROM facts
        WHERE agent_id = ? AND normalized_text LIKE ?
        ORDER BY importance_score DESC, last_seen_at DESC
        LIMIT ?
      `,
      valuesFts: [params.agentId, ftsQuery, params.sqliteMemory.retrieval.factTaskLimit],
      valuesLike: [params.agentId, likePattern, params.sqliteMemory.retrieval.factTaskLimit],
    });
    const taskRows = searchStage({
      db: params.db,
      ftsAvailable: params.ftsAvailable,
      ftsQuery,
      likePattern,
      sqlFts: `
        SELECT
          tasks.source_path as path,
          tasks.source_start_line as startLine,
          tasks.source_end_line as endLine,
          tasks.description as snippet,
          tasks.importance_score as importanceScore,
          tasks.updated_at as updatedAt,
          tasks.status as status
        FROM memory_fts f
        INNER JOIN tasks ON f.ref_key = ('task:' || tasks.id)
        WHERE f.kind = 'task' AND f.agent_id = ? AND memory_fts MATCH ?
        ORDER BY CASE WHEN tasks.status = 'open' THEN 0 ELSE 1 END, tasks.importance_score DESC, tasks.updated_at DESC
        LIMIT ?
      `,
      sqlLike: `
        SELECT
          source_path as path,
          source_start_line as startLine,
          source_end_line as endLine,
          description as snippet,
          importance_score as importanceScore,
          updated_at as updatedAt,
          status
        FROM tasks
        WHERE agent_id = ? AND normalized_text LIKE ?
        ORDER BY CASE WHEN status = 'open' THEN 0 ELSE 1 END, importance_score DESC, updated_at DESC
        LIMIT ?
      `,
      valuesFts: [params.agentId, ftsQuery, params.sqliteMemory.retrieval.factTaskLimit],
      valuesLike: [params.agentId, likePattern, params.sqliteMemory.retrieval.factTaskLimit],
    });
    const combined = [...taskRows, ...factRows]
      .sort((left, right) => (right.importanceScore ?? 0) - (left.importanceScore ?? 0))
      .slice(0, params.sqliteMemory.retrieval.factTaskLimit);
    pushStage(combined, Math.min(target - results.length, params.sqliteMemory.retrieval.factTaskLimit), 0.78, "updatedAt");
  }

  if (params.sqliteMemory.retrieval.summaryLimit > 0 && results.length < target) {
    const summaryRows = searchStage({
      db: params.db,
      ftsAvailable: params.ftsAvailable,
      ftsQuery,
      likePattern,
      sqlFts: `
        SELECT
          summaries.source_path as path,
          summaries.source_start_line as startLine,
          summaries.source_end_line as endLine,
          summaries.summary as snippet,
          summaries.importance_score as importanceScore,
          summaries.updated_at as updatedAt
        FROM memory_fts f
        INNER JOIN summaries ON f.ref_key = ('summary:' || summaries.id)
        WHERE f.kind = 'summary' AND f.agent_id = ? AND memory_fts MATCH ?
        ORDER BY summaries.importance_score DESC, summaries.updated_at DESC
        LIMIT ?
      `,
      sqlLike: `
        SELECT
          source_path as path,
          source_start_line as startLine,
          source_end_line as endLine,
          summary as snippet,
          importance_score as importanceScore,
          updated_at as updatedAt
        FROM summaries
        WHERE agent_id = ? AND lower(summary) LIKE ?
        ORDER BY importance_score DESC, updated_at DESC
        LIMIT ?
      `,
      valuesFts: [params.agentId, ftsQuery, params.sqliteMemory.retrieval.summaryLimit],
      valuesLike: [params.agentId, likePattern, params.sqliteMemory.retrieval.summaryLimit],
    });
    pushStage(summaryRows, Math.min(target - results.length, params.sqliteMemory.retrieval.summaryLimit), 0.68, "updatedAt");
  }

  return dedupeResults(results).slice(0, target);
}

export function dedupeMergedMemoryResults(results: MemorySearchResult[]): MemorySearchResult[] {
  return dedupeResults(results);
}
