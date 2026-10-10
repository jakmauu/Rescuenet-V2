import { isPendingLocationStale, locationRetryDelayMs, shouldQueueLocation } from './core.mjs';

/** One-pending/one-in-flight location outbox. GPS fixes are coalesced to the newest candidate. */
export class LocationScheduler {
  constructor({ readPending, writePending, readLatest, writeLatest, readLastAccepted, writeLastAccepted,
    makePacket, send, enabled, onState = () => {}, now = () => Date.now(), setTimer = setTimeout,
    clearTimer = clearTimeout, maxAttempts = 5, intervalMs = 120_000, minimumSpacingMs = 60_000 }) {
    Object.assign(this, { readPending, writePending, readLatest, writeLatest, readLastAccepted,
      writeLastAccepted, makePacket, send, enabled, onState, now, setTimer, clearTimer,
      maxAttempts, intervalMs, minimumSpacingMs });
    this.timer = null;
    this.inFlight = false;
    this.generation = 0;
  }

  offer(fix) {
    this.writeLatest(fix);
    const pending = this.readPending();
    if (!pending) this.queueLatestIfEligible();
    this.pump();
  }

  queueLatestIfEligible() {
    const latest = this.readLatest();
    const accepted = this.readLastAccepted();
    if (!latest || !shouldQueueLocation(accepted, latest, this.intervalMs, this.minimumSpacingMs)) return false;
    const age = this.now() - latest.timestamp;
    if (age < -5_000 || age > 120_000) { this.onState('stale'); return false; }
    const packet = this.makePacket(latest);
    this.writePending({ packet, fixTimestamp: latest.timestamp, attempts: 0, nextAttemptAt: 0 });
    this.onState('queued');
    return true;
  }

  resume() { this.pump(); }

  retryNow() {
    const pending = this.readPending();
    if (!pending) return;
    this.writePending({ ...pending, attempts: 0, nextAttemptAt: 0 });
    this.cancelTimer();
    this.pump();
  }

  stop({ discard = false } = {}) {
    this.generation += 1;
    this.cancelTimer();
    if (discard) this.writePending(null);
    this.onState('stopped');
  }

  cancelTimer() {
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
  }

  schedule(at) {
    this.cancelTimer();
    if (!this.enabled()) return;
    this.timer = this.setTimer(() => { this.timer = null; this.pump(); }, Math.max(0, at - this.now()));
  }

  async pump() {
    if (this.inFlight || !this.enabled()) return;
    let pending = this.readPending();
    if (!pending) {
      if (!this.queueLatestIfEligible()) return;
      pending = this.readPending();
    }
    if (!pending) return;
    if (isPendingLocationStale(pending.packet, this.now())) {
      this.writePending(null);
      this.onState('stale');
      if (!this.queueLatestIfEligible()) return;
      pending = this.readPending();
    }
    if (pending.attempts >= this.maxAttempts) { this.onState('exhausted'); return; }
    if (this.now() < pending.nextAttemptAt) { this.schedule(pending.nextAttemptAt); return; }

    const generation = this.generation;
    const requestId = pending.packet.request_id;
    this.inFlight = true;
    this.onState('sending', pending);
    try {
      const ack = await this.send(pending.packet);
      const current = this.readPending();
      if (generation === this.generation && current?.packet?.request_id === requestId) {
        this.writePending(null);
        this.writeLastAccepted({ lat: pending.packet.lat, lon: pending.packet.lon,
          timestamp: (pending.packet.timestamp || 0) * 1000, requestId,
          acceptedAt: this.now(), nodeId: ack.node_id ?? null });
        this.onState('accepted', ack);
      }
    } catch (error) {
      const current = this.readPending();
      if (generation === this.generation && current?.packet?.request_id === requestId) {
        const attempts = current.attempts + 1;
        const nextAttemptAt = this.now() + locationRetryDelayMs(attempts);
        this.writePending({ ...current, attempts, nextAttemptAt, lastError: error.message });
        this.onState(attempts >= this.maxAttempts ? 'exhausted' : 'retry_wait', error);
        if (attempts < this.maxAttempts) this.schedule(nextAttemptAt);
      }
    } finally {
      this.inFlight = false;
      // A newer fix received during the request remains the candidate; after ACK,
      // schedule it without disturbing the retry state of the request just sent.
      if (!this.enabled()) return;
      if (!this.readPending()) {
        if (this.queueLatestIfEligible()) this.pump();
      } else if (generation !== this.generation && this.timer === null) {
        // A lifecycle stop may have invalidated an in-flight response while
        // preserving its pending packet; resume that same idempotent packet.
        this.pump();
      }
    }
  }
}
