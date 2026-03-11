function pruneWindow(items, now, windowMs) {
  return items.filter((entry) => now - entry.at <= windowMs);
}

export class HealthTracker {
  constructor(params = {}) {
    this.now = params.now || (() => Date.now());
    this.adapterFailureWindowMs = params.adapterFailureWindowMs || 60_000;
    this.adapterFailureThreshold = params.adapterFailureThreshold || 3;
    this.breaker = {
      consecutiveFailures: params.breaker?.consecutive_failures || 3,
      failureRateThreshold: params.breaker?.failure_rate_threshold || 0.5,
      minimumSamples: params.breaker?.minimum_samples || 4,
      windowMs: params.breaker?.window_ms || 60_000,
    };
    this.degraded = false;
    this.degradedReason = null;
    this.coordinatorFailures = [];
    this.adapterFailures = [];
    this.consecutiveAdapterFailures = 0;
    this.workerStats = new Map();
  }

  forceDegraded(reason, error) {
    if (!this.degraded) {
      this.degraded = true;
      this.degradedReason = reason || "degraded";
    }
    this.coordinatorFailures.push({
      kind: "forced_degraded",
      at: this.now(),
      reason: reason || "degraded",
      error: error?.message || null,
    });
  }

  reportJournalFailure(error) {
    this.coordinatorFailures.push({
      kind: "journal",
      at: this.now(),
      error: error?.message || String(error),
    });
    this.forceDegraded("journal_failure", error);
  }

  reportReducerFailure(error) {
    this.coordinatorFailures.push({
      kind: "reducer",
      at: this.now(),
      error: error?.message || String(error),
    });
    this.forceDegraded("reducer_failure", error);
  }

  reportAdapterFailure(error) {
    const now = this.now();
    this.adapterFailures.push({
      at: now,
      error: error?.message || String(error),
    });
    this.adapterFailures = pruneWindow(this.adapterFailures, now, this.adapterFailureWindowMs);
    this.consecutiveAdapterFailures += 1;
    if (this.consecutiveAdapterFailures >= this.adapterFailureThreshold) {
      this.forceDegraded("adapter_failure_threshold", error);
    }
  }

  reportAdapterSuccess() {
    this.consecutiveAdapterFailures = 0;
  }

  #getWorkerStats(agentId) {
    if (!this.workerStats.has(agentId)) {
      this.workerStats.set(agentId, {
        lastSuccessAt: null,
        consecutiveFailures: 0,
        events: [],
        circuitOpen: false,
      });
    }
    return this.workerStats.get(agentId);
  }

  reportWorkerSuccess(agentId) {
    const stats = this.#getWorkerStats(agentId);
    stats.lastSuccessAt = this.now();
    stats.consecutiveFailures = 0;
    stats.events.push({ at: stats.lastSuccessAt, ok: true });
    stats.events = pruneWindow(stats.events, stats.lastSuccessAt, this.breaker.windowMs);
    stats.circuitOpen = false;
  }

  reportWorkerFailure(agentId) {
    const now = this.now();
    const stats = this.#getWorkerStats(agentId);
    stats.consecutiveFailures += 1;
    stats.events.push({ at: now, ok: false });
    stats.events = pruneWindow(stats.events, now, this.breaker.windowMs);
    const sampleSize = stats.events.length;
    const failureCount = stats.events.filter((entry) => !entry.ok).length;
    const failureRate = sampleSize > 0 ? failureCount / sampleSize : 0;
    stats.circuitOpen =
      stats.consecutiveFailures >= this.breaker.consecutiveFailures ||
      (sampleSize >= this.breaker.minimumSamples &&
        failureRate >= this.breaker.failureRateThreshold);
  }

  isCircuitOpen(agentId) {
    return this.#getWorkerStats(agentId).circuitOpen;
  }

  isDegraded() {
    return this.degraded;
  }

  status() {
    return {
      degraded: this.degraded,
      degradedReason: this.degradedReason,
      coordinatorFailures: [...this.coordinatorFailures],
      adapterFailures: [...this.adapterFailures],
      workers: [...this.workerStats.entries()].reduce((acc, [agentId, stats]) => {
        acc[agentId] = { ...stats };
        return acc;
      }, {}),
    };
  }
}
