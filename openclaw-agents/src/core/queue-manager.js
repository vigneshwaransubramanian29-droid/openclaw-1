import { QUEUE_CLASSES } from "./reliability-utils.js";

function sortQueue(entries, now, agePromotionMs) {
  return [...entries].toSorted((left, right) => {
    const leftPromoted = now - left.enqueuedAt >= agePromotionMs ? 1 : 0;
    const rightPromoted = now - right.enqueuedAt >= agePromotionMs ? 1 : 0;
    if (leftPromoted !== rightPromoted) {
      return rightPromoted - leftPromoted;
    }
    return left.enqueuedAt - right.enqueuedAt;
  });
}

export class QueueManager {
  constructor(params = {}) {
    this.now = params.now || (() => Date.now());
    this.agePromotionMs = params.agePromotionMs || 90_000;
    this.handlers = new Map();
    this.queues = new Map(
      Object.values(QUEUE_CLASSES).map((queueClass) => [queueClass, []]),
    );
    this.pending = new Map();
    this.inFlight = new Map(
      Object.values(QUEUE_CLASSES).map((queueClass) => [queueClass, 0]),
    );
    this.reservations = {
      [QUEUE_CLASSES.DIRECT_TASKS]:
        params.reservations?.[QUEUE_CLASSES.DIRECT_TASKS] ??
        params.reservations?.direct ??
        2,
      [QUEUE_CLASSES.LONG_RUNNING_TASKS]:
        params.reservations?.[QUEUE_CLASSES.LONG_RUNNING_TASKS] ??
        params.reservations?.long_running ??
        1,
      [QUEUE_CLASSES.RETRY_TASKS]:
        params.reservations?.[QUEUE_CLASSES.RETRY_TASKS] ??
        params.reservations?.retry ??
        1,
      [QUEUE_CLASSES.NOTIFIER_TASKS]:
        params.reservations?.[QUEUE_CLASSES.NOTIFIER_TASKS] ??
        params.reservations?.notifier ??
        1,
    };
  }

  setHandler(queueClass, handler) {
    this.handlers.set(queueClass, handler);
  }

  enqueue(taskId, queueClass, metadata = {}) {
    const normalizedQueueClass = queueClass || QUEUE_CLASSES.DIRECT_TASKS;
    const existing = this.pending.get(taskId);
    if (existing === normalizedQueueClass) {
      return false;
    }
    if (existing) {
      const currentQueue = this.queues.get(existing) || [];
      this.queues.set(
        existing,
        currentQueue.filter((entry) => entry.taskId !== taskId),
      );
    }
    const queue = this.queues.get(normalizedQueueClass) || [];
    queue.push({
      taskId,
      queueClass: normalizedQueueClass,
      enqueuedAt: metadata.enqueuedAt ?? this.now(),
      metadata,
    });
    this.queues.set(normalizedQueueClass, queue);
    this.pending.set(taskId, normalizedQueueClass);
    void this.drain();
    return true;
  }

  recover(tasks = []) {
    for (const task of tasks) {
      if (!task?.task_id) {continue;}
      this.enqueue(task.task_id, task.queue_class, {
        enqueuedAt: task.updated_at || task.created_at || this.now(),
        recovered: true,
      });
    }
  }

  async drain() {
    await Promise.all(
      Object.values(QUEUE_CLASSES).map((queueClass) => this.#drainQueue(queueClass)),
    );
  }

  async #drainQueue(queueClass) {
    const handler = this.handlers.get(queueClass);
    if (!handler) {return;}

    let queue = this.queues.get(queueClass) || [];
    while (queue.length > 0 && (this.inFlight.get(queueClass) || 0) < this.reservations[queueClass]) {
      const [next] = sortQueue(queue, this.now(), this.agePromotionMs);
      queue = queue.filter((entry) => entry.taskId !== next.taskId);
      this.queues.set(queueClass, queue);
      this.pending.delete(next.taskId);
      this.inFlight.set(queueClass, (this.inFlight.get(queueClass) || 0) + 1);

      Promise.resolve()
        .then(() => handler(next.taskId, next))
        .finally(() => {
          this.inFlight.set(queueClass, Math.max(0, (this.inFlight.get(queueClass) || 1) - 1));
          void this.#drainQueue(queueClass);
        });
    }
  }

  status() {
    return {
      queued: [...this.queues.entries()].reduce((acc, [queueClass, entries]) => {
        acc[queueClass] = entries.map((entry) => entry.taskId);
        return acc;
      }, {}),
      inFlight: [...this.inFlight.entries()].reduce((acc, [queueClass, count]) => {
        acc[queueClass] = count;
        return acc;
      }, {}),
    };
  }
}
