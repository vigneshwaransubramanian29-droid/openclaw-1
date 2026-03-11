import { EventEmitter } from "node:events";
import { createRunId, createSessionKey } from "./reliability-utils.js";

const VALID_WAIT_STATUSES = new Set([
  "ok",
  "error",
  "timeout",
  "running",
  "missing",
  "unknown",
]);

function normalizeLifecycleEvent(event = {}) {
  const data = event.data && typeof event.data === "object" ? event.data : {};
  return {
    runId: event.runId || data.runId || null,
    phase: event.phase || data.phase || "unknown",
    sessionKey: event.sessionKey || data.sessionKey || null,
    result: event.result ?? data.result,
    error: event.error ?? data.error ?? null,
    at: event.at || Date.now(),
  };
}

function normalizeWaitResult(result) {
  const status = result?.status;
  if (!VALID_WAIT_STATUSES.has(status)) {
    throw new Error(`Invalid waitForRun status: ${status}`);
  }
  return {
    status,
    result: result?.result,
    error: result?.error || null,
  };
}

export class RuntimeAdapter {
  constructor(params = {}) {
    this.now = params.now || (() => Date.now());
    this.probes = params.probes || {};
    this.executor = params.executor || null;
    this.hooks = {
      spawnSubagent: params.spawnSubagent || null,
      waitForRun: params.waitForRun || null,
      subscribeLifecycle: params.subscribeLifecycle || null,
      resolveNotifierTarget: params.resolveNotifierTarget || null,
      lookupSidecarHealth: params.lookupSidecarHealth || null,
    };
    this.emitter = new EventEmitter();
    this.runs = new Map();
    this.featureFlags = {
      subagents: Boolean(this.hooks.spawnSubagent || this.executor),
      recovery: Boolean(this.hooks.waitForRun || this.executor),
      notifier: Boolean(this.hooks.resolveNotifierTarget),
      sidecarSignals: Boolean(this.hooks.lookupSidecarHealth),
    };
    this.probeErrors = [];
    this.externalLifecycleUnsubscribe = null;
  }

  setExecutor(executor) {
    this.executor = executor;
    if (!this.hooks.spawnSubagent) {
      this.featureFlags.subagents = Boolean(executor);
    }
    if (!this.hooks.waitForRun) {
      this.featureFlags.recovery = Boolean(executor);
    }
  }

  getFeatureFlags() {
    return { ...this.featureFlags };
  }

  async #attachExternalLifecycleBridge() {
    if (!this.hooks.subscribeLifecycle || this.externalLifecycleUnsubscribe) {
      return;
    }
    const unsubscribe = await this.hooks.subscribeLifecycle((event) => {
      this.#recordLifecycle(normalizeLifecycleEvent(event));
    });
    if (typeof unsubscribe !== "function") {
      throw new Error("lifecycle subscription must return an unsubscribe function");
    }
    this.externalLifecycleUnsubscribe = unsubscribe;
  }

  #recordLifecycle(event) {
    if (event?.runId) {
      const existing = this.runs.get(event.runId) || {};
      const next = {
        ...existing,
        runId: event.runId,
        sessionKey: event.sessionKey || existing.sessionKey || null,
        result: event.result ?? existing.result,
        error: event.error ?? existing.error ?? null,
        promise: existing.promise || null,
      };
      const phase =
        event.phase === "end" || event.phase === "error"
          ? "completed"
          : event.phase === "start" || event.phase === "heartbeat"
          ? "running"
          : existing.phase || "unknown";
      next.phase = phase;
      next.completed =
        event.phase === "end" || event.phase === "error" ? true : existing.completed || false;
      this.runs.set(event.runId, next);
    }
    this.emitter.emit("lifecycle", event);
  }

  subscribeLifecycle(listener) {
    this.emitter.on("lifecycle", listener);
    return () => {
      this.emitter.off("lifecycle", listener);
    };
  }

  async #localSpawn(params = {}) {
    const runId = createRunId();
    const sessionKey = params.sessionKey || createSessionKey("subagent");
    const runState = {
      runId,
      sessionKey,
      phase: "running",
      completed: false,
      promise: null,
      result: null,
      error: null,
    };
    this.runs.set(runId, runState);
    this.#recordLifecycle({
      runId,
      sessionKey,
      phase: "start",
      at: this.now(),
    });

    runState.promise = Promise.resolve()
      .then(async () => {
        if (params.probe) {
          return {
            status: "success",
            summary: "probe ok",
            citations: [],
            artifacts: [],
            memory_suggestions: [],
            followups: [],
          };
        }
        if (!this.executor) {
          throw new Error("Runtime adapter has no executor for local spawn");
        }
        return await this.executor(params.agentId, params.task, params.context);
      })
      .then((result) => {
        runState.phase = "completed";
        runState.completed = true;
        runState.result = result;
        this.#recordLifecycle({
          runId,
          sessionKey,
          phase: "end",
          result,
          at: this.now(),
        });
        return {
          status: "ok",
          result,
        };
      })
      .catch((error) => {
        runState.phase = "completed";
        runState.completed = true;
        runState.error = error;
        this.#recordLifecycle({
          runId,
          sessionKey,
          phase: "error",
          error: error?.message || String(error),
          at: this.now(),
        });
        return {
          status: "error",
          error: error?.message || String(error),
        };
      });
    this.runs.set(runId, runState);

    return {
      runId,
      sessionKey,
    };
  }

  async spawnSubagent(params = {}) {
    const result = this.hooks.spawnSubagent
      ? await this.hooks.spawnSubagent(params)
      : await this.#localSpawn(params);
    if (!result?.runId) {
      throw new Error("spawnSubagent must return a runId");
    }
    if (!this.runs.has(result.runId)) {
      this.runs.set(result.runId, {
        runId: result.runId,
        sessionKey: result.sessionKey || null,
        phase: "unknown",
        completed: false,
        promise: null,
        result: null,
        error: null,
      });
    }
    return result;
  }

  async #localWait(params = {}) {
    const run = this.runs.get(params.runId);
    if (!run) {
      return { status: "missing" };
    }
    if (run.completed) {
      return run.error
        ? { status: "error", error: run.error?.message || String(run.error) }
        : { status: "ok", result: run.result };
    }
    if (params.timeoutMs === 0) {
      return { status: "running" };
    }
    const timeoutMs =
      params.timeoutMs == null || params.timeoutMs < 0 ? Number.POSITIVE_INFINITY : params.timeoutMs;
    if (!Number.isFinite(timeoutMs)) {
      return normalizeWaitResult(await run.promise);
    }

    let timer = null;
    const timeoutPromise = new Promise((resolve) => {
      timer = setTimeout(() => resolve({ status: "timeout" }), timeoutMs);
      timer.unref?.();
    });
    const result = await Promise.race([run.promise, timeoutPromise]);
    if (timer) {clearTimeout(timer);}
    return normalizeWaitResult(result);
  }

  async waitForRun(params = {}) {
    const result = this.hooks.waitForRun
      ? await this.hooks.waitForRun(params)
      : await this.#localWait(params);
    return normalizeWaitResult(result);
  }

  async reconcileTask(task = {}) {
    const runId = task.child_run_id;
    if (!runId) {
      return {
        runtimeObservedState: "missing",
        waitResult: null,
      };
    }

    const cached = this.runs.get(runId);
    if (cached?.completed) {
      return {
        runtimeObservedState: "completed",
        waitResult: cached.error
          ? { status: "error", error: cached.error?.message || String(cached.error) }
          : { status: "ok", result: cached.result },
      };
    }
    if (cached?.phase === "running") {
      return {
        runtimeObservedState: "running",
        waitResult: { status: "running" },
      };
    }

    try {
      const waited = await this.waitForRun({ runId, timeoutMs: 0 });
      if (waited.status === "ok" || waited.status === "error") {
        return {
          runtimeObservedState: "completed",
          waitResult: waited,
        };
      }
      if (waited.status === "running") {
        return {
          runtimeObservedState: "running",
          waitResult: waited,
        };
      }
      if (waited.status === "missing") {
        return {
          runtimeObservedState: "missing",
          waitResult: waited,
        };
      }
      if (waited.status === "timeout") {
        return {
          runtimeObservedState: cached ? "running" : "unknown",
          waitResult: waited,
        };
      }
      return {
        runtimeObservedState: "unknown",
        waitResult: waited,
      };
    } catch (error) {
      const message = error?.message || String(error);
      if (/missing|not found|unknown run/i.test(message)) {
        return {
          runtimeObservedState: "missing",
          waitResult: { status: "missing", error: message },
        };
      }
      return {
        runtimeObservedState: "unknown",
        waitResult: { status: "unknown", error: message },
      };
    }
  }

  async resolveNotifierTarget(task) {
    if (!this.featureFlags.notifier || !this.hooks.resolveNotifierTarget) {
      return null;
    }
    return await this.hooks.resolveNotifierTarget(task);
  }

  async lookupSidecarHealth(input = {}) {
    if (!this.featureFlags.sidecarSignals || !this.hooks.lookupSidecarHealth) {
      return null;
    }
    return await this.hooks.lookupSidecarHealth(input);
  }

  async runStartupProbes() {
    this.probeErrors = [];

    if (this.probes.lifecycle !== false && this.hooks.subscribeLifecycle) {
      try {
        await this.#attachExternalLifecycleBridge();
      } catch (error) {
        this.featureFlags.recovery = false;
        this.probeErrors.push({
          feature: "lifecycle",
          error: error?.message || String(error),
        });
      }
    }

    let probeRun = null;
    const seenPhases = new Map();
    let unsubscribe = () => {};
    if (this.probes.lifecycle !== false) {
      unsubscribe = this.subscribeLifecycle((event) => {
        if (!event?.runId) {return;}
        const phases = seenPhases.get(event.runId) || new Set();
        phases.add(event.phase);
        seenPhases.set(event.runId, phases);
      });
    }

    if (this.probes.spawn !== false) {
      try {
        probeRun = await this.spawnSubagent({
          probe: true,
          agentId: "__probe__",
          task: "__probe__",
          context: { probe: true },
        });
      } catch (error) {
        this.featureFlags.subagents = false;
        this.featureFlags.recovery = false;
        this.probeErrors.push({
          feature: "spawn",
          error: error?.message || String(error),
        });
      }
    }

    if (probeRun && (this.probes.wait_for_run !== false || this.probes.lifecycle !== false)) {
      try {
        const waited = await this.waitForRun({ runId: probeRun.runId, timeoutMs: 250 });
        if (!(waited.status === "ok" || waited.status === "error")) {
          throw new Error(`Unexpected probe wait status: ${waited.status}`);
        }
        const phases = seenPhases.get(probeRun.runId) || new Set();
        if (
          this.probes.lifecycle !== false &&
          !(phases.has("start") && (phases.has("end") || phases.has("error")))
        ) {
          throw new Error("Lifecycle probe did not observe start and terminal events");
        }
      } catch (error) {
        this.featureFlags.recovery = false;
        this.probeErrors.push({
          feature: "wait_or_lifecycle",
          error: error?.message || String(error),
        });
      }
    }
    unsubscribe();

    if (this.probes.notifier !== false && this.hooks.resolveNotifierTarget) {
      try {
        await this.resolveNotifierTarget({ probe: true });
      } catch (error) {
        this.featureFlags.notifier = false;
        this.probeErrors.push({
          feature: "notifier",
          error: error?.message || String(error),
        });
      }
    }

    if (this.probes.sidecar_signals !== false && this.hooks.lookupSidecarHealth) {
      try {
        await this.lookupSidecarHealth({ probe: true });
      } catch (error) {
        this.featureFlags.sidecarSignals = false;
        this.probeErrors.push({
          feature: "sidecar_signals",
          error: error?.message || String(error),
        });
      }
    }

    return this.getFeatureFlags();
  }
}
