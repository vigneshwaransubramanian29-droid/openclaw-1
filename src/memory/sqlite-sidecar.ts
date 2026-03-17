import fs from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import chokidar, { type FSWatcher } from "chokidar";
import type { ResolvedMemorySearchConfig } from "../agents/memory-search.js";
import { resolveSessionTranscriptsDirForAgent } from "../config/sessions/paths.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { onSessionTranscriptUpdate } from "../sessions/transcript-events.js";
import { ensureDir } from "./internal.js";
import { syncSqliteSidecarSources } from "./sqlite-sidecar-ingest.js";
import {
  ensureSqliteMemorySidecarSchema,
  readSqliteMemoryCounts,
  type SqliteMemoryCounts,
} from "./sqlite-sidecar-schema.js";
import { dedupeMergedMemoryResults, searchSqliteSidecar } from "./sqlite-sidecar-search.js";
import { requireNodeSqlite } from "./sqlite.js";
import type {
  MemoryEmbeddingProbeResult,
  MemoryProviderStatus,
  MemorySearchManager,
  MemorySearchResult,
  MemorySyncProgressUpdate,
  SqliteMemoryProviderStatus,
} from "./types.js";

const log = createSubsystemLogger("memory");
const SIDECAR_SYNC_DEBOUNCE_MS = 250;
const SIDECAR_SYNC_RETRY_BASE_MS = 1_000;
const SIDECAR_SYNC_RETRY_MAX_MS = 60_000;
const SIDECAR_FIRST_SEARCH_WAIT_MS = 350;

type SidecarPurpose = "full" | "status";

export class SqliteMemorySidecarManager implements MemorySearchManager {
  private readonly sessionsDir: string;
  private readonly db: DatabaseSync;
  private readonly purpose: SidecarPurpose;
  private readonly dbPath: string;
  private readonly watchPaths: string[];
  private watcher: FSWatcher | null = null;
  private sessionUnsubscribe: (() => void) | null = null;
  private syncPromise: Promise<void> | null = null;
  private scheduledSyncTimer: NodeJS.Timeout | null = null;
  private dirtyMemory = true;
  private dirtySessions = true;
  private freshVerified = false;
  private nextSyncAllowedAt = 0;
  private consecutiveSyncFailures = 0;
  private ftsAvailable = false;
  private ftsError?: string;
  private degraded = false;
  private lastError?: string;
  private lastSearchMs?: number;
  private lastSyncMs?: number;
  private lastWriteMs?: number;
  private closed = false;

  constructor(
    private readonly params: {
      agentId: string;
      workspaceDir: string;
      settings: ResolvedMemorySearchConfig;
      delegate: MemorySearchManager;
      activationMode: "configured" | "auto-detected";
      purpose?: SidecarPurpose;
      onClose?: () => void;
    },
  ) {
    this.purpose = params.purpose ?? "full";
    this.dbPath = params.settings.sqliteMemory.path;
    this.sessionsDir = resolveSessionTranscriptsDirForAgent(params.agentId);
    this.watchPaths = this.buildWatchPaths();
    this.db = this.openDatabase();
    this.initializeSchema();
    if (this.purpose === "full") {
      this.armWatchers();
      this.scheduleSidecarSync({ reason: "startup" });
    }
  }

  async search(
    query: string,
    opts?: { maxResults?: number; minScore?: number; sessionKey?: string },
  ): Promise<MemorySearchResult[]> {
    const startedAt = Date.now();
    const totalLimit = opts?.maxResults ?? this.params.settings.sqliteMemory.retrieval.maxResults;
    this.scheduleSidecarSync({ reason: "search" });
    const delegatePromise = this.params.delegate
      .search(query, {
        ...opts,
        maxResults: totalLimit,
      })
      .then((results) => this.annotatePrimaryResults(results));
    const sidecarReadyPromise = this.waitForSidecarReadiness();
    const [delegateOutcome, sidecarReady] = await Promise.all([
      delegatePromise.then(
        (results) => ({ ok: true as const, results }),
        (error) => ({ ok: false as const, error }),
      ),
      sidecarReadyPromise,
    ]);

    let sidecarResults: MemorySearchResult[] = [];
    if (sidecarReady) {
      try {
        sidecarResults = this.searchSidecar(query, opts);
      } catch (err) {
        this.recordFailure("search", err);
      }
    }

    if (!delegateOutcome.ok) {
      if (sidecarResults.length > 0) {
        return this.finalizeSearch(sidecarResults, startedAt, totalLimit);
      }
      // Sidecar wasn't ready (degraded, not yet synced, or timed out) but primary
      // also failed — try the SQLite DB directly as last-resort fallback.
      // Stale local data is always better than surfacing a quota/network error.
      if (!sidecarReady) {
        try {
          const emergency = this.searchSidecar(query, opts);
          if (emergency.length > 0) {
            return this.finalizeSearch(emergency, startedAt, totalLimit);
          }
        } catch {
          // SQLite also unavailable; fall through to throw the original error
        }
      }
      throw delegateOutcome.error;
    }

    if (sidecarResults.length === 0) {
      return this.finalizeSearch(delegateOutcome.results, startedAt, totalLimit);
    }

    return this.finalizeSearch(
      dedupeMergedMemoryResults([...sidecarResults, ...delegateOutcome.results]),
      startedAt,
      totalLimit,
    );
  }

  async readFile(params: {
    relPath: string;
    from?: number;
    lines?: number;
  }): Promise<{ text: string; path: string }> {
    if (this.isTranscriptPath(params.relPath)) {
      return await this.readTranscriptFile(params);
    }
    return await this.params.delegate.readFile(params);
  }

  status(): MemoryProviderStatus {
    const base = this.params.delegate.status();
    let rowCounts: SqliteMemoryCounts | undefined;
    try {
      rowCounts = readSqliteMemoryCounts(this.db);
    } catch (err) {
      this.recordFailure("status", err);
    }
    const persistedLastSearchMs = this.readMetaNumber("last_search_ms");
    const persistedLastSyncMs = this.readMetaNumber("last_sync_ms");
    const persistedLastWriteMs = this.readMetaNumber("last_write_ms");
    const persistedLastError = this.readMetaString("last_error");
    const state = this.getSidecarState({ rowCounts, persistedLastSyncMs });
    const sqliteMemory: SqliteMemoryProviderStatus = {
      enabled: true,
      mode: this.params.settings.sqliteMemory.mode,
      dbPath: this.dbPath,
      degraded: this.degraded,
      activationMode: this.params.activationMode,
      state,
      fallback: this.params.settings.sqliteMemory.fallback,
      fallbackState: state === "ready" ? "existing" : "delegate-only",
      rowCounts,
      lastSearchMs: this.lastSearchMs ?? persistedLastSearchMs,
      lastSyncMs: this.lastSyncMs ?? persistedLastSyncMs,
      lastWriteMs: this.lastWriteMs ?? persistedLastWriteMs,
      lastError: this.lastError ?? persistedLastError,
      freshVerified: this.freshVerified,
      syncInFlight: this.syncPromise != null,
      dirty: {
        memory: this.dirtyMemory,
        sessions: this.dirtySessions,
      },
      nextSyncAllowedAt: this.nextSyncAllowedAt || undefined,
      consecutiveSyncFailures: this.consecutiveSyncFailures,
      fts: {
        available: this.ftsAvailable,
        error: this.ftsError,
      },
    };
    return {
      ...base,
      custom: {
        ...(base.custom ?? {}),
        sqliteMemory,
      },
    };
  }

  async sync(params?: {
    reason?: string;
    force?: boolean;
    progress?: (update: MemorySyncProgressUpdate) => void;
  }): Promise<void> {
    if (params?.progress) {
      params.progress({ completed: 0, total: 2, label: "Syncing sqlite memory sidecar" });
    }
    await this.syncSidecar({ reason: params?.reason ?? "manual", force: params?.force });
    params?.progress?.({ completed: 1, total: 2, label: "Syncing primary memory backend" });
    await this.params.delegate.sync?.(params);
    params?.progress?.({ completed: 2, total: 2, label: "Memory sync complete" });
  }

  async probeEmbeddingAvailability(): Promise<MemoryEmbeddingProbeResult> {
    return await this.params.delegate.probeEmbeddingAvailability();
  }

  async probeVectorAvailability(): Promise<boolean> {
    return await this.params.delegate.probeVectorAvailability();
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    if (this.scheduledSyncTimer) {
      clearTimeout(this.scheduledSyncTimer);
      this.scheduledSyncTimer = null;
    }
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
    if (this.sessionUnsubscribe) {
      this.sessionUnsubscribe();
      this.sessionUnsubscribe = null;
    }
    if (this.syncPromise) {
      await this.syncPromise.catch(() => undefined);
      this.syncPromise = null;
    }
    this.db.close();
    await this.params.delegate.close?.();
    this.params.onClose?.();
  }

  private initializeSchema(): void {
    try {
      const result = ensureSqliteMemorySidecarSchema({ db: this.db, dbPath: this.dbPath });
      this.ftsAvailable = result.ftsAvailable;
      this.ftsError = result.ftsError;
    } catch (err) {
      this.recordFailure("schema", err);
    }
  }

  private openDatabase(): DatabaseSync {
    ensureDir(path.dirname(this.dbPath));
    const { DatabaseSync } = requireNodeSqlite();
    const db = new DatabaseSync(this.dbPath);
    db.exec("PRAGMA busy_timeout = 5000");
    try {
      db.exec("PRAGMA journal_mode = WAL");
    } catch (err) {
      log.debug(`sqlite memory sidecar WAL enable skipped for ${this.dbPath}: ${String(err)}`);
    }
    return db;
  }

  private buildWatchPaths(): string[] {
    const paths = new Set<string>();
    paths.add(path.join(this.params.workspaceDir, "MEMORY.md"));
    paths.add(path.join(this.params.workspaceDir, "memory"));
    for (const extraPath of this.params.settings.extraPaths) {
      const resolved = path.isAbsolute(extraPath)
        ? path.resolve(extraPath)
        : path.resolve(this.params.workspaceDir, extraPath);
      paths.add(resolved);
    }
    return [...paths];
  }

  private armWatchers(): void {
    if (this.watchPaths.length > 0) {
      this.watcher = chokidar.watch(this.watchPaths, { ignoreInitial: true });
      this.watcher.on("all", (_event, changedPath) => {
        if (!changedPath.toLowerCase().endsWith(".md")) {
          return;
        }
        this.markSidecarDirty("memory");
      });
    }
    this.sessionUnsubscribe = onSessionTranscriptUpdate(({ sessionFile }) => {
      const absolute = path.resolve(sessionFile);
      if (!absolute.startsWith(this.sessionsDir)) {
        return;
      }
      this.markSidecarDirty("sessions");
    });
  }

  private async syncSidecar(params?: { reason?: string; force?: boolean }): Promise<void> {
    if (this.closed) {
      return;
    }
    const force = params?.force === true;
    if (!force && !this.dirtyMemory && !this.dirtySessions && this.freshVerified) {
      return;
    }
    if (this.syncPromise) {
      return await this.syncPromise;
    }
    if (!force && this.nextSyncAllowedAt > Date.now()) {
      this.scheduleSidecarSync({ reason: params?.reason ?? "retry-delay" });
      return;
    }
    if (this.scheduledSyncTimer) {
      clearTimeout(this.scheduledSyncTimer);
      this.scheduledSyncTimer = null;
    }
    this.syncPromise = (async () => {
      const startedAt = Date.now();
      try {
        const result = await syncSqliteSidecarSources({
          db: this.db,
          agentId: this.params.agentId,
          workspaceDir: this.params.workspaceDir,
          extraPaths: this.params.settings.extraPaths,
          sqliteMemory: this.params.settings.sqliteMemory,
          ftsAvailable: this.ftsAvailable,
          force: params?.force,
        });
        this.dirtyMemory = false;
        this.dirtySessions = false;
        this.freshVerified = true;
        this.consecutiveSyncFailures = 0;
        this.nextSyncAllowedAt = 0;
        this.degraded = false;
        this.lastError = undefined;
        this.writeMeta("last_error", "");
        this.lastSyncMs = Date.now() - startedAt;
        this.writeMeta("last_sync_ms", this.lastSyncMs);
        if (result.changed) {
          this.lastWriteMs = this.lastSyncMs;
          this.writeMeta("last_write_ms", this.lastWriteMs);
        }
      } catch (err) {
        this.recordFailure(params?.reason ?? "sync", err);
        this.consecutiveSyncFailures += 1;
        const retryDelayMs = Math.min(
          SIDECAR_SYNC_RETRY_MAX_MS,
          SIDECAR_SYNC_RETRY_BASE_MS * 2 ** Math.max(0, this.consecutiveSyncFailures - 1),
        );
        this.nextSyncAllowedAt = Date.now() + retryDelayMs;
        this.scheduleSidecarSync({ reason: `${params?.reason ?? "sync"}:retry` });
      } finally {
        this.syncPromise = null;
      }
    })();
    return await this.syncPromise;
  }

  private recordFailure(context: string, err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    this.degraded = true;
    this.lastError = `${context}: ${message}`;
    this.writeMeta("last_error", this.lastError);
    log.warn(
      `sqlite memory sidecar ${context} failed; falling back to existing memory backend: ${message}`,
    );
  }

  private markSidecarDirty(kind: "memory" | "sessions"): void {
    if (kind === "memory") {
      this.dirtyMemory = true;
    } else {
      this.dirtySessions = true;
    }
    this.scheduleSidecarSync({ reason: `${kind}-dirty` });
  }

  private isSidecarUsableForSearch(): boolean {
    return (
      this.purpose === "full" &&
      this.freshVerified &&
      !this.degraded &&
      !this.dirtyMemory &&
      !this.dirtySessions &&
      !this.syncPromise
    );
  }

  private hasPersistedSidecarRows(): boolean {
    try {
      const counts = readSqliteMemoryCounts(this.db);
      return Object.values(counts).some((count) => typeof count === "number" && count > 0);
    } catch {
      return false;
    }
  }

  private annotatePrimaryResults(results: MemorySearchResult[]): MemorySearchResult[] {
    return results.map((result) => ({
      ...result,
      backend: result.backend ?? "primary",
      backends:
        result.backends && result.backends.length > 0
          ? result.backends
          : result.backend === "sqlite-sidecar"
            ? ["sqlite-sidecar"]
            : ["primary"],
    }));
  }

  private searchSidecar(
    query: string,
    opts?: { maxResults?: number; minScore?: number; sessionKey?: string },
  ): MemorySearchResult[] {
    return searchSqliteSidecar({
      db: this.db,
      agentId: this.params.agentId,
      query,
      ftsAvailable: this.ftsAvailable,
      sqliteMemory: this.params.settings.sqliteMemory,
      maxResults: opts?.maxResults,
      sessionKey: opts?.sessionKey,
    });
  }

  private async waitForSidecarReadiness(timeoutMs = SIDECAR_FIRST_SEARCH_WAIT_MS): Promise<boolean> {
    if (this.purpose !== "full" || this.degraded) {
      return false;
    }
    if (this.isSidecarUsableForSearch()) {
      return true;
    }
    if (!this.syncPromise && this.nextSyncAllowedAt > Date.now()) {
      this.scheduleSidecarSync({ reason: "search" });
      return false;
    }

    const syncPromise = this.syncPromise ?? this.syncSidecar({ reason: "search-readiness" });
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => resolve(), timeoutMs);
      void syncPromise.finally(() => {
        clearTimeout(timer);
        resolve();
      });
    });
    if (this.isSidecarUsableForSearch()) {
      return true;
    }
    // On one-shot CLI invocations, the manager starts "dirty" before the
    // background verification finishes. If we already have persisted rows,
    // prefer that local snapshot over silently dropping the sidecar backend.
    return this.hasPersistedSidecarRows();
  }

  private finalizeSearch(
    results: MemorySearchResult[],
    startedAt: number,
    totalLimit: number,
  ): MemorySearchResult[] {
    this.lastSearchMs = Date.now() - startedAt;
    this.writeMeta("last_search_ms", this.lastSearchMs);
    return results.slice(0, totalLimit);
  }

  private getSidecarState(params: {
    rowCounts?: SqliteMemoryCounts;
    persistedLastSyncMs?: number;
  }): SqliteMemoryProviderStatus["state"] {
    if (this.degraded) {
      return "degraded";
    }
    if (this.isSidecarUsableForSearch()) {
      return "ready";
    }
    const hasPersistedRows = Boolean(
      params.rowCounts &&
        Object.values(params.rowCounts).some((count) => typeof count === "number" && count > 0),
    );
    if (this.purpose === "status" && (hasPersistedRows || (params.persistedLastSyncMs ?? 0) > 0)) {
      return "ready";
    }
    if (
      this.syncPromise ||
      this.scheduledSyncTimer ||
      this.dirtyMemory ||
      this.dirtySessions ||
      !this.freshVerified
    ) {
      return "syncing";
    }
    return "delegate-only";
  }

  private scheduleSidecarSync(params?: { reason?: string; force?: boolean }): void {
    if (this.closed || this.purpose !== "full") {
      return;
    }
    if (params?.force) {
      if (this.scheduledSyncTimer) {
        clearTimeout(this.scheduledSyncTimer);
        this.scheduledSyncTimer = null;
      }
      void this.syncSidecar({ reason: params.reason ?? "scheduled-force", force: true });
      return;
    }
    if (!this.dirtyMemory && !this.dirtySessions && this.freshVerified) {
      return;
    }
    if (this.syncPromise || this.scheduledSyncTimer) {
      return;
    }
    const now = Date.now();
    const runAt = Math.max(now + SIDECAR_SYNC_DEBOUNCE_MS, this.nextSyncAllowedAt);
    const delayMs = Math.max(0, runAt - now);
    this.scheduledSyncTimer = setTimeout(() => {
      this.scheduledSyncTimer = null;
      void this.syncSidecar({ reason: params?.reason ?? "scheduled" });
    }, delayMs);
  }

  private readMetaNumber(key: string): number | undefined {
    const raw = this.readMetaString(key);
    if (raw === undefined || raw === "") {
      return undefined;
    }
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  private readMetaString(key: string): string | undefined {
    try {
      const row = this.db.prepare("SELECT value FROM sidecar_meta WHERE key = ?").get(key) as
        | { value?: string }
        | undefined;
      return row?.value;
    } catch {
      return undefined;
    }
  }

  private writeMeta(key: string, value: string | number): void {
    try {
      this.db
        .prepare(
          `
          INSERT INTO sidecar_meta (key, value)
          VALUES (?, ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value
        `,
        )
        .run(key, String(value));
    } catch {}
  }

  private isTranscriptPath(relPath: string): boolean {
    const normalized = relPath.trim().replace(/\\/g, "/");
    if (!normalized.startsWith("sessions/")) {
      return false;
    }
    if (path.posix.dirname(normalized) !== "sessions") {
      return false;
    }
    return normalized.endsWith(".jsonl");
  }

  private async readTranscriptFile(params: {
    relPath: string;
    from?: number;
    lines?: number;
  }): Promise<{ text: string; path: string }> {
    const normalized = params.relPath.trim().replace(/\\/g, "/");
    if (!this.isTranscriptPath(normalized)) {
      throw new Error("path required");
    }
    const base = path.posix.basename(normalized);
    const absPath = path.join(this.sessionsDir, base);
    try {
      const stat = await fs.lstat(absPath);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new Error("path required");
      }
      const content = await fs.readFile(absPath, "utf-8");
      if (!params.from && !params.lines) {
        return { text: content, path: normalized };
      }
      const lines = content.split("\n");
      const start = Math.max(1, params.from ?? 1);
      const count = Math.max(1, params.lines ?? lines.length);
      return {
        text: lines.slice(start - 1, start - 1 + count).join("\n"),
        path: normalized,
      };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        return { text: "", path: normalized };
      }
      throw err;
    }
  }
}
