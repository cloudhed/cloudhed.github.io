/**
 * Simulation tests. Everything in /shared is a pure function with no DOM and no
 * Three.js dependency, so it runs directly under `node --test`.
 *
 * Note what is deliberately NOT asserted: bit-exact agreement across JS
 * engines. Math.sin/cos/atan2 are not bit-identical between V8, JavaScriptCore
 * and SpiderMonkey, and chasing that costs weeks for nothing -- reconciliation
 * exists precisely to absorb that drift. What we do assert is that the same
 * engine replaying the same inputs gives the same result, which is what catches
 * accidental Math.random / Date / shared-mutable-state leakage.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BTN_JUMP, DT, MAX_SPEED, PLAYER_MAXS, PLAYER_MINS, STEP_HEIGHT,
} from '../shared/constants.js';
import { compileMap } from '../shared/map.js';
import testbox from '../shared/maps/testbox.js';
import { copyPlayerState, createPlayerState, stepPlayer } from '../shared/pmove.js';
import { emptyCommand, quantizeCommand } from '../shared/protocol.js';
import { createTrace, traceBox } from '../shared/trace.js';

const world = compileMap(testbox);

function spawnAt(x, y, z) {
  const s = createPlayerState();
  s.pos.set([x, y, z]);
  return s;
}

function cmd(overrides = {}) {
  return { ...emptyCommand(), ...overrides };
}

/** Runs `n` ticks of the same command. */
function run(state, c, n) {
  for (let i = 0; i < n; i++) stepPlayer(state, c, world);
  return state;
}

// ---------------------------------------------------------------------------

test('a player dropped in the arena settles on the floor and stays there', () => {
  const s = spawnAt(-600, 0, 200);
  run(s, cmd(), 120);
  assert.ok(s.onGround, 'should be standing on the floor');
  assert.ok(Math.abs(s.pos[2] - 24) < 0.5, `expected to rest at z=24, got ${s.pos[2]}`);
  // And should not creep once at rest.
  const restZ = s.pos[2];
  run(s, cmd(), 60);
  assert.ok(Math.abs(s.pos[2] - restZ) < 0.01, 'resting height should be stable');
});

// 60 ticks is ample to reach top speed (it takes 8) while staying well clear of
// the centre pillar, which is what a longer run would slam into.
const RUNWAY_TICKS = 60;

test('walking forward reaches max speed and no further', () => {
  const s = spawnAt(-600, 0, 40);
  run(s, cmd(), 30); // land first
  run(s, cmd({ forward: 127 }), RUNWAY_TICKS);
  const speed = Math.hypot(s.vel[0], s.vel[1]);
  assert.ok(speed > MAX_SPEED - 5, `expected ~${MAX_SPEED}, got ${speed.toFixed(1)}`);
  assert.ok(speed < MAX_SPEED + 5, `ground speed should cap at ${MAX_SPEED}`);
});

test('diagonal input is not faster than cardinal input', () => {
  const straight = spawnAt(-600, 0, 40);
  run(straight, cmd(), 30);
  run(straight, cmd({ forward: 127 }), RUNWAY_TICKS);

  const diagonal = spawnAt(-600, 0, 40);
  run(diagonal, cmd(), 30);
  run(diagonal, cmd({ forward: 127, right: 127 }), RUNWAY_TICKS);

  const a = Math.hypot(straight.vel[0], straight.vel[1]);
  const b = Math.hypot(diagonal.vel[0], diagonal.vel[1]);
  assert.ok(Math.abs(a - b) < 2, `diagonal ${b.toFixed(1)} vs straight ${a.toFixed(1)}`);
});

test('jumping leaves the ground and gravity brings you back', () => {
  const s = spawnAt(-600, 0, 40);
  run(s, cmd(), 30);
  assert.ok(s.onGround);

  stepPlayer(s, cmd({ buttons: BTN_JUMP }), world);
  assert.equal(s.onGround, false, 'should leave the ground on the jump tick');
  assert.ok(s.vel[2] > 0, 'should be moving upwards');

  run(s, cmd(), 120);
  assert.ok(s.onGround, 'should land again');
});

test('holding jump auto-hops rather than sticking to the floor', () => {
  const s = spawnAt(-600, 0, 40);
  run(s, cmd(), 30);
  let airborneTicks = 0;
  for (let i = 0; i < 180; i++) {
    stepPlayer(s, cmd({ buttons: BTN_JUMP }), world);
    if (!s.onGround) airborneTicks++;
  }
  // With no landing delay the player should spend most of the time in the air.
  assert.ok(airborneTicks > 140, `only airborne for ${airborneTicks}/180 ticks`);
});

test('strafe-jumping gains speed beyond the ground cap', () => {
  // The classic technique: hold forward + strafe, and turn steadily into the
  // strafe while airborne. If someone "fixes" pmove by clamping speed after
  // accelerating, this test is what fails.
  const s = spawnAt(0, -600, 40);
  run(s, cmd(), 30);

  let yaw = 0;
  for (let i = 0; i < 400; i++) {
    // Turn gently; strafe right the whole time.
    yaw += 0.010;
    const c = quantizeCommand(1, 1, yaw, 0, BTN_JUMP);
    stepPlayer(s, c, world);
  }
  const speed = Math.hypot(s.vel[0], s.vel[1]);
  assert.ok(
    speed > MAX_SPEED * 1.15,
    `strafe-jumping should exceed ${MAX_SPEED}, only reached ${speed.toFixed(1)}`,
  );
});

test('walking into a wall stops movement without tunnelling through it', () => {
  // Head straight at the centre pillar (a 128-unit cube at the origin).
  const s = spawnAt(-300, 0, 40);
  run(s, cmd(), 30);
  run(s, cmd({ forward: 127 }), 240);
  assert.ok(s.pos[0] < -64, `should be stopped west of the pillar, at x=${s.pos[0]}`);
});

test('inside corners do not trap the player', () => {
  // Push diagonally into the corner formed by the west and south walls, then
  // reverse: if the two-plane crease case is missing, the player sticks.
  const s = spawnAt(-700, -700, 40);
  run(s, cmd(), 30);
  run(s, quantizeCommand(1, 0, Math.PI * 1.25, 0, 0), 120);
  const stuckX = s.pos[0];
  const stuckY = s.pos[1];

  run(s, quantizeCommand(1, 0, Math.PI * 0.25, 0, 0), 60);
  const moved = Math.hypot(s.pos[0] - stuckX, s.pos[1] - stuckY);
  assert.ok(moved > 50, `should escape the corner, only moved ${moved.toFixed(1)}`);
});

/**
 * Walks east from `startX` and reports what happened along the way. Peak height
 * has to be sampled during the traversal: at 320 u/s the player crosses these
 * features in well under a second and ends up back on the floor beyond them.
 */
function walkEast(startX, ticks) {
  const s = spawnAt(startX, 0, 40);
  run(s, cmd(), 30);
  const startZ = s.pos[2];
  const c = quantizeCommand(1, 0, 0, 0, 0);
  let maxZ = -Infinity;
  let groundedWhileRaised = false;
  for (let i = 0; i < ticks; i++) {
    stepPlayer(s, c, world);
    if (s.pos[2] > maxZ) maxZ = s.pos[2];
    if (s.onGround && s.pos[2] > startZ + 10) groundedWhileRaised = true;
  }
  return { state: s, startZ, maxZ, groundedWhileRaised };
}

test('stairs are walked up without jumping', () => {
  // The staircase sits at x -400..-208 with four 16-unit risers.
  const r = walkEast(-500, 180);
  assert.ok(
    r.maxZ > r.startZ + STEP_HEIGHT,
    `should have climbed the stairs, peak z ${r.maxZ} vs start ${r.startZ}`,
  );
  assert.ok(r.groundedWhileRaised, 'should be walking on the steps, not flying over them');
});

test('the ramp is walkable, which an AABB-only collision system could not do', () => {
  const r = walkEast(150, 180);
  assert.ok(
    r.maxZ > r.startZ + 40,
    `should have risen up the slope, peak z ${r.maxZ} vs start ${r.startZ}`,
  );
  assert.ok(r.groundedWhileRaised, 'should be standing on the slope, not sliding off it');
});

test('slide movement never leaves the player inside a brush', () => {
  // Fuzz: fire the player at the geometry from random angles at high speed and
  // assert we never end a tick embedded in something solid.
  const tr = createTrace();
  let seed = 12345;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };

  let tested = 0;
  for (let iter = 0; iter < 300; iter++) {
    const s = spawnAt((rand() - 0.5) * 1200, (rand() - 0.5) * 1200, 40 + rand() * 200);
    // A random point may land inside a pillar. That is a bad start position,
    // not a collision bug -- skip it rather than assert on it.
    traceBox(tr, s.pos, s.pos, PLAYER_MINS, PLAYER_MAXS, world);
    if (tr.startsolid) continue;
    tested++;

    const yaw = rand() * Math.PI * 2;
    const c = quantizeCommand(1, rand() * 2 - 1, yaw, 0, rand() > 0.5 ? BTN_JUMP : 0);
    for (let i = 0; i < 90; i++) {
      stepPlayer(s, c, world);
      traceBox(tr, s.pos, s.pos, PLAYER_MINS, PLAYER_MAXS, world);
      assert.equal(
        tr.startsolid, false,
        `embedded in geometry at iter ${iter} tick ${i}, pos ${[...s.pos]}`,
      );
    }
  }
  assert.ok(tested > 200, `fuzz should exercise most iterations, only ran ${tested}`);
});

test('replaying identical commands from identical state gives identical results', () => {
  // This is the determinism guarantee reconciliation actually needs: same
  // engine, same inputs, same outcome. It catches Math.random, Date, and
  // leaked mutable module state -- not cross-engine float differences.
  const commands = [];
  let yaw = 0;
  for (let i = 0; i < 300; i++) {
    yaw += 0.02;
    commands.push(quantizeCommand(
      Math.sin(i * 0.3), Math.cos(i * 0.17), yaw, 0,
      i % 7 === 0 ? BTN_JUMP : 0,
    ));
  }

  const runOnce = () => {
    const s = spawnAt(-600, 0, 40);
    for (const c of commands) stepPlayer(s, c, world);
    return s;
  };

  const a = runOnce();
  const b = runOnce();
  assert.deepEqual([...a.pos], [...b.pos]);
  assert.deepEqual([...a.vel], [...b.vel]);
  assert.equal(a.onGround, b.onGround);
});

test('rewinding and replaying reproduces the uninterrupted result', () => {
  // The core reconciliation guarantee: replaying commands from a saved state
  // must land exactly where simulating straight through would have.
  const commands = [];
  let yaw = 0;
  for (let i = 0; i < 200; i++) {
    yaw += 0.03;
    commands.push(quantizeCommand(1, Math.sin(i * 0.1), yaw, 0, i % 11 === 0 ? BTN_JUMP : 0));
  }

  const straight = spawnAt(-600, 0, 40);
  for (const c of commands) stepPlayer(straight, c, world);

  const rewound = spawnAt(-600, 0, 40);
  const checkpoint = createPlayerState();
  const SPLIT = 120;
  for (let i = 0; i < SPLIT; i++) stepPlayer(rewound, commands[i], world);
  copyPlayerState(checkpoint, rewound);
  // Wander off, then rewind to the checkpoint and replay the real commands.
  for (let i = 0; i < 30; i++) stepPlayer(rewound, quantizeCommand(-1, 0, 3, 0, 0), world);
  copyPlayerState(rewound, checkpoint);
  for (let i = SPLIT; i < commands.length; i++) stepPlayer(rewound, commands[i], world);

  assert.deepEqual([...rewound.pos], [...straight.pos]);
  assert.deepEqual([...rewound.vel], [...straight.vel]);
});

test('DT is a fixed timestep, not a frame delta', () => {
  assert.equal(DT, 1 / 60);
});
