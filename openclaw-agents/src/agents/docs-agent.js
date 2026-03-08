import { createAgentResult } from "../core/types.js";

export class DocsAgent {
  constructor(params = {}) {
    this.id = "docs";
    this.toolProxy = params.toolProxy;
  }

  async run(task, context) {
    this.toolProxy?.assertAllowed(this.id, "read_workspace");

    const doc = [
      "# Documentation Update",
      "",
      "## Purpose",
      String(task || "Document requested behavior."),
      "",
      "## Usage",
      "1. Run the orchestrator with multi-agent mode enabled.",
      "2. Review generated artifacts and approvals.",
      "3. Execute suggested commands in a controlled environment.",
      "",
      "## Notes",
      "- Keep summaries compact.",
      "- Include citations for web-derived claims.",
    ].join("\n");

    return createAgentResult({
      status: "success",
      summary: "Prepared concise documentation content with purpose, usage steps, and operational notes.",
      citations: [],
      artifacts: [{ type: "doc", content: doc }],
      memory_suggestions: [
        {
          key: `docs:last_topic:${context?.task_id || "unknown"}`,
          value: summarizeTopic(task),
          ttl: "short",
        },
      ],
      followups: ["Have technical owner validate examples before publishing."],
    });
  }
}

function summarizeTopic(task) {
  const text = String(task || "").trim();
  if (!text) return "general-docs";
  return text.slice(0, 60);
}
