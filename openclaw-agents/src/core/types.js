export const AGENT_STATUSES = Object.freeze({
  SUCCESS: "success",
  NEEDS_MORE_INFO: "needs_more_info",
  FAILED: "failed",
});

export function clampWords(input, maxWords) {
  if (!input) return "";
  const words = String(input).trim().split(/\s+/);
  if (words.length <= maxWords) return words.join(" ");
  return `${words.slice(0, maxWords).join(" ")}...`;
}

export function estimateTokens(value) {
  if (value == null) return 0;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return Math.ceil(text.length / 4);
}

export function normalizeCitation(citation) {
  return {
    title: citation?.title ? String(citation.title) : "Untitled",
    url: citation?.url ? String(citation.url) : "",
    snippet: clampWords(citation?.snippet || "", 40),
    published: citation?.published ? String(citation.published) : "unknown",
  };
}

export function createAgentResult(result) {
  return {
    status: result?.status || AGENT_STATUSES.SUCCESS,
    summary: clampWords(result?.summary || "No summary provided.", 80),
    citations: Array.isArray(result?.citations)
      ? result.citations.map(normalizeCitation).filter((item) => item.url)
      : [],
    artifacts: Array.isArray(result?.artifacts) ? result.artifacts : [],
    memory_suggestions: Array.isArray(result?.memory_suggestions)
      ? result.memory_suggestions
      : [],
    followups: Array.isArray(result?.followups) ? result.followups : [],
  };
}
