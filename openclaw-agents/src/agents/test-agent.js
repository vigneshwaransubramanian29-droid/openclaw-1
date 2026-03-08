import { createAgentResult } from "../core/types.js";

function deriveSuite(task) {
  const text = String(task || "").toLowerCase();
  if (text.includes("router")) return "routing";
  if (text.includes("search")) return "search";
  if (text.includes("context")) return "context";
  if (text.includes("agent")) return "agents";
  return "unit";
}

export class TestAgent {
  constructor(params = {}) {
    this.id = "test";
    this.toolProxy = params.toolProxy;
  }

  async run(task, context) {
    this.toolProxy?.assertAllowed(this.id, "read_workspace");
    this.toolProxy?.assertAllowed(this.id, "run_tests");

    const suite = deriveSuite(task);
    const testDoc = [
      "## Suggested Tests",
      `1. Happy path for ${suite}.`,
      "2. Invalid input and edge cases.",
      "3. Regression coverage for existing behavior.",
      "",
      "## Command",
      `npm test -- ${suite}`,
    ].join("\n");

    return createAgentResult({
      status: "success",
      summary: `Generated test plan and command for ${suite} coverage, including regression checks for legacy flow.`,
      citations: [],
      artifacts: [
        { type: "doc", content: testDoc },
        { type: "command", content: `npm test -- ${suite}` },
      ],
      memory_suggestions: [
        {
          key: `tests:last_suite:${context?.task_id || "unknown"}`,
          value: suite,
          ttl: "short",
        },
      ],
      followups: ["Execute tests and report failures with exact traces."],
    });
  }
}
