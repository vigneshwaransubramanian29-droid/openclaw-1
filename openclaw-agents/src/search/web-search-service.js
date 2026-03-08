import { normalizeCitation } from "../core/types.js";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function canonicalizeUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    url.hash = "";
    const remove = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "ref"];
    for (const key of remove) url.searchParams.delete(key);
    return `${url.origin}${url.pathname}${url.search}`;
  } catch {
    return String(rawUrl || "").trim();
  }
}

function getHostname(rawUrl) {
  try {
    return new URL(rawUrl).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function tokenize(input) {
  return String(input || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function jaccard(a, b) {
  const setA = new Set(tokenize(a));
  const setB = new Set(tokenize(b));
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const token of setA) {
    if (setB.has(token)) intersection += 1;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function parseDate(value) {
  if (!value || value === "unknown") return null;
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? null : timestamp;
}

function dedupeItems(items, titleSimilarityThreshold = 0.92) {
  const deduped = [];
  const seenCanonical = new Set();

  for (const item of items || []) {
    const normalizedUrl = canonicalizeUrl(item.url);
    if (!normalizedUrl) continue;
    const canonicalKey = normalizedUrl.toLowerCase();

    if (seenCanonical.has(canonicalKey)) continue;
    const hasNearTitle = deduped.some(
      (existing) =>
        canonicalizeUrl(existing.url).toLowerCase() === canonicalKey ||
        jaccard(existing.title || "", item.title || "") >= titleSimilarityThreshold,
    );
    if (hasNearTitle) continue;

    seenCanonical.add(canonicalKey);
    deduped.push({ ...item, url: normalizedUrl });
  }
  return deduped;
}

function dedupeStrings(values, max = 8) {
  const out = [];
  const seen = new Set();
  for (const raw of values || []) {
    const value = String(raw || "").trim();
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
    if (out.length >= max) break;
  }
  return out;
}

function isDocumentationQuery(query) {
  return /(doc|docs|reference|api|sdk)/i.test(query || "");
}

function isStandardsQuery(query) {
  return /(standard|spec|rfc|protocol|oauth|tls|http)/i.test(query || "");
}

function normalizeProviderItems(items, providerId) {
  return (Array.isArray(items) ? items : []).map((item) => ({
    title: item?.title || "Untitled",
    url: item?.url || "",
    snippet: item?.snippet || item?.description || "",
    published: item?.published || item?.date || "unknown",
    source: item?.source || providerId,
  }));
}

export class WebSearchService {
  constructor(params = {}) {
    this.providers = params.providers || {};
    this.defaultProvider = params.defaultProvider || Object.keys(this.providers)[0];
    this.providerOrder = Array.isArray(params.providerOrder) ? params.providerOrder : [];
    this.cacheTtlMs = (params.cacheTtlHours || 24) * 60 * 60 * 1000;
    this.workspaceStore = params.workspaceStore;
    this.retries = Number.isFinite(params.retries) ? params.retries : 2;
    this.rateLimits = params.rateLimits || {};
    this.providerCallHistory = new Map();
    this.synonyms = params.synonyms || {};
    this.operatorTemplates = params.operatorTemplates || {};
    this.fallbackQuerySuffixes = Array.isArray(params.fallbackQuerySuffixes)
      ? params.fallbackQuerySuffixes
      : ["official docs", "release notes"];
    this.authoritativeDomains = Array.isArray(params.authoritativeDomains)
      ? params.authoritativeDomains.map((d) => String(d).toLowerCase())
      : ["docs.", "github.com", "ietf.org", "w3.org", ".gov", ".edu"];
    this.minStrongResults = Number.isFinite(params.minStrongResults) ? params.minStrongResults : 3;
    this.titleSimilarityThreshold = Number.isFinite(params.titleSimilarityThreshold)
      ? params.titleSimilarityThreshold
      : 0.92;
  }

  #cacheKey(providerId, query, recencyDays, maxResults) {
    return `${providerId}:${query}:${recencyDays}:${maxResults}`.toLowerCase();
  }

  #resolveProviderSequence(preferredProvider) {
    const sequence = [];
    if (preferredProvider) sequence.push(preferredProvider);
    if (this.defaultProvider) sequence.push(this.defaultProvider);
    sequence.push(...this.providerOrder);
    sequence.push(...Object.keys(this.providers));
    return dedupeStrings(sequence, 10).filter((id) => this.providers[id]);
  }

  #expandQuery(query, latestIntent) {
    const base = String(query || "").trim();
    if (!base) return [];

    const expanded = [base];
    const lowerTokens = new Set(tokenize(base));
    for (const [term, aliases] of Object.entries(this.synonyms || {})) {
      if (!lowerTokens.has(String(term).toLowerCase())) continue;
      for (const alias of aliases || []) {
        expanded.push(`${base} ${alias}`);
      }
    }

    if (isDocumentationQuery(base)) {
      for (const op of this.operatorTemplates.documentation || []) {
        expanded.push(`${base} ${op}`);
      }
    }
    if (isStandardsQuery(base)) {
      for (const op of this.operatorTemplates.standards || []) {
        expanded.push(`${base} ${op}`);
      }
    }
    if (latestIntent) {
      for (const suffix of this.fallbackQuerySuffixes) {
        expanded.push(`${base} ${suffix}`);
      }
    }
    return dedupeStrings(expanded, 6);
  }

  #authorityScore(url) {
    const host = getHostname(url);
    if (!host) return 0.2;
    for (const domain of this.authoritativeDomains) {
      if (domain.startsWith(".") && host.endsWith(domain)) return 1.0;
      if (domain.endsWith(".") && host.includes(domain)) return 0.95;
      if (host === domain || host.endsWith(`.${domain}`) || host.includes(domain)) return 0.95;
    }
    if (host.includes("wikipedia.org")) return 0.7;
    if (host.includes("medium.com") || host.includes("substack.com")) return 0.45;
    return 0.6;
  }

  #relevanceScore(result, queries) {
    const text = `${result.title || ""} ${result.snippet || ""}`;
    const tokens = tokenize(text);
    if (tokens.length === 0) return 0;
    const set = new Set(tokens);
    let best = 0;
    for (const query of queries || []) {
      const queryTokens = tokenize(query);
      if (queryTokens.length === 0) continue;
      let matches = 0;
      for (const token of queryTokens) {
        if (set.has(token)) matches += 1;
      }
      best = Math.max(best, matches / queryTokens.length);
    }
    return best;
  }

  #recencyScore(published, latestIntent) {
    if (!latestIntent) return 0.5;
    const date = parseDate(published);
    if (!date) return 0.2;
    const ageDays = (Date.now() - date) / (24 * 60 * 60 * 1000);
    if (ageDays <= 7) return 1.0;
    if (ageDays <= 30) return 0.85;
    if (ageDays <= 90) return 0.65;
    if (ageDays <= 365) return 0.45;
    return 0.25;
  }

  async #respectRateLimit(providerId) {
    const limit = this.rateLimits[providerId]?.requests_per_minute;
    if (!limit || !Number.isFinite(limit) || limit <= 0) return;
    const windowMs = 60_000;
    const now = Date.now();
    const recent = (this.providerCallHistory.get(providerId) || []).filter((t) => now - t < windowMs);
    if (recent.length >= limit) {
      const waitMs = windowMs - (now - recent[0]) + 5;
      await sleep(waitMs);
    }
    const updated = (this.providerCallHistory.get(providerId) || []).filter((t) => now - t < windowMs);
    updated.push(Date.now());
    this.providerCallHistory.set(providerId, updated);
  }

  async #searchWithRetries(providerId, query, recencyDays, maxResults) {
    const provider = this.providers[providerId];
    if (!provider || typeof provider.search !== "function") {
      throw new Error(`search provider "${providerId}" is not configured`);
    }

    let attempt = 0;
    let lastError = null;
    while (attempt <= this.retries) {
      try {
        await this.#respectRateLimit(providerId);
        return await provider.search(query, recencyDays, maxResults);
      } catch (error) {
        lastError = error;
        if (attempt === this.retries) break;
        await sleep(150 * 2 ** attempt);
      }
      attempt += 1;
    }
    throw lastError;
  }

  buildQueries(task, options = {}) {
    const raw = String(task || "").replace(/\s+/g, " ").trim();
    const explicit = Array.isArray(options.queries) ? options.queries.filter(Boolean) : [];
    const seed = explicit.length > 0 ? explicit : [raw];
    const expanded = [];
    for (const query of seed) {
      expanded.push(...this.#expandQuery(query, !!options.latestIntent));
    }
    return dedupeStrings(expanded, 8);
  }

  async #searchSingleQuery(query, providerId, recencyDays, maxResults) {
    const providers = this.#resolveProviderSequence(providerId);
    let cacheHits = 0;
    let usedProvider = providers[0];

    for (const currentProvider of providers) {
      const cacheKey = this.#cacheKey(currentProvider, query, recencyDays, maxResults);
      const cached = this.workspaceStore?.get("search_cache", cacheKey);
      if (cached) {
        cacheHits += 1;
        return {
          items: normalizeProviderItems(cached, currentProvider),
          usedProvider: currentProvider,
          cacheHits,
        };
      }

      let fetched = [];
      try {
        fetched = await this.#searchWithRetries(currentProvider, query, recencyDays, maxResults);
      } catch {
        fetched = [];
      }

      const normalized = normalizeProviderItems(fetched, currentProvider);
      this.workspaceStore?.put("search_cache", cacheKey, normalized, {
        ttl: this.cacheTtlMs,
        tags: ["search", currentProvider],
      });
      usedProvider = currentProvider;
      if (normalized.length > 0) {
        return { items: normalized, usedProvider, cacheHits };
      }
    }

    return { items: [], usedProvider, cacheHits };
  }

  async search(params = {}) {
    const providerId = params.provider || this.defaultProvider;
    const latestIntent = !!params.latestIntent;
    const recencyDays = params.recencyDays || (latestIntent ? 30 : 365);
    const maxResults = params.maxResults || 8;
    const queries = this.buildQueries(params.task || "", {
      queries: params.queries,
      latestIntent,
    });

    const aggregated = [];
    let cacheHits = 0;
    let providerUsed = providerId;

    for (const query of queries) {
      const { items, usedProvider, cacheHits: queryCacheHits } = await this.#searchSingleQuery(
        query,
        providerId,
        recencyDays,
        maxResults,
      );
      providerUsed = usedProvider || providerUsed;
      cacheHits += queryCacheHits;
      aggregated.push(...items);
    }

    if (aggregated.length < this.minStrongResults && queries.length > 0) {
      const fallbackQueries = dedupeStrings(
        queries.slice(0, 2).flatMap((query) =>
          this.fallbackQuerySuffixes.map((suffix) => `${query} ${suffix}`),
        ),
        4,
      );
      for (const fallbackQuery of fallbackQueries) {
        const { items, usedProvider, cacheHits: queryCacheHits } = await this.#searchSingleQuery(
          fallbackQuery,
          providerId,
          recencyDays,
          maxResults,
        );
        providerUsed = usedProvider || providerUsed;
        cacheHits += queryCacheHits;
        aggregated.push(...items);
      }
    }

    const deduped = dedupeItems(aggregated, this.titleSimilarityThreshold);
    const hostCount = new Map();
    for (const item of deduped) {
      const host = getHostname(item.url);
      hostCount.set(host, (hostCount.get(host) || 0) + 1);
    }

    const scored = deduped.map((item) => {
      const authority = this.#authorityScore(item.url);
      const relevance = this.#relevanceScore(item, queries);
      const recency = this.#recencyScore(item.published, latestIntent);
      const duplicationPenalty = Math.max(0, ((hostCount.get(getHostname(item.url)) || 1) - 1) * 0.08);
      const score = authority * 0.38 + relevance * 0.42 + recency * 0.24 - duplicationPenalty;
      return { ...item, score };
    });
    scored.sort((a, b) => b.score - a.score);

    const top = scored.slice(0, Math.min(7, maxResults));
    return {
      queries,
      provider: providerUsed,
      citations: top.map(normalizeCitation),
      cacheHits,
    };
  }
}
