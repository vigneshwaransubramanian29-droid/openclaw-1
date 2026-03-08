export class OpenClawToolProvider {
  constructor(params = {}) {
    this.id = "openclaw";
    this.searchFn = params.searchFn;
  }

  async search(query, recencyDays, maxResults) {
    if (typeof this.searchFn !== "function") return [];
    const out = await this.searchFn({ query, recencyDays, maxResults });
    if (!Array.isArray(out)) return [];
    return out.map((item) => ({
      title: item.title || "Untitled",
      url: item.url || "",
      snippet: item.snippet || item.description || "",
      published: item.published || "unknown",
      source: item.source || "openclaw-tool",
    }));
  }
}
