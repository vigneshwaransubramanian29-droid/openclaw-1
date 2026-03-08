import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WorkspaceStore } from "../src/core/workspace-store.js";
import { WebSearchService } from "../src/search/web-search-service.js";
import { MockSearchProvider } from "../src/search/providers/mock-provider.js";

function makeTempStorePath(name) {
  return path.join(os.tmpdir(), `openclaw-agents-${name}-${Date.now()}.json`);
}

test("web search dedupes canonical URLs and caches repeated queries", async () => {
  const storePath = makeTempStorePath("search");
  const store = new WorkspaceStore({ filePath: storePath, maxEntries: 100 });

  const provider = new MockSearchProvider({
    id: "mock",
    lookup: async () => [
      {
        title: "Official docs",
        url: "https://docs.example.com/page?a=1&utm_source=foo",
        snippet: "authoritative docs page",
        published: "2026-02-25",
      },
      {
        title: "Official docs (duplicate)",
        url: "https://docs.example.com/page?a=1&utm_medium=bar",
        snippet: "duplicate url with tracking params",
        published: "2026-02-25",
      },
      {
        title: "Release notes",
        url: "https://github.com/org/repo/releases/tag/v1.0.1",
        snippet: "latest release notes",
        published: "2026-02-27",
      },
    ],
  });

  const service = new WebSearchService({
    providers: { mock: provider },
    defaultProvider: "mock",
    cacheTtlHours: 24,
    workspaceStore: store,
    minStrongResults: 1,
  });

  const first = await service.search({
    task: "latest project release notes",
    queries: ["project release notes"],
    latestIntent: true,
    recencyDays: 30,
    maxResults: 8,
  });

  assert.ok(first.citations.length >= 2);
  assert.equal(provider.calls > 0, true);

  const callsAfterFirst = provider.calls;
  const second = await service.search({
    task: "latest project release notes",
    queries: ["project release notes"],
    latestIntent: true,
    recencyDays: 30,
    maxResults: 8,
  });

  assert.equal(provider.calls, callsAfterFirst);
  assert.ok(second.cacheHits >= 1);
  assert.ok(second.citations.some((citation) => citation.url.includes("docs.example.com/page?a=1")));

  if (fs.existsSync(storePath)) fs.unlinkSync(storePath);
});
