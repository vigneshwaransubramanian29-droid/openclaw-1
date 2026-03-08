export class BraveSearchProvider {
  constructor(params = {}) {
    this.id = "brave";
    this.apiKey = params.apiKey || process.env.BRAVE_SEARCH_API_KEY || "";
    this.baseUrl = params.baseUrl || "https://api.search.brave.com/res/v1/web/search";
  }

  async search(query, recencyDays, maxResults) {
    if (!this.apiKey) return [];
    const url = new URL(this.baseUrl);
    url.searchParams.set("q", query);
    url.searchParams.set("count", String(Math.max(1, maxResults)));
    if (recencyDays <= 30) url.searchParams.set("freshness", "pw");

    const response = await fetch(url, {
      headers: {
        Accept: "application/json",
        "X-Subscription-Token": this.apiKey,
      },
    });
    if (!response.ok) throw new Error(`Brave search failed (${response.status})`);
    const payload = await response.json();
    const items = payload?.web?.results || [];
    return items.map((item) => ({
      title: item.title || "Untitled",
      url: item.url || "",
      snippet: item.description || "",
      published: item.page_age || "unknown",
      source: "brave",
    }));
  }
}
