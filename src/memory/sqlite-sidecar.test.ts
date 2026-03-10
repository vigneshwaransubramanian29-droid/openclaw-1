import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resetEmbeddingMocks } from "./embedding.test-mocks.js";
import { getMemorySearchManager } from "./index.js";
import { requireNodeSqlite } from "./sqlite.js";
import "./test-runtime-mocks.js";

function createConfig(params: {
  workspaceDir: string;
  indexPath: string;
  sidecarPath: string;
  retention?: { messageDays?: number; maxMessagesPerSession?: number; summaryMaxChars?: number };
}): OpenClawConfig {
  return {
    agents: {
      defaults: {
        workspace: params.workspaceDir,
        memorySearch: {
          provider: "openai",
          model: "mock-embed",
          store: { path: params.indexPath, vector: { enabled: false } },
          cache: { enabled: false },
          query: { minScore: 0, hybrid: { enabled: false } },
          sync: { watch: false, onSessionStart: false, onSearch: false },
          sqliteMemory: {
            enabled: true,
            path: params.sidecarPath,
            retention: params.retention,
          },
        },
      },
      list: [{ id: "main", default: true }],
    },
  } as OpenClawConfig;
}

async function writeSessionFixture(params: {
  stateDir: string;
  sessionKey: string;
  sessionId: string;
  lines: Array<Record<string, unknown>>;
}) {
  const sessionsDir = path.join(params.stateDir, "agents", "main", "sessions");
  await fs.mkdir(sessionsDir, { recursive: true });
  const sessionFile = path.join(sessionsDir, `${params.sessionId}.jsonl`);
  await fs.writeFile(
    path.join(sessionsDir, "sessions.json"),
    JSON.stringify({
      [params.sessionKey]: {
        sessionId: params.sessionId,
        updatedAt: Date.now(),
        sessionFile,
      },
    }),
    "utf-8",
  );
  const header = {
    type: "session",
    version: 1,
    id: params.sessionId,
    timestamp: new Date().toISOString(),
    cwd: process.cwd(),
  };
  await fs.writeFile(
    sessionFile,
    [JSON.stringify(header), ...params.lines.map((line) => JSON.stringify(line))].join("\n"),
    "utf-8",
  );
  return { sessionsDir, sessionFile };
}

function buildMessage(params: {
  role: "user" | "assistant";
  text: string;
  timestamp?: number;
  model?: string;
}): Record<string, unknown> {
  return {
    type: "message",
    message: {
      role: params.role,
      content: [{ type: "text", text: params.text }],
      provider: "openclaw",
      model: params.model ?? "mock-embed",
      timestamp: params.timestamp ?? Date.now(),
    },
  };
}

async function getRequiredManager(cfg: OpenClawConfig) {
  const result = await getMemorySearchManager({ cfg, agentId: "main" });
  expect(result.manager).toBeTruthy();
  if (!result.manager) {
    throw new Error("manager missing");
  }
  return result.manager;
}

describe("sqlite memory sidecar", () => {
  let rootDir = "";
  let workspaceDir = "";
  let stateDir = "";
  let indexPath = "";
  let sidecarPath = "";
  let manager: Awaited<ReturnType<typeof getRequiredManager>> | null = null;

  beforeEach(async () => {
    resetEmbeddingMocks();
    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-sqlite-sidecar-"));
    workspaceDir = path.join(rootDir, "workspace");
    stateDir = path.join(rootDir, "state");
    indexPath = path.join(rootDir, "memory-index.sqlite");
    sidecarPath = path.join(rootDir, "memory-sidecar.sqlite");
    await fs.mkdir(path.join(workspaceDir, "memory"), { recursive: true });
    await fs.writeFile(
      path.join(workspaceDir, "memory", "2026-03-09.md"),
      ["# Decisions", "- Alpha launch is Tuesday", "# Tasks", "- [ ] Ship alpha release"].join(
        "\n",
      ),
      "utf-8",
    );
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  });

  afterEach(async () => {
    await manager?.close?.();
    manager = null;
    vi.unstubAllEnvs();
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  it("returns current-session transcript hits before durable markdown memory and reads transcript files", async () => {
    await writeSessionFixture({
      stateDir,
      sessionKey: "agent:main:discord:dm:user-1",
      sessionId: "session-alpha",
      lines: [
        buildMessage({ role: "user", text: "Alpha launch is Tuesday", timestamp: Date.now() - 1000 }),
        buildMessage({ role: "assistant", text: "Noted alpha launch is Tuesday", timestamp: Date.now() }),
      ],
    });
    const cfg = createConfig({ workspaceDir, indexPath, sidecarPath });
    manager = await getRequiredManager(cfg);

    await manager.sync?.({ reason: "test", force: true });
    const results = await manager.search("alpha launch", {
      sessionKey: "agent:main:discord:dm:user-1",
      maxResults: 4,
    });

    expect(results[0]?.path).toBe("sessions/session-alpha.jsonl");
    expect(results.some((entry) => entry.path === "memory/2026-03-09.md")).toBe(true);

    const transcript = await manager.readFile({
      relPath: "sessions/session-alpha.jsonl",
      from: 2,
      lines: 1,
    });
    expect(transcript.path).toBe("sessions/session-alpha.jsonl");
    expect(transcript.text).toContain("Alpha launch is Tuesday");

    const sqliteStatus = manager.status().custom?.sqliteMemory;
    expect(sqliteStatus?.rowCounts?.messages).toBeGreaterThan(0);
    expect(sqliteStatus?.rowCounts?.facts).toBeGreaterThan(0);
  });

  it("uses delegate-only search while freshness is unverified and schedules a background sync", async () => {
    const cfg = createConfig({ workspaceDir, indexPath, sidecarPath });
    manager = await getRequiredManager(cfg);
    const inner = manager as unknown as {
      freshVerified: boolean;
      dirtyMemory: boolean;
      dirtySessions: boolean;
      scheduleSidecarSync: (params?: { reason?: string; force?: boolean }) => void;
      params: {
        delegate: {
          search: (
            query: string,
            opts?: { maxResults?: number; minScore?: number; sessionKey?: string },
          ) => Promise<unknown[]>;
        };
      };
    };
    inner.freshVerified = false;
    inner.dirtyMemory = true;
    inner.dirtySessions = true;
    const scheduleSpy = vi.fn();
    inner.scheduleSidecarSync = scheduleSpy;
    const delegateSpy = vi
      .spyOn(inner.params.delegate, "search")
      .mockResolvedValue([
        {
          path: "delegate-only.md",
          startLine: 1,
          endLine: 1,
          score: 0.9,
          snippet: "delegate",
          source: "memory",
        },
      ]);

    const results = await manager.search("delegate probe", { maxResults: 2 });
    expect(results).toEqual([
      {
        path: "delegate-only.md",
        startLine: 1,
        endLine: 1,
        score: 0.9,
        snippet: "delegate",
        source: "memory",
      },
    ]);
    expect(delegateSpy).toHaveBeenCalledTimes(1);
    expect(scheduleSpy).toHaveBeenCalledWith({ reason: "search" });
  });

  it("reports delegate-only until first successful sync, then marks sidecar fresh", async () => {
    const cfg = createConfig({ workspaceDir, indexPath, sidecarPath });
    manager = await getRequiredManager(cfg);
    const before = manager.status().custom?.sqliteMemory;
    expect(before?.freshVerified).toBe(false);
    expect(before?.fallbackState).toBe("delegate-only");

    await manager.sync?.({ reason: "test", force: true });

    const after = manager.status().custom?.sqliteMemory;
    expect(after?.freshVerified).toBe(true);
    expect(after?.fallbackState).toBe("existing");
  });

  it("waits for an in-flight sidecar sync before closing", async () => {
    const cfg = createConfig({ workspaceDir, indexPath, sidecarPath });
    manager = await getRequiredManager(cfg);
    const inner = manager as unknown as {
      syncPromise: Promise<void> | null;
    };
    let releaseSync = () => {};
    inner.syncPromise = new Promise<void>((resolve) => {
      releaseSync = () => resolve();
    });

    let closed = false;
    const closePromise = manager.close().then(() => {
      closed = true;
    });

    await Promise.resolve();
    expect(closed).toBe(false);

    releaseSync();
    await closePromise;
    manager = null;
  });

  it("persists structured memory across restart and deduplicates repeated facts/tasks", async () => {
    await fs.writeFile(
      path.join(workspaceDir, "memory", "duplicate.md"),
      ["- Alpha launch is Tuesday", "- [ ] Ship alpha release"].join("\n"),
      "utf-8",
    );
    await writeSessionFixture({
      stateDir,
      sessionKey: "agent:main:discord:dm:user-2",
      sessionId: "session-persist",
      lines: [buildMessage({ role: "user", text: "Ship alpha release this week" })],
    });
    const cfg = createConfig({ workspaceDir, indexPath, sidecarPath });
    manager = await getRequiredManager(cfg);

    await manager.sync?.({ reason: "test", force: true });
    const firstStatus = manager.status().custom?.sqliteMemory;
    expect(firstStatus?.rowCounts?.facts).toBe(1);
    expect(firstStatus?.rowCounts?.tasks).toBe(1);

    await manager.close?.();
    manager = await getRequiredManager(cfg);

    const secondStatus = manager.status().custom?.sqliteMemory;
    expect(secondStatus?.rowCounts?.facts).toBe(1);
    expect(secondStatus?.rowCounts?.tasks).toBe(1);

    const results = await manager.search("ship alpha release", {
      sessionKey: "agent:main:discord:dm:user-2",
      maxResults: 3,
    });
    expect(results.some((entry) => entry.path === "memory/duplicate.md")).toBe(true);
  });

  it("summarizes and prunes old transcript windows while skipping low-value acknowledgements", async () => {
    const now = Date.now();
    await writeSessionFixture({
      stateDir,
      sessionKey: "agent:main:discord:dm:user-3",
      sessionId: "session-prune",
      lines: [
        buildMessage({ role: "user", text: "Plan the alpha rollout", timestamp: now - 10_000 }),
        buildMessage({ role: "assistant", text: "Draft the rollout checklist", timestamp: now - 8_000 }),
        buildMessage({ role: "user", text: "ok", timestamp: now - 6_000 }),
        buildMessage({ role: "assistant", text: "Coordinate launch comms", timestamp: now - 4_000 }),
      ],
    });
    const cfg = createConfig({
      workspaceDir,
      indexPath,
      sidecarPath,
      retention: { messageDays: 30, maxMessagesPerSession: 1, summaryMaxChars: 160 },
    });
    manager = await getRequiredManager(cfg);

    await manager.sync?.({ reason: "test", force: true });
    const sqliteStatus = manager.status().custom?.sqliteMemory;
    expect(sqliteStatus?.rowCounts?.messages).toBe(1);
    expect(sqliteStatus?.rowCounts?.summaries).toBeGreaterThan(0);

    const results = await manager.search("rollout checklist", {
      sessionKey: "agent:main:discord:dm:user-3",
      maxResults: 3,
    });
    expect(results.some((entry) => entry.path === "sessions/session-prune.jsonl")).toBe(true);
  });

  it("falls back to the existing backend when the sidecar DB is locked", async () => {
    await writeSessionFixture({
      stateDir,
      sessionKey: "agent:main:discord:dm:user-4",
      sessionId: "session-locked",
      lines: [buildMessage({ role: "user", text: "Alpha launch is Tuesday" })],
    });
    const cfg = createConfig({ workspaceDir, indexPath, sidecarPath });
    manager = await getRequiredManager(cfg);
    await manager.sync?.({ reason: "test", force: true });

    const { DatabaseSync } = requireNodeSqlite();
    const lockDb = new DatabaseSync(sidecarPath);
    lockDb.exec("PRAGMA busy_timeout = 1");
    lockDb.exec("BEGIN IMMEDIATE");
    try {
      await manager.sync?.({ reason: "locked", force: true });
      const results = await manager.search("alpha launch", { maxResults: 3 });
      expect(results.some((entry) => entry.path === "memory/2026-03-09.md")).toBe(true);
      expect(manager.status().custom?.sqliteMemory?.degraded).toBe(true);
    } finally {
      lockDb.exec("ROLLBACK");
      lockDb.close();
    }
  });
});
