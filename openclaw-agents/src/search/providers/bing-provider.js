function freshness(recencyDays) {
  if (recencyDays <= 1) return "Day";
  if (recencyDays <= 7) return "Week";
  if (recencyDays <= 31) return "Month";
  return "";
}

export class BingSearchProvider {
  constructor(params = {}) {
    this.id = "bing";
    this.apiKey = params.apiKey || process.env.BING_SEARCH_API_KEY || "";
    this.baseUrl = params.baseUrl || "https://api.bing.microsoft.com/v7.0/search";
  }

  async search(query, recencyDays, maxResults) {
    if (!this.apiKey) return [];
    const url = new URL(this.baseUrl);
    url.searchParams.set("q", query);
    url.searchParams.set("count", String(Math.max(1, maxResults)));
    const fresh = freshness(recencyDays);
    if (fresh) url.searchParams.set("freshness", fresh);

    const response = await fetch(url, {
      headers: {
        "Ocp-Apim-Subscription-Key": this.apiKey,
      },
    });
    if (!response.ok) throw new Error(`Bing search failed (${response.status})`);
    const payload = await response.json();
    const items = payload?.webPages?.value || [];
    return items.map((item) => ({
      title: item.name || "Untitled",
      url: item.url || "",
      snippet: item.snippet || "",
      published: item.dateLastCrawled ? String(item.dateLastCrawled).slice(0, 10) : "unknown",
      source: "bing",
    }));
  }
}
