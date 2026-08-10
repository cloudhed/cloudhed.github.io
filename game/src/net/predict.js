/**
 * Client-side prediction and server reconciliation for the local player.
 *
 * The client simulates its own movement immediately rather than waiting for the
 * server, so input has zero perceived delay. When the server's authoritative
 * version of a past tick arrives, we compare it against what we predicted for
 * that same tick; if they disagree we rewind to the server's state and replay
 * every command issued since.
 *
 * The part that is easy to skip and ruins the feel: after a correction, the
 * difference between where we *were* drawing the player and where they *now*
 * are is kept as a decaying offset applied to the render position only. Without
 * it every correction is a visible snap, and the game reads as broken even
 * though the simulation is perfectly correct.
 */

import {
  ERROR_SMOOTH_TIME, INPUT_BUFFER_SIZE, RECONCILE_POS_TOLERANCE,
  RECONCILE_VEL_TOLERANCE,
} from '../../../shared/constants.js';
import { copyPlayerState, createPlayerState, stepPlayer } from '../../../shared/pmove.js';
import { emptyCommand, NO_ACK } from '../../../shared/protocol.js';

/** Beyond this the correction is a teleport, not a mispredict: snap, do not slide. */
const MAX_SMOOTHED_ERROR = 150;

export class Predictor {
  constructor(world) {
    this.world = world;
    this.state = createPlayerState();

    /** Monotonic client tick. Sent on the wire as `tick & 0xffff`. */
    this.tick = 0;

    /** Ring of {tick, cmd, state-after-cmd}, preallocated. */
    this.history = [];
    for (let i = 0; i < INPUT_BUFFER_SIZE; i++) {
      this.history.push({ tick: -1, cmd: emptyCommand(), state: createPlayerState() });
    }

    /** Render offset that absorbs corrections. Decays to zero. */
    this.error = new Float32Array(3);
    this.renderPos = new Float32Array(3);

    // Diagnostics for the debug overlay.
    this.resimulations = 0;
    this.lastResimSteps = 0;
    this.lastErrorMagnitude = 0;
    this.snapped = 0;

    /** Set once the server has told us where we actually spawned. */
    this.initialized = false;
  }

  /**
   * Starts a fresh simulation at the server-supplied spawn.
   *
   * The tick counter goes back to zero along with the state, so the client's
   * first command is the server's first command and both sides simulate the
   * same sequence from the same starting point.
   */
  reset(pos) {
    this.state.pos.set(pos);
    this.state.vel.set([0, 0, 0]);
    this.state.onGround = false;
    this.error[0] = this.error[1] = this.error[2] = 0;
    this.tick = 0;
    this.resimulations = 0;
    this.snapped = 0;
    this.initialized = true;
    for (const h of this.history) h.tick = -1;
  }

  /** Advances the local simulation by exactly one tick. */
  step(cmd) {
    const slot = this.history[this.tick % INPUT_BUFFER_SIZE];
    slot.tick = this.tick;
    slot.cmd.forward = cmd.forward;
    slot.cmd.right = cmd.right;
    slot.cmd.yaw = cmd.yaw;
    slot.cmd.pitch = cmd.pitch;
    slot.cmd.buttons = cmd.buttons;
    slot.cmd.weapon = cmd.weapon;

    stepPlayer(this.state, cmd, this.world);
    copyPlayerState(slot.state, this.state);

    this.tick++;
  }

  /** Finds the full tick number matching a 16-bit value from the wire. */
  findFullTick(tick16) {
    const oldest = Math.max(0, this.tick - INPUT_BUFFER_SIZE);
    for (let t = this.tick - 1; t >= oldest; t--) {
      if ((t & 0xffff) === tick16) return t;
    }
    return -1;
  }

  /**
   * @param {number} ackedInputTick16 last command the server actually ran
   * @param {{pos: Float32Array, vel: Float32Array, onGround: boolean}} serverState
   * @returns {boolean} whether a resimulation happened
   */
  reconcile(ackedInputTick16, serverState) {
    if (ackedInputTick16 === NO_ACK) {
      // The server has not run any of our commands yet -- we just joined and
      // our first packets are still in flight. There is nothing to compare
      // against: we already started from its spawn position (see WELCOME), and
      // it will run exactly the commands we are simulating right now.
      return false;
    }

    const acked = this.findFullTick(ackedInputTick16);
    if (acked < 0) {
      // Older than our history (a long stall, or we just joined). Accept the
      // server's word for it and carry on from there.
      this.hardSnap(serverState);
      return true;
    }

    const slot = this.history[acked % INPUT_BUFFER_SIZE];
    if (slot.tick !== acked) {
      this.hardSnap(serverState);
      return true;
    }

    const dp = dist(slot.state.pos, serverState.pos);
    const dv = dist(slot.state.vel, serverState.vel);
    if (
      dp <= RECONCILE_POS_TOLERANCE &&
      dv <= RECONCILE_VEL_TOLERANCE &&
      slot.state.onGround === serverState.onGround
    ) {
      return false; // the common case, and it must stay cheap
    }

    // Remember where we were about to draw the player.
    const prevX = this.state.pos[0];
    const prevY = this.state.pos[1];
    const prevZ = this.state.pos[2];

    // Rewind to the server's authoritative state for that tick...
    this.state.pos.set(serverState.pos);
    this.state.vel.set(serverState.vel);
    this.state.onGround = serverState.onGround;
    copyPlayerState(slot.state, this.state);

    // ...and replay everything we have issued since.
    let steps = 0;
    for (let t = acked + 1; t < this.tick; t++) {
      const h = this.history[t % INPUT_BUFFER_SIZE];
      if (h.tick !== t) continue; // gap in history; nothing to replay
      stepPlayer(this.state, h.cmd, this.world);
      copyPlayerState(h.state, this.state);
      steps++;
    }

    // Fold the visual difference into the smoothing offset rather than letting
    // it show up as a jump.
    this.error[0] += prevX - this.state.pos[0];
    this.error[1] += prevY - this.state.pos[1];
    this.error[2] += prevZ - this.state.pos[2];

    const mag = Math.hypot(this.error[0], this.error[1], this.error[2]);
    this.lastErrorMagnitude = mag;
    if (mag > MAX_SMOOTHED_ERROR) {
      // Too far to be a prediction error. Snap and let the player see it.
      this.error[0] = this.error[1] = this.error[2] = 0;
      this.snapped++;
    }

    this.resimulations++;
    this.lastResimSteps = steps;
    return true;
  }

  hardSnap(serverState) {
    this.state.pos.set(serverState.pos);
    this.state.vel.set(serverState.vel);
    this.state.onGround = serverState.onGround;
    this.error[0] = this.error[1] = this.error[2] = 0;
    this.snapped++;
  }

  /** Exponential decay toward zero: ~99.9% gone after ERROR_SMOOTH_TIME. */
  decayError(dtSeconds) {
    const k = Math.pow(0.001, dtSeconds / ERROR_SMOOTH_TIME);
    this.error[0] *= k;
    this.error[1] *= k;
    this.error[2] *= k;
  }

  /** Simulated position plus the decaying correction: what to actually draw. */
  getRenderPos() {
    this.renderPos[0] = this.state.pos[0] + this.error[0];
    this.renderPos[1] = this.state.pos[1] + this.error[1];
    this.renderPos[2] = this.state.pos[2] + this.error[2];
    return this.renderPos;
  }
}

function dist(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}
