export class SerpApiProvider {
  constructor(params = {}) {
    this.id = "serpapi";
    this.apiKey = params.apiKey || process.env.SERPAPI_API_KEY || "";
    this.baseUrl = params.baseUrl || "https://serpapi.com/search.json";
  }

  async search(query, recencyDays, maxResults) {
    if (!this.apiKey) return [];
    const url = new URL(this.baseUrl);
    url.searchParams.set("engine", "google");
    url.searchParams.set("q", query);
    url.searchParams.set("num", String(Math.max(1, maxResults)));
    url.searchParams.set("api_key", this.apiKey);
    if (recencyDays <= 30) url.searchParams.set("tbs", `qdr:${recencyDays <= 7 ? "w" : "m"}`);

    const response = await fetch(url);
    if (!response.ok) throw new Error(`SerpAPI search failed (${response.status})`);
    const payload = await response.json();
    const items = payload?.organic_results || [];
    return items.map((item) => ({
      title: item.title || "Untitled",
      url: item.link || "",
      snippet: item.snippet || "",
      published: item.date || "unknown",
      source: "serpapi",
    }));
  }
}
