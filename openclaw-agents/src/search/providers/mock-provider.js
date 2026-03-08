export class MockSearchProvider {
  constructor(params = {}) {
    this.id = params.id || "mock";
    this.lookup = params.lookup || (() => []);
    this.calls = 0;
  }

  async search(query, recencyDays, maxResults) {
    this.calls += 1;
    const results = await this.lookup(query, recencyDays, maxResults);
    return Array.isArray(results) ? results : [];
  }
}
