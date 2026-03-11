function escapeRegex(input) {
  return String(input || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasTerm(text, term) {
  const normalized = String(term || "").trim().toLowerCase();
  if (!normalized) return false;
  if (normalized.includes(" ")) {
    return text.includes(normalized);
  }
  const pattern = new RegExp(`\\b${escapeRegex(normalized)}\\b`, "i");
  return pattern.test(text);
}

function includesAny(text, terms = []) {
  return terms.some((term) => hasTerm(text, term));
}

function includesAll(text, terms = []) {
  return terms.every((term) => hasTerm(text, term));
}

function scoreHits(text, terms = []) {
  return terms.reduce((sum, term) => (hasTerm(text, term) ? sum + 1 : sum), 0);
}

function dedupe(items) {
  return [...new Set((items || []).filter(Boolean))];
}

function normalizeList(value) {
  return Array.isArray(value) ? value.map((item) => String(item || "").toLowerCase()) : [];
}

export class TaskRouter {
  constructor(config = {}) {
    this.config = config;
    this.thresholds = config.thresholds || { high: 0.75, medium: 0.5 };
    this.keywords = config.keywords || {};
    this.rules = Array.isArray(config.rules) ? config.rules : [];
  }

  classify(task) {
    const text = String(task || "").toLowerCase();
    const hits = {
      latest: scoreHits(text, this.keywords.latest || []),
      build: scoreHits(text, this.keywords.build || []),
      docs: scoreHits(text, this.keywords.docs || []),
      debug: scoreHits(text, this.keywords.debug || []),
      test: scoreHits(text, this.keywords.test || []),
    };

    const latestIntent = hits.latest > 0;
    const buildIntent = hits.build > 0;
    const docsIntent = hits.docs > 0 && !buildIntent;
    const debugIntent = hits.debug > 0;
    const testIntent = hits.test > 0;

    const wordCount = text.trim().split(/\s+/).filter(Boolean).length;
    const complexityScore =
      (buildIntent ? 0.35 : 0) +
      (debugIntent ? 0.25 : 0) +
      (docsIntent ? 0.15 : 0) +
      (testIntent ? 0.15 : 0) +
      (wordCount > 40 ? 0.2 : 0) +
      (wordCount > 120 ? 0.2 : 0);
    const complexity =
      complexityScore >= 0.75 ? "high" : complexityScore >= 0.45 ? "medium" : "low";

    const reasons = [];
    if (latestIntent) reasons.push("latest/current signal detected");
    if (buildIntent) reasons.push("build/implement signal detected");
    if (docsIntent) reasons.push("documentation signal detected");
    if (debugIntent) reasons.push("debug/error signal detected");
    if (testIntent) reasons.push("testing signal detected");
    if (reasons.length === 0) reasons.push("default lightweight handling");

    return {
      latestIntent,
      buildIntent,
      docsIntent,
      debugIntent,
      testIntent,
      complexity,
      complexityScore,
      reasons,
    };
  }

  applyRules(task, baseRoute) {
    const text = String(task || "").toLowerCase();
    const selectedAgents = [...(baseRoute.selectedAgents || [])];
    let intent = baseRoute.intent;
    let doSelf = baseRoute.doSelf;
    const reasons = [...(baseRoute.reasons || [])];

    for (const rule of this.rules) {
      const whenAny = normalizeList(rule.when_any);
      const whenAll = normalizeList(rule.when_all);
      const excludeAny = normalizeList(rule.exclude_any);

      if (whenAny.length > 0 && !includesAny(text, whenAny)) continue;
      if (whenAll.length > 0 && !includesAll(text, whenAll)) continue;
      if (excludeAny.length > 0 && includesAny(text, excludeAny)) continue;

      if (Array.isArray(rule.prepend_agents) && rule.prepend_agents.length > 0) {
        selectedAgents.unshift(...rule.prepend_agents);
      }
      if (Array.isArray(rule.select_agents) && rule.select_agents.length > 0) {
        selectedAgents.push(...rule.select_agents);
      }
      if (typeof rule.intent === "string" && rule.intent.trim()) {
        intent = rule.intent.trim();
      }
      if (typeof rule.force_do_self === "boolean") {
        doSelf = rule.force_do_self;
      }
      if (rule.id) reasons.push(`rule:${rule.id}`);
    }

    const deduped = dedupe(selectedAgents);
    return {
      ...baseRoute,
      intent,
      selectedAgents: deduped,
      doSelf: doSelf || deduped.length === 0,
      reasons: dedupe(reasons),
    };
  }

  route(task, constraints = {}) {
    const classified = this.classify(task);
    const selectedAgents = [];

    if (classified.buildIntent) {
      selectedAgents.push("planner");
      if (classified.latestIntent || includesAny(String(task).toLowerCase(), ["unknown", "investigate"])) {
        selectedAgents.push("search");
      }
      selectedAgents.push("code");
      selectedAgents.push("test");
      if (!constraints.skipDocs) selectedAgents.push("docs");
    } else if (classified.docsIntent) {
      if (classified.latestIntent) selectedAgents.push("search");
      selectedAgents.push("docs");
    } else if (classified.debugIntent) {
      selectedAgents.push("debug");
      if (classified.latestIntent || !constraints.offlineOnly) selectedAgents.push("search");
      if (!constraints.skipTests) selectedAgents.push("test");
    } else if (classified.latestIntent) {
      selectedAgents.push("search");
    } else if (classified.testIntent) {
      selectedAgents.push("test");
    } else if (classified.complexity !== "low") {
      selectedAgents.push("planner");
    }

    const dedupedAgents = dedupe(selectedAgents);
    const confidence = Math.min(
      0.95,
      0.4 + (dedupedAgents.length > 0 ? 0.25 : 0) + Math.min(classified.complexityScore, 0.3),
    );

    const heuristicRoute = {
      intent: classified.buildIntent
        ? "build"
        : classified.docsIntent
          ? "docs"
          : classified.debugIntent
            ? "debug"
            : classified.latestIntent
              ? "research"
              : "general",
      complexity: classified.complexity,
      confidence,
      latestIntent: classified.latestIntent,
      selectedAgents: dedupedAgents,
      reasons: classified.reasons,
      doSelf: dedupedAgents.length === 0,
    };
    return this.applyRules(task, heuristicRoute);
  }
}
