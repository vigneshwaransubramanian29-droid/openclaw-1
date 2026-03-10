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
          },
        },
      },
      list: [{ id: "main", default: true }],
    },
  } as OpenClawConfig;
}

describe("sqlite memory sidecar migration recovery", () => {
  let rootDir = "";
  let workspaceDir = "";
  let stateDir = "";
  let indexPath = "";
  let sidecarPath = "";
  let manager: Awaited<ReturnType<typeof getMemorySearchManager>>["manager"] | null = null;

  beforeEach(async () => {
    resetEmbeddingMocks();
    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-sqlite-sidecar-migrate-"));
    workspaceDir = path.join(rootDir, "workspace");
    stateDir = path.join(rootDir, "state");
    indexPath = path.join(rootDir, "memory-index.sqlite");
    sidecarPath = path.join(rootDir, "memory-sidecar.sqlite");
    await fs.mkdir(path.join(workspaceDir, "memory"), { recursive: true });
    await fs.writeFile(
      path.join(workspaceDir, "memory", "2026-03-09.md"),
      "- Alpha launch is Tuesday\n- [ ] Ship alpha release",
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

  it("backs up an unsupported sidecar schema and falls back to the existing backend", async () => {
    const { DatabaseSync } = requireNodeSqlite();
    const db = new DatabaseSync(sidecarPath);
    db.exec("PRAGMA user_version = 99");
    db.close();

    const cfg = createConfig({ workspaceDir, indexPath, sidecarPath });
    const result = await getMemorySearchManager({ cfg, agentId: "main" });
    manager = result.manager;
    expect(result.manager).toBeTruthy();
    if (!result.manager) {
      throw new Error("manager missing");
    }

    await result.manager.sync?.({ reason: "test", force: true });
    const searchResults = await result.manager.search("alpha launch", { maxResults: 3 });
    expect(searchResults.some((entry) => entry.path === "memory/2026-03-09.md")).toBe(true);

    const sqliteStatus = result.manager.status().custom?.sqliteMemory;
    expect(sqliteStatus?.degraded).toBe(true);
    expect(sqliteStatus?.lastError).toMatch(/schema/i);

    const backups = (await fs.readdir(rootDir)).filter((entry) =>
      entry.startsWith("memory-sidecar.sqlite.backup-"),
    );
    expect(backups.length).toBeGreaterThan(0);

    await result.manager.close?.();
    manager = null;
  });
});
