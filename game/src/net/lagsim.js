/**
 * Artificial latency, jitter and loss, applied to both directions.
 *
 * This exists from the first day of the project on purpose. Prediction,
 * reconciliation and interpolation all look perfect on localhost and all fail
 * in different ways on a real connection, so developing them without a lag
 * simulator means shipping the bugs and then misdiagnosing them as "the server
 * is slow". Every netcode change should be checked at 150ms / 5%.
 *
 * Two models, because the transport may change:
 *
 *   tcp  - what a WebSocket actually does. Nothing is ever lost or reordered;
 *          a "lost" packet becomes a retransmit stall that also delays
 *          everything queued behind it (head-of-line blocking). This is the
 *          honest default.
 *   udp  - what WebTransport datagrams would do: real drops, real reordering.
 *          Worth testing against so the protocol stays ready for that swap.
 */

import { xorshift32 } from '../../../shared/math.js';

export class LagSim {
  /** @param {(buf: ArrayBuffer) => void} deliver */
  constructor(deliver, seed = 0x1234567) {
    this.deliver = deliver;
    this.latencyMs = 0;
    this.jitterMs = 0;
    this.lossPct = 0;
    this.mode = 'tcp';
    /** @type {{due: number, buf: ArrayBuffer}[]} */
    this.queue = [];
    this.lastDue = 0;
    this.rng = xorshift32(seed);
  }

  get enabled() {
    return this.latencyMs > 0 || this.jitterMs > 0 || this.lossPct > 0;
  }

  push(buf) {
    if (!this.enabled) {
      this.deliver(buf);
      return;
    }

    const now = performance.now();
    let delay = this.latencyMs + (this.rng() * 2 - 1) * this.jitterMs;
    if (delay < 0) delay = 0;

    if (this.rng() * 100 < this.lossPct) {
      if (this.mode === 'udp') return; // genuinely dropped
      // TCP: the packet is not lost, it is late, and it blocks the stream.
      delay += Math.max(30, this.latencyMs * 2);
    }

    let due = now + delay;
    if (this.mode === 'tcp') {
      if (due < this.lastDue) due = this.lastDue;
      this.lastDue = due;
    }
    this.queue.push({ due, buf });
  }

  /** Drains everything that has come due. Call once per frame. */
  pump() {
    if (this.queue.length === 0) return;
    const now = performance.now();

    if (this.mode === 'udp') {
      // Jitter can reorder, so due order is not insertion order.
      this.queue.sort((a, b) => a.due - b.due);
    }

    let i = 0;
    while (i < this.queue.length && this.queue[i].due <= now) i++;
    if (i === 0) return;
    const ready = this.queue.splice(0, i);
    for (const item of ready) this.deliver(item.buf);
  }

  reset() {
    this.queue.length = 0;
    this.lastDue = 0;
  }
}
