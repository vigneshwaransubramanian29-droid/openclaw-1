import { createAgentResult } from "../core/types.js";

const STOP_WORDS = new Set([
  "the",
  "a",
  "an",
  "for",
  "to",
  "of",
  "and",
  "in",
  "on",
  "with",
  "is",
  "are",
  "be",
  "that",
  "this",
  "it",
  "by",
  "or",
  "from",
  "as",
  "at",
]);

function clampWords(text, maxWords) {
  const words = String(text || "").trim().split(/\s+/).filter(Boolean);
  if (words.length <= maxWords) return words.join(" ");
  return `${words.slice(0, maxWords).join(" ")}...`;
}

function dedupe(input) {
  return [...new Set(input.filter(Boolean).map((v) => v.trim()))];
}

function looksLikeLatestRequest(text) {
  return /(latest|current|now|new release|breaking change|pricing|version|today|recent)/i.test(text);
}

function buildQueries(task) {
  const raw = String(task || "").trim();
  if (!raw) return [];

  const quoted = [...raw.matchAll(/"([^"]+)"/g)].map((m) => m[1]).filter(Boolean);
  if (quoted.length > 0) return dedupe(quoted).slice(0, 3);

  const terms = raw
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t && !STOP_WORDS.has(t));
  const base = clampWords(terms.join(" "), 14);

  const out = [base];
  if (/(api|sdk|docs|documentation|reference)/i.test(raw)) {
    out.push(`${base} site:docs.* OR site:github.com`);
  }
  if (/(standard|spec|rfc|protocol|http|oauth|tls)/i.test(raw)) {
    out.push(`${base} site:ietf.org OR site:w3.org`);
  }
  if (looksLikeLatestRequest(raw)) {
    out.push(`${base} release notes`);
  }
  return dedupe(out).slice(0, 3);
}

function recommendedAgent(task) {
  const text = String(task || "").toLowerCase();
  if (/(build|implement|refactor|create)/i.test(text)) return "code";
  if (/(test|failing|regression)/i.test(text)) return "test";
  if (/(docs|readme|document)/i.test(text)) return "docs";
  if (/(error|exception|stacktrace|bug)/i.test(text)) return "debug";
  return "planner";
}

export class SearchAgent {
  constructor(params = {}) {
    this.id = "search";
    this.webSearchService = params.webSearchService;
    this.toolProxy = params.toolProxy;
    this.maxContextTokens = params.maxContextTokens || 600;
    this.maxOutputTokens = params.maxOutputTokens || 350;
  }

  async run(task, context = {}) {
    this.toolProxy?.assertAllowed(this.id, "web_search");
    this.toolProxy?.assertAllowed(this.id, "read_workspace");

    const taskText = String(task || "").slice(0, 2400);
    const queries = buildQueries(taskText);
    if (queries.length === 0) {
      return createAgentResult({
        status: "needs_more_info",
        summary: "Need a clearer search target to generate useful citations.",
        citations: [],
        artifacts: [{ type: "query", content: "No valid query extracted." }],
        memory_suggestions: [],
        followups: ["Provide product/topic and what decision you need to make."],
      });
    }

    const latestIntent = looksLikeLatestRequest(taskText);
    const recencyDays = latestIntent ? 30 : 365;
    const searchResult = await this.webSearchService.search({
      task: taskText,
      queries,
      recencyDays,
      maxResults: 10,
      latestIntent,
    });

    const citations = (searchResult.citations || []).slice(0, 7);
    if (citations.length === 0) {
      return createAgentResult({
        status: "needs_more_info",
        summary: "Search returned no high-confidence results.",
        citations: [],
        artifacts: [{ type: "query", content: JSON.stringify({ queries, recencyDays }) }],
        memory_suggestions: [],
        followups: ["Refine scope with product/version/domain constraints."],
      });
    }

    const summary = clampWords(
      citations
        .slice(0, 4)
        .map((item) => item.snippet || item.title)
        .join(" "),
      80,
    );

    return createAgentResult({
      status: "success",
      summary,
      citations: citations.slice(0, Math.max(3, Math.min(7, citations.length))),
      artifacts: [
        {
          type: "query",
          content: JSON.stringify(
            {
              queries,
              recencyDays,
              provider: searchResult.provider,
              max_context_tokens: this.maxContextTokens,
              max_output_tokens: this.maxOutputTokens,
            },
            null,
            2,
          ),
        },
      ],
      memory_suggestions: [
        {
          key: `search:last:${context.task_id || "unknown"}`,
          value: { queries, topUrls: citations.map((c) => c.url) },
          ttl: "short",
        },
      ],
      followups: [`Recommended next agent: ${recommendedAgent(taskText)}`],
    });
  }
}
