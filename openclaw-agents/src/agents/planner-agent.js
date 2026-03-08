import { createAgentResult } from "../core/types.js";

function extractSteps(task) {
  const chunks = String(task || "")
    .split(/(?:\band\b|,|;|\n)/i)
    .map((v) => v.trim())
    .filter(Boolean);
  if (chunks.length === 0) return ["Clarify objective and acceptance criteria."];
  return chunks.slice(0, 7).map((chunk, idx) => `Step ${idx + 1}: ${chunk}`);
}

function detectRisks(task) {
  const text = String(task || "").toLowerCase();
  const risks = [];
  if (/(latest|current|version|breaking)/i.test(text)) risks.push("May require up-to-date external validation.");
  if (/(refactor|migrate)/i.test(text)) risks.push("Regression risk; must run focused tests.");
  if (/(deploy|production|database|delete)/i.test(text)) risks.push("Potential high-impact side effects require approval.");
  if (risks.length === 0) risks.push("Scope ambiguity; clarify non-functional constraints.");
  return risks.slice(0, 3);
}

export class PlannerAgent {
  constructor() {
    this.id = "planner";
  }

  async run(task, context) {
    const steps = extractSteps(task);
    const risks = detectRisks(task);
    const planDoc = [`# Plan`, ...steps, "", "## Risks", ...risks.map((risk) => `- ${risk}`)].join("\n");

    return createAgentResult({
      status: "success",
      summary: `Planned ${steps.length} steps with key risks identified and a compact execution sequence ready for implementation.`,
      citations: [],
      artifacts: [{ type: "doc", content: planDoc }],
      memory_suggestions: [
        {
          key: `plan:${context?.task_id || "unknown"}`,
          value: { steps, risks },
          ttl: "short",
        },
      ],
      followups: ["Delegate implementation to CodeAgent and validation to TestAgent."],
    });
  }
}
