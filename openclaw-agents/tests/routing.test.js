import test from "node:test";
import assert from "node:assert/strict";
import { TaskRouter } from "../src/core/task-router.js";

function createRouter() {
  return new TaskRouter({
    keywords: {
      latest: ["latest", "current", "version", "pricing"],
      build: ["build", "implement", "refactor"],
      docs: ["docs", "readme", "documentation"],
      debug: ["error", "stacktrace", "failing", "exception"],
      test: ["test", "regression"],
    },
    rules: [
      {
        id: "latest-first",
        when_any: ["latest", "current", "version", "pricing"],
        prepend_agents: ["search"],
        intent: "research",
      },
      {
        id: "build-pipeline",
        when_any: ["build", "implement", "refactor"],
        select_agents: ["planner", "code", "test", "docs"],
        intent: "build",
      },
      {
        id: "debug-route",
        when_any: ["error", "stacktrace", "failing", "exception"],
        select_agents: ["debug", "test"],
        intent: "debug",
      },
    ],
  });
}

test("routing: latest queries prioritize search", () => {
  const router = createRouter();
  const route = router.route("latest pricing for provider x", {});
  assert.equal(route.intent, "research");
  assert.equal(route.selectedAgents[0], "search");
  assert.ok(route.reasons.some((reason) => reason.includes("rule:latest-first")));
});

test("routing: build request yields planner->code->test->docs", () => {
  const router = createRouter();
  const route = router.route("build and implement new feature", {});
  assert.equal(route.intent, "build");
  assert.deepEqual(route.selectedAgents, ["planner", "code", "test", "docs"]);
});

test("routing: debug request includes debug + test", () => {
  const router = createRouter();
  const route = router.route("stacktrace error failing in production", {});
  assert.equal(route.intent, "debug");
  assert.ok(route.selectedAgents.includes("debug"));
  assert.ok(route.selectedAgents.includes("test"));
});

test("routing: lightweight general request can stay self-handled", () => {
  const router = createRouter();
  const route = router.route("summarize this", {});
  assert.equal(route.intent, "general");
  assert.equal(Array.isArray(route.selectedAgents), true);
});
