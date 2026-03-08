import { createAgentResult } from "../core/types.js";

function extractError(task, context) {
  const text = [task, JSON.stringify(context?.logs || {})].filter(Boolean).join("\n");
  const lines = text.split(/\n/).map((line) => line.trim());
  return (
    lines.find((line) => /(error|exception|failed|traceback|stack)/i.test(line)) ||
    "No explicit error signature provided."
  );
}

export class DebugAgent {
  constructor(params = {}) {
    this.id = "debug";
    this.toolProxy = params.toolProxy;
  }

  async run(task, context) {
    this.toolProxy?.assertAllowed(this.id, "read_workspace");

    const signature = extractError(task, context);
    const doc = [
      "## Debug Triage",
      `- Signature: ${signature}`,
      "- Scope the failing component.",
      "- Reproduce with deterministic inputs.",
      "- Add targeted logs around boundary conditions.",
      "- Validate fix with regression tests.",
    ].join("\n");

    return createAgentResult({
      status: "success",
      summary: "Captured error signature and produced a deterministic debug checklist with test-first validation guidance.",
      citations: [],
      artifacts: [{ type: "doc", content: doc }],
      memory_suggestions: [
        {
          key: `debug:last_signature:${context?.task_id || "unknown"}`,
          value: signature,
          ttl: "short",
        },
      ],
      followups: ["If issue matches known external bug, run SearchAgent for known fixes."],
    });
  }
}
