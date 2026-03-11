import test from "node:test";
import assert from "node:assert/strict";
import { QueueManager } from "../src/core/queue-manager.js";
import { QUEUE_CLASSES } from "../src/core/reliability-utils.js";

test("age promotion prevents starvation within the same queue", async () => {
  let currentTime = 100_000;
  const order = [];
  let releaseBlocker;
  const blocker = new Promise((resolve) => {
    releaseBlocker = resolve;
  });

  const queueManager = new QueueManager({
    now: () => currentTime,
    agePromotionMs: 90_000,
    reservations: {
      [QUEUE_CLASSES.DIRECT_TASKS]: 1,
    },
  });

  queueManager.setHandler(QUEUE_CLASSES.DIRECT_TASKS, async (taskId) => {
    if (taskId === "blocker") {
      await blocker;
      return;
    }
    order.push(taskId);
  });

  queueManager.enqueue("blocker", QUEUE_CLASSES.DIRECT_TASKS, {
    enqueuedAt: currentTime,
  });
  await new Promise((resolve) => setTimeout(resolve, 10));

  queueManager.enqueue("newer", QUEUE_CLASSES.DIRECT_TASKS, {
    enqueuedAt: currentTime,
  });
  queueManager.enqueue("older", QUEUE_CLASSES.DIRECT_TASKS, {
    enqueuedAt: currentTime - 90_001,
  });

  releaseBlocker();
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.deepEqual(order, ["older", "newer"]);
});
