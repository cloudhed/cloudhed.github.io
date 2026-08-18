/**
 * Entity interpolation for remote players.
 *
 * Remote players are rendered slightly in the past -- far enough back that
 * there are always two received snapshots bracketing the moment being drawn, so
 * their motion is a smooth interpolation rather than a series of jumps.
 *
 * The classic mistake is interpolating toward the *newest* snapshot, i.e.
 * rendering the present. That looks perfect on localhost and jitters
 * permanently on a real connection, and the jitter is invariably blamed on the
 * network rather than on the renderer.
 *
 * Snapshots are timestamped with the server's own tick rather than their
 * arrival time, because server ticks are perfectly spaced and arrival times are
 * not. That requires an estimate of what the server clock reads right now,
 * which is maintained here and slewed, never jumped: a hard clock correction
 * teleports every remote player at once and looks like a server hitch.
 */

import { DT, MIN_INTERP_DELAY_MS, SNAPSHOT_INTERVAL } from '../../../shared/constants.js';
import { lerpAngle, wrapAngle } from '../../../shared/math.js';

const HISTORY = 32; // ~1s at 30Hz
const EXPECTED_SPACING_MS = SNAPSHOT_INTERVAL * DT * 1000;

export class Interpolator {
  constructor() {
    /** @type {Map<number, {samples: Array, count: number, team: number}>} */
    this.entities = new Map();

    /** Unwrapped server tick, reconstructed from the 16-bit wire value. */
    this.serverTickFull = 0;
    this.lastServerTick16 = -1;

    /** estimatedServerTimeMs = performance.now() + clockOffsetMs */
    this.clockOffsetMs = 0;
    this.clockInitialized = false;

    /** Smoothed absolute arrival deviation, used to size the interp delay. */
    this.jitterEmaMs = 0;
    this.lastArrivalMs = 0;
    this.interpDelayMs = MIN_INTERP_DELAY_MS;

    this.output = [];
  }

  reset() {
    this.entities.clear();
    this.clockInitialized = false;
    this.lastServerTick16 = -1;
  }

  /** Rebuilds a monotonic tick counter from the wrapping 16-bit field. */
  unwrapTick(tick16) {
    if (this.lastServerTick16 < 0) {
      this.serverTickFull = tick16;
    } else {
      const d = (tick16 - this.lastServerTick16) & 0xffff;
      if (d < 0x8000) this.serverTickFull += d;
      else this.serverTickFull -= 0x10000 - d;
    }
    this.lastServerTick16 = tick16;
    return this.serverTickFull;
  }

  /**
   * @param {number} tick16 server tick from the snapshot header
   * @param {Array<{id:number,pos:Float32Array,yaw:number,team:number,onGround:boolean}>} entities
   */
  addSnapshot(tick16, entities) {
    const nowMs = performance.now();
    const tick = this.unwrapTick(tick16);
    const serverTimeMs = tick * DT * 1000;

    // Clock estimate. The least-delayed packet carries the best information, so
    // improvements are taken immediately and everything else is slewed.
    const sample = serverTimeMs - nowMs;
    if (!this.clockInitialized) {
      this.clockOffsetMs = sample;
      this.clockInitialized = true;
    } else if (sample > this.clockOffsetMs) {
      this.clockOffsetMs = sample;
    } else {
      this.clockOffsetMs += (sample - this.clockOffsetMs) * 0.02;
    }

    // Track arrival jitter so the interpolation delay can adapt to the link.
    if (this.lastArrivalMs > 0) {
      const deviation = Math.abs(nowMs - this.lastArrivalMs - EXPECTED_SPACING_MS);
      this.jitterEmaMs += (deviation - this.jitterEmaMs) * 0.1;
    }
    this.lastArrivalMs = nowMs;
    this.interpDelayMs = Math.max(
      MIN_INTERP_DELAY_MS,
      2 * EXPECTED_SPACING_MS + 3 * this.jitterEmaMs,
    );

    const seen = new Set();
    for (const e of entities) {
      seen.add(e.id);
      let rec = this.entities.get(e.id);
      if (!rec) {
        rec = { samples: [], count: 0, team: e.team };
        for (let i = 0; i < HISTORY; i++) {
          rec.samples.push({ time: 0, pos: new Float32Array(3), yaw: 0, onGround: false });
        }
        this.entities.set(e.id, rec);
      }
      rec.team = e.team;
      const s = rec.samples[rec.count % HISTORY];
      s.time = serverTimeMs;
      s.pos.set(e.pos);
      s.yaw = (e.yaw / 65536) * Math.PI * 2;
      s.onGround = e.onGround;
      rec.count++;
    }

    // Anyone absent from a full snapshot has left.
    for (const id of [...this.entities.keys()]) {
      if (!seen.has(id)) this.entities.delete(id);
    }
  }

  get estimatedServerTimeMs() {
    return performance.now() + this.clockOffsetMs;
  }

  /**
   * Samples every remote entity at the current render time.
   * @returns {Array<{id:number,pos:Float32Array,yaw:number,team:number,extrapolated:boolean}>}
   */
  sample() {
    const renderTime = this.estimatedServerTimeMs - this.interpDelayMs;
    this.output.length = 0;

    for (const [id, rec] of this.entities) {
      if (rec.count === 0) continue;

      // Walk back through history for the two samples bracketing renderTime.
      let newer = null;
      let older = null;
      const n = Math.min(rec.count, HISTORY);
      for (let i = 1; i <= n; i++) {
        const s = rec.samples[(rec.count - i) % HISTORY];
        if (s.time <= renderTime) {
          older = s;
          break;
        }
        newer = s;
      }

      const out = {
        id,
        pos: new Float32Array(3),
        yaw: 0,
        team: rec.team,
        extrapolated: false,
      };

      if (older && newer && newer.time > older.time) {
        const t = (renderTime - older.time) / (newer.time - older.time);
        out.pos[0] = older.pos[0] + (newer.pos[0] - older.pos[0]) * t;
        out.pos[1] = older.pos[1] + (newer.pos[1] - older.pos[1]) * t;
        out.pos[2] = older.pos[2] + (newer.pos[2] - older.pos[2]) * t;
        out.yaw = lerpAngle(older.yaw, newer.yaw, t);
      } else if (older) {
        // Ran out of newer samples: hold the last known position. Extrapolating
        // here would overshoot and then visibly snap back, which reads worse
        // than a brief pause.
        out.pos.set(older.pos);
        out.yaw = older.yaw;
        out.extrapolated = true;
      } else {
        const s = rec.samples[(rec.count - 1) % HISTORY];
        out.pos.set(s.pos);
        out.yaw = s.yaw;
        out.extrapolated = true;
      }

      out.yaw = wrapAngle(out.yaw);
      this.output.push(out);
    }

    return this.output;
  }
}
