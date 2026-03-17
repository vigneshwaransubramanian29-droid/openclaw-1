export type MemorySource = "memory" | "sessions";
export type MemorySearchBackend = "primary" | "sqlite-sidecar";
export type MemorySearchResultBackend = MemorySearchBackend | "merged";

export type MemorySearchResult = {
  path: string;
  startLine: number;
  endLine: number;
  score: number;
  snippet: string;
  source: MemorySource;
  citation?: string;
  backend?: MemorySearchResultBackend;
  backends?: MemorySearchBackend[];
};

export type MemoryEmbeddingProbeResult = {
  ok: boolean;
  error?: string;
};

export type SqliteMemoryProviderStatus = {
  enabled: boolean;
  mode: "sidecar";
  dbPath: string;
  degraded: boolean;
  activationMode: "configured" | "auto-detected";
  state: "ready" | "syncing" | "delegate-only" | "degraded";
  fallback: "existing";
  fallbackState: "existing" | "delegate-only";
  rowCounts?: {
    sessions?: number;
    messages?: number;
    facts?: number;
    tasks?: number;
    summaries?: number;
    memoryLinks?: number;
  };
  lastSearchMs?: number;
  lastSyncMs?: number;
  lastWriteMs?: number;
  lastError?: string;
  freshVerified?: boolean;
  syncInFlight?: boolean;
  dirty?: {
    memory: boolean;
    sessions: boolean;
  };
  nextSyncAllowedAt?: number;
  consecutiveSyncFailures?: number;
  fts?: {
    available: boolean;
    error?: string;
  };
};

export type MemorySyncProgressUpdate = {
  completed: number;
  total: number;
  label?: string;
};

export type MemoryProviderStatus = {
  backend: "builtin" | "qmd";
  provider: string;
  model?: string;
  requestedProvider?: string;
  files?: number;
  chunks?: number;
  dirty?: boolean;
  workspaceDir?: string;
  dbPath?: string;
  extraPaths?: string[];
  sources?: MemorySource[];
  sourceCounts?: Array<{ source: MemorySource; files: number; chunks: number }>;
  cache?: { enabled: boolean; entries?: number; maxEntries?: number };
  fts?: { enabled: boolean; available: boolean; error?: string };
  fallback?: { from: string; reason?: string };
  vector?: {
    enabled: boolean;
    available?: boolean;
    extensionPath?: string;
    loadError?: string;
    dims?: number;
  };
  batch?: {
    enabled: boolean;
    failures: number;
    limit: number;
    wait: boolean;
    concurrency: number;
    pollIntervalMs: number;
    timeoutMs: number;
    lastError?: string;
    lastProvider?: string;
  };
  custom?: Record<string, unknown> & {
    sqliteMemory?: SqliteMemoryProviderStatus;
  };
};

export interface MemorySearchManager {
  search(
    query: string,
    opts?: { maxResults?: number; minScore?: number; sessionKey?: string },
  ): Promise<MemorySearchResult[]>;
  readFile(params: {
    relPath: string;
    from?: number;
    lines?: number;
  }): Promise<{ text: string; path: string }>;
  status(): MemoryProviderStatus;
  sync?(params?: {
    reason?: string;
    force?: boolean;
    sessionFiles?: string[];
    progress?: (update: MemorySyncProgressUpdate) => void;
  }): Promise<void>;
  probeEmbeddingAvailability(): Promise<MemoryEmbeddingProbeResult>;
  probeVectorAvailability(): Promise<boolean>;
  close?(): Promise<void>;
}
