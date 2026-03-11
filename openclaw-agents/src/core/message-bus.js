import {
  AGENT_STATUSES,
  createAgentResult,
} from "./types.js";
import {
  EXECUTION_MODES,
  QUEUE_CLASSES,
  RETRY_CLASSES,
  TASK_STATES,
  buildIdempotencyKey,
  buildTaskKey,
  createTaskId,
  formatFailure,
  isTerminalState,
  resolveQueueClass,
  resolveRetryLimit,
} from "./reliability-utils.js";

function cloneContext(context = {}) {
  return context && typeof context === "object" ? { ...context } : {};
}

export class MessageBus {
  constructor(params = {}) {
    this.registry = params.registry;
    this.toolProxy = params.toolProxy || null;
    this.journal = params.journal || null;
    this.reducer = params.reducer || null;
    this.queueManager = params.queueManager || null;
    this.runtimeAdapter = params.runtimeAdapter || null;
    this.healthTracker = params.healthTracker || null;
    this.trace = [];
    this.now = params.now || (() => Date.now());
    this.leaseMs = params.leaseMs || 60_000;
    this.heartbeatMs = params.heartbeatMs || 15_000;
    this.maxAttempts = params.maxAttempts || {};
    this.coordinatorId =
      params.coordinatorId || `wrapper:${process.pid}:${Math.floor(this.now() / 1000)}`;
    this.directOnly = params.directOnly === true;
    this.waiters = new Map();

    if (this.queueManager) {
      for (const queueClass of [
        QUEUE_CLASSES.DIRECT_TASKS,
        QUEUE_CLASSES.LONG_RUNNING_TASKS,
        QUEUE_CLASSES.RETRY_TASKS,
      ]) {
        this.queueManager.setHandler(queueClass, async (taskId) => {
          await this.#executeManagedTask(taskId);
        });
      }
      this.queueManager.setHandler(QUEUE_CLASSES.NOTIFIER_TASKS, async () => {});
    }
  }

  setDirectOnly(value) {
    this.directOnly = Boolean(value);
  }

  isDirectOnly() {
    const featureFlags = this.runtimeAdapter?.getFeatureFlags?.() || {};
    return (
      this.directOnly ||
      !this.journal ||
      !this.reducer ||
      !this.queueManager ||
      !this.runtimeAdapter ||
      this.healthTracker?.isDegraded?.() === true ||
      featureFlags.subagents === false
    );
  }

  canUseManagedRetry() {
    const featureFlags = this.runtimeAdapter?.getFeatureFlags?.() || {};
    return !this.isDirectOnly() && featureFlags.recovery !== false;
  }

  async dispatch(agentId, task, context) {
    const agent = this.registry.get(agentId);
    if (!agent) {
      return createAgentResult({
        status: AGENT_STATUSES.FAILED,
        summary: `Unknown agent: ${agentId}`,
        followups: ["Check agent registration."],
      });
    }

    const startedAt = this.now();
    try {
      const runner = async () => await agent.run(task, context);
      const rawResult = this.toolProxy?.withExecutionContext
        ? await this.toolProxy.withExecutionContext(context || {}, runner)
        : await runner();
      const result = createAgentResult(rawResult);
      this.trace.push({
        agentId,
        status: result.status,
        durationMs: this.now() - startedAt,
      });
      return result;
    } catch (error) {
      const result = createAgentResult({
        status: AGENT_STATUSES.FAILED,
        summary: `${agentId} failed: ${error?.message || "unknown error"}`,
        followups: ["Review agent logs and input payload."],
      });
      this.trace.push({
        agentId,
        status: result.status,
        durationMs: this.now() - startedAt,
        error: error?.message || String(error),
      });
      return result;
    }
  }

  async dispatchPipeline(agentIds, task, context, contextFactory) {
    const results = [];
    for (const agentId of agentIds) {
      const subContext = contextFactory
        ? contextFactory(agentId, task, context, results)
        : context;
      const result = await this.dispatch(agentId, task, subContext);
      results.push({ agentId, result });
      if (result.status === AGENT_STATUSES.FAILED) {break;}
    }
    return results;
  }

  async submitTask(agentId, task, context = {}, options = {}) {
    const retryClass = options.retryClass || context.retry_class || RETRY_CLASSES.SAFE_RETRY;
    const queueClass = options.queueClass || resolveQueueClass(agentId);

    if (this.isDirectOnly() || options.executionMode === EXECUTION_MODES.DIRECT) {
      const directContext = this.#buildDirectExecutionContext(context, retryClass);
      const result = await this.dispatch(agentId, task, directContext);
      return {
        direct: true,
        existing: false,
        task: {
          task_id: directContext.task_id,
          attempt: directContext.attempt,
          execution_mode: EXECUTION_MODES.DIRECT,
          retry_class: retryClass,
          queue_class: queueClass,
          state:
            result.status === AGENT_STATUSES.SUCCESS
              ? TASK_STATES.COMPLETED
              : TASK_STATES.FAILED,
          result,
          idempotency_key: directContext.idempotency_key,
        },
        result,
      };
    }

    try {
      const reservation = this.#reserveManagedTask(agentId, task, context, {
        retryClass,
        queueClass,
      });

      if (reservation.created) {
        this.reducer.transition({
          taskId: reservation.task.task_id,
          eventType: "progress:accepted",
          nextState: TASK_STATES.ACCEPTED,
          changes: {
            execution_mode: EXECUTION_MODES.SUBAGENT,
          },
        });
        this.reducer.transition({
          taskId: reservation.task.task_id,
          eventType: "progress:queued",
          nextState: TASK_STATES.QUEUED,
          changes: {
            queue_class: reservation.task.queue_class,
            retry_after_at: null,
          },
        });
        this.queueManager.enqueue(reservation.task.task_id, reservation.task.queue_class, {
          enqueuedAt: reservation.task.created_at || this.now(),
        });
      }

      const finalTask = await this.#waitForTask(reservation.task.task_id);
      return {
        direct: false,
        existing: !reservation.created,
        task: finalTask,
        result: this.#materializeTaskResult(finalTask),
      };
    } catch (error) {
      this.healthTracker?.reportJournalFailure?.(error);
      this.setDirectOnly(true);
      const directContext = this.#buildDirectExecutionContext(context, retryClass);
      const result = await this.dispatch(agentId, task, directContext);
      return {
        direct: true,
        existing: false,
        task: {
          task_id: directContext.task_id,
          attempt: directContext.attempt,
          execution_mode: EXECUTION_MODES.DIRECT,
          retry_class: retryClass,
          queue_class: queueClass,
          state:
            result.status === AGENT_STATUSES.SUCCESS
              ? TASK_STATES.COMPLETED
              : TASK_STATES.FAILED,
          result,
          idempotency_key: directContext.idempotency_key,
        },
        result,
      };
    }
  }

  recoverWaitingTasks() {
    if (!this.journal || !this.queueManager) {return;}
    this.queueManager.recover(this.journal.listReadyTasks(this.now()));
  }

  async retryTask(taskInput, failure) {
    const task =
      typeof taskInput === "string" ? this.journal.getTaskById(taskInput) : this.journal.getTaskById(taskInput.task_id);
    if (!task || isTerminalState(task.state)) {
      return task;
    }

    const retryLimit = resolveRetryLimit(this.maxAttempts, task.retry_class, 1);
    const autoRetryAllowed = this.toolProxy?.allowsAutoRetry
      ? this.toolProxy.allowsAutoRetry(task.retry_class)
      : task.retry_class !== RETRY_CLASSES.MANUAL_RETRY;
    if (!autoRetryAllowed || task.attempt >= retryLimit) {
      const deadLetter = this.reducer.transition({
        taskId: task.task_id,
        eventType: "terminal:dead_letter",
        nextState: TASK_STATES.DEAD_LETTER,
        failure,
        setTerminal: true,
      });
      this.#resolveTaskWaiter(deadLetter.task);
      return deadLetter.task;
    }

    this.reducer.transition({
      taskId: task.task_id,
      eventType: "retry:scheduled",
      nextState: TASK_STATES.RETRY_WAIT,
      failure,
      changes: {
        queue_class: QUEUE_CLASSES.RETRY_TASKS,
        retry_after_at: this.now(),
      },
    });
    const requeued = this.reducer.transition({
      taskId: task.task_id,
      eventType: "retry:requeued",
      nextState: TASK_STATES.QUEUED,
      incrementAttempt: true,
      changes: {
        queue_class: QUEUE_CLASSES.RETRY_TASKS,
        retry_after_at: null,
        execution_mode: EXECUTION_MODES.SUBAGENT,
      },
    });
    this.queueManager.enqueue(task.task_id, QUEUE_CLASSES.RETRY_TASKS, {
      enqueuedAt: this.now(),
    });
    return requeued.task;
  }

  #buildDirectExecutionContext(context, retryClass) {
    const nextContext = cloneContext(context);
    const taskId = nextContext.task_id || createTaskId();
    const attempt = Number(nextContext.attempt || 1);
    nextContext.task_id = taskId;
    nextContext.attempt = attempt;
    nextContext.retry_class = retryClass;
    nextContext.idempotency_key =
      nextContext.idempotency_key || buildIdempotencyKey(taskId, attempt);
    nextContext.correlation_id = nextContext.correlation_id || taskId;
    return nextContext;
  }

  #reserveManagedTask(agentId, task, context, options = {}) {
    const preparedContext = cloneContext(context);
    const correlationId = preparedContext.correlation_id || preparedContext.task_id || createTaskId();
    const taskId = createTaskId();
    const idempotencyKey = buildIdempotencyKey(taskId, 1);
    const taskKey = buildTaskKey({
      parentRunId: preparedContext.parent_run_id,
      objective: typeof task === "string" ? task : JSON.stringify(task),
      input: preparedContext,
      agentId,
    });

    const reservation = this.journal.reserveTask({
      task_id: taskId,
      task_key: taskKey,
      agent_id: agentId,
      parent_run_id: preparedContext.parent_run_id || null,
      correlation_id: correlationId,
      task_payload: {
        task,
      },
      context: preparedContext,
      queue_class: options.queueClass,
      retry_class: options.retryClass,
      execution_mode: EXECUTION_MODES.SUBAGENT,
      attempt: 1,
      idempotency_key: idempotencyKey,
    });

    if (reservation.created) {
      const current = this.journal.getTaskByKey(taskKey);
      const nextContext = cloneContext(current.context || {});
      nextContext.task_id = current.task_id;
      nextContext.attempt = current.attempt;
      nextContext.retry_class = current.retry_class;
      nextContext.idempotency_key = current.idempotency_key;
      nextContext.correlation_id = correlationId;
      this.journal.updateTaskCas({
        taskId: current.task_id,
        expectedVersion: current.state_version,
        changes: {
          context_json: JSON.stringify(nextContext),
          correlation_id: nextContext.correlation_id,
          idempotency_key: nextContext.idempotency_key,
          updated_at: this.now(),
        },
      });
      reservation.task = this.journal.getTaskByKey(taskKey);
    }

    if (isTerminalState(reservation.task.state)) {
      this.#resolveTaskWaiter(reservation.task);
    }

    return reservation;
  }

  #createWaiter(taskId) {
    let resolveFn;
    let rejectFn;
    const promise = new Promise((resolve, reject) => {
      resolveFn = resolve;
      rejectFn = reject;
    });
    const waiter = {
      promise,
      resolve: resolveFn,
      reject: rejectFn,
    };
    this.waiters.set(taskId, waiter);
    return waiter;
  }

  async #waitForTask(taskId) {
    const task = this.journal.getTaskById(taskId);
    if (task && isTerminalState(task.state)) {
      return task;
    }
    const waiter = this.waiters.get(taskId) || this.#createWaiter(taskId);
    return await waiter.promise;
  }

  #resolveTaskWaiter(task) {
    const waiter = this.waiters.get(task.task_id);
    if (!waiter) {return;}
    waiter.resolve(task);
    this.waiters.delete(task.task_id);
  }

  async #executeManagedTask(taskId) {
    let task = this.journal.getTaskById(taskId);
    if (!task || isTerminalState(task.state)) {
      if (task) {
        this.#resolveTaskWaiter(task);
      }
      return;
    }

    if (this.healthTracker?.isCircuitOpen?.(task.agent_id)) {
      const deadLetter = this.reducer.transition({
        taskId: task.task_id,
        eventType: "terminal:dead_letter",
        nextState: TASK_STATES.DEAD_LETTER,
        failure: {
          code: "circuit_open",
          message: `Circuit breaker is open for agent ${task.agent_id}`,
          details: null,
        },
        setTerminal: true,
      });
      this.#resolveTaskWaiter(deadLetter.task);
      return;
    }

    try {
      task = this.reducer.transition({
        taskId: task.task_id,
        eventType: "progress:dispatching",
        nextState: TASK_STATES.DISPATCHING,
        changes: {
          execution_mode: EXECUTION_MODES.SUBAGENT,
          retry_after_at: null,
        },
      }).task;

      const context = cloneContext(task.context || {});
      context.task_id = task.task_id;
      context.attempt = task.attempt;
      context.retry_class = task.retry_class;
      context.idempotency_key = task.idempotency_key;
      context.correlation_id = context.correlation_id || task.correlation_id || task.task_id;

      const spawned = await this.runtimeAdapter.spawnSubagent({
        agentId: task.agent_id,
        task: task.task_payload?.task,
        context,
      });
      this.healthTracker?.reportAdapterSuccess?.();

      task = this.reducer.transition({
        taskId: task.task_id,
        eventType: "progress:spawned",
        nextState: TASK_STATES.RUNNING,
        changes: {
          child_run_id: spawned.runId,
          child_session_key: spawned.sessionKey || null,
          lease_owner: this.coordinatorId,
          lease_expires_at: this.now() + this.leaseMs,
          last_heartbeat_at: this.now(),
          context_json: JSON.stringify(context),
        },
      }).task;

      const heartbeat = setInterval(() => {
        const current = this.journal.getTaskById(task.task_id);
        if (!current || isTerminalState(current.state)) {
          clearInterval(heartbeat);
          return;
        }
        try {
          this.reducer.transition({
            taskId: current.task_id,
            eventType: `progress:heartbeat:${this.now()}`,
            changes: {
              lease_owner: this.coordinatorId,
              lease_expires_at: this.now() + this.leaseMs,
              last_heartbeat_at: this.now(),
            },
          });
        } catch {
          clearInterval(heartbeat);
        }
      }, this.heartbeatMs);
      heartbeat.unref?.();

      const waited = await this.runtimeAdapter.waitForRun({
        runId: spawned.runId,
      });
      clearInterval(heartbeat);

      if (waited.status === "ok") {
        const completed = this.reducer.transition({
          taskId: task.task_id,
          eventType: "terminal:completed",
          nextState: TASK_STATES.COMPLETED,
          result: createAgentResult(waited.result || {}),
          clearFailure: true,
          setTerminal: true,
        });
        this.healthTracker?.reportWorkerSuccess?.(task.agent_id);
        this.#resolveTaskWaiter(completed.task);
        return;
      }

      if (waited.status === "error") {
        this.healthTracker?.reportWorkerFailure?.(task.agent_id);
        if (this.canUseManagedRetry()) {
          await this.retryTask(task, formatFailure(waited.error || "Managed run failed"));
          return;
        }
        const failed = this.reducer.transition({
          taskId: task.task_id,
          eventType: "terminal:failed",
          nextState: TASK_STATES.FAILED,
          failure: formatFailure(waited.error || "Managed run failed"),
          setTerminal: true,
        });
        this.#resolveTaskWaiter(failed.task);
        return;
      }

      // Leave the task to the sweeper when the runtime does not report a terminal state yet.
    } catch (error) {
      this.healthTracker?.reportAdapterFailure?.(error);
      if (this.canUseManagedRetry()) {
        await this.retryTask(task, formatFailure(error));
        return;
      }
      const failed = this.reducer.transition({
        taskId: task.task_id,
        eventType: "terminal:failed",
        nextState: TASK_STATES.FAILED,
        failure: formatFailure(error),
        setTerminal: true,
      });
      this.#resolveTaskWaiter(failed.task);
    }
  }

  #materializeTaskResult(task) {
    if (task?.result) {
      return createAgentResult(task.result);
    }
    if (task?.state === TASK_STATES.FAILED || task?.state === TASK_STATES.DEAD_LETTER) {
      return createAgentResult({
        status: AGENT_STATUSES.FAILED,
        summary: task.failure_message || "Task failed",
        followups: [],
      });
    }
    return createAgentResult({});
  }
}
