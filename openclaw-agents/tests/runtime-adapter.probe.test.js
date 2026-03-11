import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createSystem } from "../src/index.js";

function makeTempDbPath(name) {
  return path.join(os.tmpdir(), `openclaw-agents-${name}-${Date.now()}-${Math.random()}.sqlite`);
}

function cleanupDb(filePath) {
  for (const suffix of ["", "-shm", "-wal"]) {
    const current = `${filePath}${suffix}`;
    if (fs.existsSync(current)) {
      fs.unlinkSync(current);
    }
  }
}

test("spawn probe failure forces degraded direct-only mode", async () => {
  const dbPath = makeTempDbPath("probe");
  const system = await createSystem({
    journalPath: dbPath,
    spawnSubagent: async () => {
      throw new Error("spawn contract mismatch");
    },
  });

  try {
    assert.equal(system.runtimeAdapter.getFeatureFlags().subagents, false);
    assert.equal(system.runtimeAdapter.getFeatureFlags().recovery, false);
    assert.equal(system.messageBus.isDirectOnly(), true);
  } finally {
    await system.close();
    cleanupDb(dbPath);
  }
});
