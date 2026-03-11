export class ProgressNotifier {
  constructor(params = {}) {
    this.journal = params.journal;
    this.runtimeAdapter = params.runtimeAdapter;
    this.deliverNotification = params.deliverNotification || null;
    this.throttleMs = params.throttleMs || 30_000;
    this.pollMs = params.pollMs || 1_000;
    this.now = params.now || (() => Date.now());
    this.inFlight = false;
    this.timer = null;
  }

  start() {
    if (this.timer || !this.deliverNotification) {return;}
    this.timer = setInterval(() => {
      void this.pumpOnce();
    }, this.pollMs);
    this.timer.unref?.();
  }

  stop() {
    if (!this.timer) {return;}
    clearInterval(this.timer);
    this.timer = null;
  }

  async pumpOnce() {
    if (this.inFlight || !this.deliverNotification) {return;}
    this.inFlight = true;
    try {
      const now = this.now();
      const events = this.journal.listPendingNotifierEvents({ now, limit: 50 });
      for (const event of events) {
        await this.#deliverEvent(event, now);
      }
    } finally {
      this.inFlight = false;
    }
  }

  async #deliverEvent(event, now) {
    if (!event?.task_id) {return;}
    const task = this.journal.getTaskById(event.task_id);
    if (!task) {return;}

    const isTerminal = String(event.event_type || "").startsWith("terminal:");
    if (!isTerminal) {
      const lastSent = this.journal.getLastSentEventTimestamp(task.task_id);
      if (lastSent && now - lastSent < this.throttleMs) {
        this.journal.updateEventNotifier(event.event_key, {
          notifier_next_attempt_at: lastSent + this.throttleMs,
        });
        return;
      }
    }

    try {
      const target = await this.runtimeAdapter.resolveNotifierTarget(task);
      await this.deliverNotification({
        target,
        task,
        event,
      });
      this.journal.updateEventNotifier(event.event_key, {
        notifier_last_sent_at: now,
        notifier_send_count: (event.notifier_send_count || 0) + 1,
        notifier_last_error: null,
        notifier_next_attempt_at: isTerminal ? null : now + this.throttleMs,
      });
    } catch (error) {
      this.journal.updateEventNotifier(event.event_key, {
        notifier_send_count: (event.notifier_send_count || 0) + 1,
        notifier_last_error: error?.message || String(error),
        notifier_next_attempt_at: now + this.throttleMs,
      });
    }
  }
}
