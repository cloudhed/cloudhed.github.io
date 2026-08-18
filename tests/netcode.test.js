/**
 * The M0 acceptance test.
 *
 * Runs a real Room and a real Predictor against each other through a simulated
 * link with latency and packet loss, and asserts the things that actually
 * matter: that the client rarely has to resimulate, that corrections stay small
 * enough to be smoothed invisibly, and that input redundancy does its job.
 *
 * This is deliberately not a browser test. Netcode correctness is a property of
 * the simulation loop, and testing it headlessly means it can be checked on
 * every change rather than by squinting at a screen.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { BTN_JUMP, INPUT_REDUNDANCY } from '../shared/constants.js';
import { xorshift32 } from '../shared/math.js';
import * as proto from '../shared/protocol.js';
import { Predictor } from '../game/src/net/predict.js';
import { Room } from '../server/src/room.js';

/**
 * Drives a client and server through a lossy, laggy link for `ticks` ticks.
 *
 * @param {object} opts
 * @param {number} opts.latencyTicks one-way delay, in 60Hz ticks
 * @param {number} opts.loss probability of dropping a client->server packet
 * @param {boolean} [opts.redundancy] whether to resend recent commands
 */
function simulate({ latencyTicks, loss, ticks = 1200, redundancy = true, seed = 4242 }) {
  const room = new Room('TEST');
  const conn = {
    sent: [],
    send(buf) { this.sent.push(buf); },
    close() {},
  };
  const player = room.addConnection(conn);
  room.onMessage(player.id, proto.encodeHello('client'));
  room.stop(); // we drive room.step() ourselves

  // Initialize exactly the way the real client does: from the WELCOME message.
  const welcome = proto.decodeWelcome(
    conn.sent.find((b) => proto.messageType(b) === proto.MSG_WELCOME),
  );
  const predictor = new Predictor(room.world);
  predictor.reset(welcome.spawnPos);

  const rng = xorshift32(seed);
  /** @type {{at: number, buf: ArrayBuffer}[]} */
  const toServer = [];
  const toClient = [];

  const recent = [];
  let sinceSend = 0;
  let lastAckedSnapshotTick = 0;
  let maxError = 0;
  let yaw = 0;
  let droppedPackets = 0;

  for (let t = 0; t < ticks; t++) {
    // --- client simulation tick ---
    yaw += 0.013;
    const cmd = proto.quantizeCommand(
      1, Math.sin(t * 0.03), yaw, 0, t % 9 === 0 ? BTN_JUMP : 0,
    );
    const tick = predictor.tick;
    predictor.step(cmd);
    recent.push({ ...cmd, tick });
    if (recent.length > 24) recent.shift();
    sinceSend++;

    // --- client transmits at 30Hz ---
    if (t % 2 === 0 && sinceSend > 0) {
      const extra = redundancy ? INPUT_REDUNDANCY : 0;
      const count = Math.min(recent.length, sinceSend + extra);
      const batch = recent.slice(recent.length - count);
      const buf = proto.encodeInput(lastAckedSnapshotTick, batch[0].tick & 0xffff, batch);
      sinceSend = 0;
      if (rng() >= loss) toServer.push({ at: t + latencyTicks, buf });
      else droppedPackets++;
    }

    // --- link -> server ---
    while (toServer.length && toServer[0].at <= t) {
      room.onMessage(player.id, toServer.shift().buf);
    }

    // --- server tick (may emit snapshots into conn.sent) ---
    conn.sent.length = 0;
    room.step();
    for (const buf of conn.sent) {
      if (proto.messageType(buf) === proto.MSG_SNAPSHOT) {
        toClient.push({ at: t + latencyTicks, buf });
      }
    }

    // --- link -> client ---
    while (toClient.length && toClient[0].at <= t) {
      const snap = proto.decodeSnapshot(toClient.shift().buf);
      lastAckedSnapshotTick = snap.serverTick;
      predictor.reconcile(snap.ackedInputTick, snap.own);
      const err = Math.hypot(...predictor.error);
      if (err > maxError) maxError = err;
    }

    predictor.decayError(1 / 60);
  }

  return { predictor, player, maxError, droppedPackets, ticks };
}

test('a clean link never needs to resimulate', () => {
  const r = simulate({ latencyTicks: 0, loss: 0, ticks: 600 });
  assert.equal(
    r.predictor.resimulations, 0,
    'prediction and the server should agree exactly with no impairment',
  );
});

test('latency alone does not cause mispredicts', () => {
  // 5 ticks each way is ~167ms round trip. Prediction runs ahead of the server
  // and they still agree, because both run the same commands through the same
  // deterministic step function.
  const r = simulate({ latencyTicks: 5, loss: 0, ticks: 1200 });
  assert.equal(
    r.predictor.resimulations, 0,
    `latency alone caused ${r.predictor.resimulations} resims`,
  );
  assert.equal(r.predictor.snapped, 0, 'no hard snaps on a lossless link');
});

test('M0 target: 150ms round trip with 5% loss stays smooth', () => {
  const r = simulate({ latencyTicks: 5, loss: 0.05, ticks: 1800 });

  assert.ok(r.droppedPackets > 20, `expected real loss, only dropped ${r.droppedPackets}`);

  // With 4x input redundancy covering three consecutive packets, 5% loss should
  // not reach the server as a command gap at all -- so this budget is tight on
  // purpose. If it starts failing, redundancy or gap-filling has regressed.
  const resimRate = r.predictor.resimulations / (r.ticks / 60);
  assert.ok(
    resimRate < 0.2,
    `resimulating ${resimRate.toFixed(2)} times/second is too often`,
  );
  assert.ok(
    r.maxError < 3,
    `worst correction was ${r.maxError.toFixed(2)} units; should stay small`,
  );
  assert.equal(
    r.predictor.snapped, 0,
    'corrections should never be large enough to force a visible snap',
  );
});

test('input redundancy is what makes packet loss survivable', () => {
  const withIt = simulate({ latencyTicks: 5, loss: 0.12, ticks: 1800, redundancy: true });
  const without = simulate({ latencyTicks: 5, loss: 0.12, ticks: 1800, redundancy: false });

  assert.ok(
    withIt.predictor.resimulations < without.predictor.resimulations,
    `redundancy should reduce resims (${withIt.predictor.resimulations} vs ` +
    `${without.predictor.resimulations})`,
  );
});

test('the client keeps up with the server rather than drifting behind', () => {
  // Prediction exists so the local player moves immediately. Over a long run
  // the client's tick should stay ahead of the last tick the server confirmed,
  // by roughly the latency -- not fall progressively behind.
  const r = simulate({ latencyTicks: 5, loss: 0.05, ticks: 1800 });
  const acked = r.predictor.findFullTick(r.player.ackedInputTick);
  assert.ok(acked >= 0, 'the acked tick should still be within the input history');
  const lead = r.predictor.tick - acked;
  assert.ok(lead > 0, 'the client must be predicting ahead of the server');
  assert.ok(lead < 40, `client is ${lead} ticks ahead; prediction has run away`);
});

test('a severe link degrades without breaking', () => {
  // 400ms round trip and 25% loss is worse than anything a school network
  // should produce. It should still be playing, not diverging.
  const r = simulate({ latencyTicks: 12, loss: 0.25, ticks: 1800 });
  assert.ok(
    Number.isFinite(r.predictor.state.pos[0]),
    'simulation must not produce NaN under stress',
  );
  // Gap-filling keeps corrections tiny even here: the server synthesizes the
  // missing commands rather than falling a tick of movement behind.
  assert.ok(r.maxError < 5, `worst correction ${r.maxError.toFixed(1)} units`);
});
