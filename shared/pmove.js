/**
 * Player movement. THE most important file in the project.
 *
 * `stepPlayer` is the one function client and server both run, verbatim, for
 * every simulation tick. Client prediction replays it dozens of times per frame
 * during reconciliation, so it must be:
 *
 *   - deterministic: no Math.random, no Date, no globals, no reading anything
 *     outside (state, cmd, world)
 *   - allocation-free: everything scratch is module-level
 *   - fixed-timestep: dt is always constants.DT, never a frame delta
 *
 * The movement is Quake 3 VQ3. The one thing you must not "fix": there is no
 * clamp on the resulting speed after accelerating. The `addspeed <= 0` test is
 * a *directional* limiter -- it caps how fast you go in the direction you are
 * pushing, which is exactly why pushing perpendicular to your velocity always
 * adds speed. That asymmetry is strafe-jumping. Adding a
 * `if (len(vel) > MAX_SPEED) normalize` anywhere ships a different game.
 */

import {
  ACCELERATE, AIR_ACCELERATE, AIR_WISH_CAP, BTN_JUMP, DT, FRICTION,
  GRAVITY, JUMP_VELOCITY, MAX_SPEED, MIN_WALK_NORMAL, OVERCLIP, PLAYER_MAXS,
  PLAYER_MINS, STEP_HEIGHT, STOP_SPEED,
} from './constants.js';
import { copy, cross, dot, normalize, set } from './math.js';
import { clipVelocity, createTrace, traceBox } from './trace.js';

const MAX_CLIP_PLANES = 5;

export function createPlayerState() {
  const s = {
    pos: new Float32Array(3),
    vel: new Float32Array(3),
    onGround: false,
    groundNormal: new Float32Array([0, 0, 1]),
  };
  return s;
}

export function copyPlayerState(dst, src) {
  dst.pos[0] = src.pos[0]; dst.pos[1] = src.pos[1]; dst.pos[2] = src.pos[2];
  dst.vel[0] = src.vel[0]; dst.vel[1] = src.vel[1]; dst.vel[2] = src.vel[2];
  dst.onGround = src.onGround;
  dst.groundNormal[0] = src.groundNormal[0];
  dst.groundNormal[1] = src.groundNormal[1];
  dst.groundNormal[2] = src.groundNormal[2];
  return dst;
}

// --- scratch ---------------------------------------------------------------
const _tr = createTrace();
const _forward = new Float32Array(3);
const _right = new Float32Array(3);
const _wishdir = new Float32Array(3);
const _end = new Float32Array(3);
const _startPos = new Float32Array(3);
const _startVel = new Float32Array(3);
const _downPos = new Float32Array(3);
const _downVel = new Float32Array(3);
const _target = new Float32Array(3);
const _clipVel = new Float32Array(3);
const _creaseDir = new Float32Array(3);
const _planes = [];
for (let i = 0; i < MAX_CLIP_PLANES + 1; i++) _planes.push(new Float32Array(3));

/** Decodes the quantized u16 yaw from a command back to radians. */
export function decodeYaw(q) {
  return (q / 65536) * Math.PI * 2;
}

/** Decodes the quantized i16 pitch from a command back to radians. */
export function decodePitch(q) {
  return (q / 32767) * (Math.PI / 2);
}

function angleVectors(yaw) {
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  set(_forward, cy, sy, 0);
  set(_right, sy, -cy, 0);
}

/** Q3 PM_Friction. Only ground contact slows you down. */
function applyFriction(state) {
  const vel = state.vel;
  const speed = Math.sqrt(vel[0] * vel[0] + vel[1] * vel[1] + vel[2] * vel[2]);
  if (speed < 1) {
    vel[0] = 0;
    vel[1] = 0;
    return;
  }
  let drop = 0;
  if (state.onGround) {
    const control = speed < STOP_SPEED ? STOP_SPEED : speed;
    drop += control * FRICTION * DT;
  }
  let newspeed = speed - drop;
  if (newspeed < 0) newspeed = 0;
  newspeed /= speed;
  vel[0] *= newspeed;
  vel[1] *= newspeed;
  vel[2] *= newspeed;
}

/**
 * Q3 PM_Accelerate. Note the absence of any speed clamp afterwards -- see the
 * warning at the top of this file.
 */
function accelerate(vel, wishdir, wishspeed, accel) {
  const currentspeed = dot(vel, wishdir);
  const addspeed = wishspeed - currentspeed;
  if (addspeed <= 0) return;
  let accelspeed = accel * wishspeed * DT;
  if (accelspeed > addspeed) accelspeed = addspeed;
  vel[0] += wishdir[0] * accelspeed;
  vel[1] += wishdir[1] * accelspeed;
  vel[2] += wishdir[2] * accelspeed;
}

/**
 * Builds the wish direction from the command and returns the wish speed.
 * Diagonal input is normalized so it is not faster than cardinal, which also
 * serves as the server-side clamp on a client lying about its input.
 */
function buildWish(cmd) {
  const fm = cmd.forward;
  const sm = cmd.right;
  const maxAxis = Math.max(Math.abs(fm), Math.abs(sm));
  if (maxAxis === 0) {
    set(_wishdir, 0, 0, 0);
    return 0;
  }
  set(
    _wishdir,
    _forward[0] * fm + _right[0] * sm,
    _forward[1] * fm + _right[1] * sm,
    0,
  );
  normalize(_wishdir);
  // Q3 PM_CmdScale: cardinal and diagonal reach the same top speed.
  const scale = (MAX_SPEED * maxAxis) / 127;
  return scale > MAX_SPEED ? MAX_SPEED : scale;
}

function groundTrace(state, world) {
  set(_end, state.pos[0], state.pos[1], state.pos[2] - 0.25);
  traceBox(_tr, state.pos, _end, PLAYER_MINS, PLAYER_MAXS, world);

  if (_tr.fraction === 1) {
    state.onGround = false;
    return;
  }
  // Too steep to stand on.
  if (_tr.normal[2] < MIN_WALK_NORMAL) {
    state.onGround = false;
    return;
  }
  // Moving up and away from the surface (just jumped or launched).
  if (state.vel[2] > 0 && dot(state.vel, _tr.normal) > 10) {
    state.onGround = false;
    return;
  }
  state.onGround = true;
  copy(state.groundNormal, _tr.normal);
}

/**
 * Q3 PM_SlideMove. Advances along the velocity, clipping against everything it
 * hits. Returns true if it was blocked by anything.
 *
 * The two-plane crease case in the middle is what stops players sticking in
 * corners: clipping against two planes in sequence can leave the velocity
 * pointing back into the first, so instead the movement is projected onto the
 * line where they meet.
 */
function slideMove(state, world, timeLeftIn) {
  const pos = state.pos;
  const vel = state.vel;
  let timeLeft = timeLeftIn;
  let numplanes = 0;
  let blocked = false;

  if (state.onGround) {
    copy(_planes[numplanes++], state.groundNormal);
  }

  for (let bump = 0; bump < 4; bump++) {
    set(
      _end,
      pos[0] + vel[0] * timeLeft,
      pos[1] + vel[1] * timeLeft,
      pos[2] + vel[2] * timeLeft,
    );
    traceBox(_tr, pos, _end, PLAYER_MINS, PLAYER_MAXS, world);

    if (_tr.allsolid) {
      set(vel, 0, 0, 0);
      return true;
    }
    if (_tr.fraction > 0) copy(pos, _tr.endpos);
    if (_tr.fraction === 1) break;

    blocked = true;
    timeLeft -= timeLeft * _tr.fraction;

    if (numplanes >= MAX_CLIP_PLANES) {
      set(vel, 0, 0, 0);
      return true;
    }

    // Re-hitting a plane we already know about means we are wedged; nudge out
    // along its normal rather than clipping again.
    let repeat = false;
    for (let i = 0; i < numplanes; i++) {
      if (dot(_tr.normal, _planes[i]) > 0.99) {
        vel[0] += _tr.normal[0];
        vel[1] += _tr.normal[1];
        vel[2] += _tr.normal[2];
        repeat = true;
        break;
      }
    }
    if (repeat) continue;

    copy(_planes[numplanes++], _tr.normal);

    // Find a velocity that moves out of every plane we are touching.
    for (let i = 0; i < numplanes; i++) {
      if (dot(vel, _planes[i]) >= 0.1) continue;
      clipVelocity(_clipVel, vel, _planes[i], OVERCLIP);

      for (let j = 0; j < numplanes; j++) {
        if (j === i) continue;
        if (dot(_clipVel, _planes[j]) >= 0.1) continue;
        clipVelocity(_clipVel, _clipVel, _planes[j], OVERCLIP);
        // Still moving out of plane i? Then the two-plane clip was fine.
        if (dot(_clipVel, _planes[i]) >= 0) continue;

        // Otherwise slide along the crease where i and j meet.
        cross(_creaseDir, _planes[i], _planes[j]);
        normalize(_creaseDir);
        const d = dot(_creaseDir, vel);
        set(_clipVel, _creaseDir[0] * d, _creaseDir[1] * d, _creaseDir[2] * d);

        // A third plane in the way means there is nowhere left to go.
        for (let k = 0; k < numplanes; k++) {
          if (k === i || k === j) continue;
          if (dot(_clipVel, _planes[k]) >= 0.1) continue;
          set(vel, 0, 0, 0);
          return true;
        }
      }

      copy(vel, _clipVel);
      break;
    }
    // Falling out of that loop means we are already moving out of every plane,
    // so the velocity stands as-is.
  }

  return blocked;
}

/**
 * Q3 PM_StepSlideMove. If a plain slide was blocked, retry the whole move from
 * STEP_HEIGHT higher and drop back down, then keep whichever attempt travelled
 * further. This is what makes stairs work without ramps.
 */
function stepSlideMove(state, world) {
  copy(_startPos, state.pos);
  copy(_startVel, state.vel);

  if (!slideMove(state, world, DT)) return; // went the whole way, nothing to do

  copy(_downPos, state.pos);
  copy(_downVel, state.vel);

  // Do not try to step while moving upwards off a surface.
  set(_target, _startPos[0], _startPos[1], _startPos[2] - STEP_HEIGHT);
  traceBox(_tr, _startPos, _target, PLAYER_MINS, PLAYER_MAXS, world);
  if (state.vel[2] > 0 && (_tr.fraction === 1 || _tr.normal[2] < MIN_WALK_NORMAL)) {
    return;
  }

  // Step up.
  set(_target, _startPos[0], _startPos[1], _startPos[2] + STEP_HEIGHT);
  traceBox(_tr, _startPos, _target, PLAYER_MINS, PLAYER_MAXS, world);
  if (_tr.allsolid) return; // ceiling directly overhead
  const stepSize = _tr.endpos[2] - _startPos[2];

  copy(state.pos, _tr.endpos);
  copy(state.vel, _startVel);
  slideMove(state, world, DT);

  // Step back down.
  set(_target, state.pos[0], state.pos[1], state.pos[2] - stepSize);
  traceBox(_tr, state.pos, _target, PLAYER_MINS, PLAYER_MAXS, world);
  if (!_tr.allsolid) copy(state.pos, _tr.endpos);
  if (_tr.fraction < 1) {
    clipVelocity(state.vel, state.vel, _tr.normal, OVERCLIP);
  }

  // Keep whichever attempt covered more horizontal ground.
  const dx1 = _downPos[0] - _startPos[0];
  const dy1 = _downPos[1] - _startPos[1];
  const dx2 = state.pos[0] - _startPos[0];
  const dy2 = state.pos[1] - _startPos[1];
  if (dx1 * dx1 + dy1 * dy1 > dx2 * dx2 + dy2 * dy2) {
    copy(state.pos, _downPos);
    copy(state.vel, _downVel);
  }
}

/**
 * Advances one player by exactly one simulation tick.
 *
 * Mutates `state` in place -- the caller snapshots it with `copyPlayerState`
 * when it needs a history entry. It reads nothing outside its arguments, which
 * is what makes rollback and replay possible.
 *
 * @param {ReturnType<createPlayerState>} state
 * @param {{forward:number,right:number,yaw:number,pitch:number,buttons:number}} cmd
 *        Already quantized to its wire representation. Predicting with raw
 *        mouse floats while transmitting quantized values causes permanent
 *        low-grade mispredicts.
 * @param {{brushes:Array}} world
 */
export function stepPlayer(state, cmd, world) {
  angleVectors(decodeYaw(cmd.yaw));

  groundTrace(state, world);

  // Auto-hop: holding jump keeps you bouncing, with no landing delay. Q3's
  // 400ms lockout exists to discourage this; we want it.
  let jumped = false;
  if (state.onGround && (cmd.buttons & BTN_JUMP) !== 0) {
    state.onGround = false;
    state.vel[2] = JUMP_VELOCITY;
    jumped = true;
  }

  applyFriction(state);

  const wishspeed = buildWish(cmd);

  if (state.onGround) {
    // Project the wish direction onto the ground plane so slopes are walked at
    // full speed rather than pushed into.
    const into = dot(_wishdir, state.groundNormal);
    _wishdir[0] -= state.groundNormal[0] * into;
    _wishdir[1] -= state.groundNormal[1] * into;
    _wishdir[2] -= state.groundNormal[2] * into;
    normalize(_wishdir);

    accelerate(state.vel, _wishdir, wishspeed, ACCELERATE);
    clipVelocity(state.vel, state.vel, state.groundNormal, OVERCLIP);
  } else {
    const airWish = wishspeed > AIR_WISH_CAP ? AIR_WISH_CAP : wishspeed;
    accelerate(state.vel, _wishdir, airWish, AIR_ACCELERATE);
    // Gravity starts on the tick *after* the jump, so a jump always leaves the
    // ground at exactly JUMP_VELOCITY regardless of when in the tick it began.
    if (!jumped) state.vel[2] -= GRAVITY * DT;
  }

  // Nothing left to do if we are standing still on the ground.
  if (state.vel[0] === 0 && state.vel[1] === 0 && state.vel[2] === 0) return;

  stepSlideMove(state, world);
}
