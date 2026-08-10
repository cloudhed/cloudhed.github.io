/**
 * Server room logic, driven with fake connections so no sockets are involved.
 *
 * The important test here is the last one: that the client's predicted state
 * and the server's authoritative state agree tick for tick. If that holds, the
 * client never resimulates on a clean link, which is the whole premise of M0.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { BTN_JUMP, SNAPSHOT_INTERVAL } from '../shared/constants.js';
import * as proto from '../shared/protocol.js';
import { Room } from '../server/src/room.js';
import { Predictor } from '../game/src/net/predict.js';

function fakeConn() {
  return {
    sent: [],
    closed: false,
    send(buf) { this.sent.push(buf); },
    close() { this.closed = true; },
    /** Most recent message of a given type, decoded. */
    last(type) {
      for (let i = this.sent.length - 1; i >= 0; i--) {
        if (proto.messageType(this.sent[i]) === type) return this.sent[i];
      }
      return null;
    },
  };
}

/** Creates a room with `n` joined players, with the tick loop left under our control. */
function makeRoom(n = 1) {
  const room = new Room('TEST');
  const conns = [];
  const players = [];
  for (let i = 0; i < n; i++) {
    const conn = fakeConn();
    const player = room.addConnection(conn);
    room.onMessage(player.id, proto.encodeHello(`p${i}`));
    conns.push(conn);
    players.push(player);
  }
  room.stop(); // drive room.step() by hand rather than on a timer
  return { room, conns, players };
}

test('a client must say hello before it is simulated', () => {
  const room = new Room('TEST');
  const conn = fakeConn();
  const player = room.addConnection(conn);
  assert.equal(player.joined, false);

  // Input before the handshake is ignored.
  room.onMessage(player.id, proto.encodeInput(0, 0, [proto.quantizeCommand(1, 0, 0, 0, 0)]));
  assert.equal(player.commands.length, 0);

  room.onMessage(player.id, proto.encodeHello('someone'));
  room.stop();
  assert.equal(player.joined, true);
  assert.ok(conn.last(proto.MSG_WELCOME), 'should have been welcomed');
});

test('a protocol version mismatch is rejected with a readable message', () => {
  const room = new Room('TEST');
  const conn = fakeConn();
  const player = room.addConnection(conn);

  // Hand-build a hello claiming a different version.
  const bad = proto.encodeHello('old client');
  new DataView(bad).setUint16(1, 999, true);
  room.onMessage(player.id, bad);
  room.stop();

  const buf = conn.last(proto.MSG_REJECT);
  assert.ok(buf, 'should have been rejected');
  assert.equal(proto.decodeReject(buf).reason, proto.REJECT_VERSION);
  assert.equal(conn.closed, true);
  assert.equal(player.joined, false);
});

test('players spawn on alternating teams', () => {
  const { players } = makeRoom(4);
  const teams = players.map((p) => p.team);
  assert.equal(teams.filter((t) => t === 0).length, 2);
  assert.equal(teams.filter((t) => t === 1).length, 2);
});

test('redundantly resent commands are executed exactly once', () => {
  const { room, players } = makeRoom(1);
  const p = players[0];
  const cmd = proto.quantizeCommand(1, 0, 0, 0, 0);

  // Three packets, overlapping the way the real client's redundancy works.
  room.onMessage(p.id, proto.encodeInput(0, 0, [cmd, cmd]));
  room.onMessage(p.id, proto.encodeInput(0, 1, [cmd, cmd])); // 1 is a repeat
  room.onMessage(p.id, proto.encodeInput(0, 0, [cmd, cmd])); // both repeats

  assert.equal(p.commands.length, 3, 'ticks 0,1,2 exactly once each');
  assert.deepEqual(p.commands.map((c) => c.tick), [0, 1, 2]);
});

test('a client cannot bank up input and replay it as a speed burst', () => {
  const { room, players } = makeRoom(1);
  const p = players[0];
  const cmd = proto.quantizeCommand(1, 0, 0, 0, 0);
  const many = new Array(200).fill(cmd);
  for (let i = 0; i < 200; i += 8) {
    room.onMessage(p.id, proto.encodeInput(0, i, many.slice(i, i + 8)));
  }
  assert.ok(p.commands.length <= 32, `queue grew to ${p.commands.length}`);
});

test('snapshots carry every other player and omit the recipient', () => {
  const { room, conns, players } = makeRoom(3);
  for (let i = 0; i < SNAPSHOT_INTERVAL; i++) room.step();

  for (let i = 0; i < 3; i++) {
    const buf = conns[i].last(proto.MSG_SNAPSHOT);
    assert.ok(buf, `player ${i} should have received a snapshot`);
    const snap = proto.decodeSnapshot(buf);
    assert.equal(snap.entities.length, 2);
    const ids = snap.entities.map((e) => e.id).sort();
    const expected = players.filter((p) => p.id !== players[i].id).map((p) => p.id).sort();
    assert.deepEqual(ids, expected);
  }
});

test('a player who leaves disappears from everyone else\'s snapshots', () => {
  const { room, conns, players } = makeRoom(2);
  room.removeConnection(players[1].id);
  for (let i = 0; i < SNAPSHOT_INTERVAL; i++) room.step();

  const snap = proto.decodeSnapshot(conns[0].last(proto.MSG_SNAPSHOT));
  assert.equal(snap.entities.length, 0);
});

test('the room stops ticking once the last player leaves', () => {
  const { room, players } = makeRoom(1);
  room.start();
  assert.equal(room.running, true);
  room.removeConnection(players[0].id);
  assert.equal(room.running, false, 'an empty room must not keep billing time');
});

test('client prediction matches server simulation tick for tick', () => {
  const { room, conns, players } = makeRoom(1);
  const player = players[0];

  const welcome = proto.decodeWelcome(conns[0].last(proto.MSG_WELCOME));
  const predictor = new Predictor(room.world);
  predictor.reset(welcome.spawnPos);

  let yaw = 0;
  let mispredicts = 0;

  for (let i = 0; i < 400; i++) {
    yaw += 0.017;
    const cmd = proto.quantizeCommand(
      1, Math.sin(i * 0.05), yaw, 0, i % 5 === 0 ? BTN_JUMP : 0,
    );

    const tick = predictor.tick;
    predictor.step(cmd);

    // Deliver that same command to the server and let it run one tick.
    room.onMessage(player.id, proto.encodeInput(0, tick & 0xffff, [cmd]));
    room.step();

    // The server has now consumed exactly this command, so its state must
    // match what the client predicted for the same tick.
    if (predictor.reconcile(player.ackedInputTick, player.state)) mispredicts++;
  }

  assert.equal(
    mispredicts, 0,
    `prediction diverged from the server on ${mispredicts} of 400 ticks`,
  );
  assert.equal(predictor.resimulations, 0);
});

test('prediction recovers and smooths when the server disagrees', () => {
  const { room, conns, players } = makeRoom(1);
  const player = players[0];
  const predictor = new Predictor(room.world);
  predictor.reset(proto.decodeWelcome(conns[0].last(proto.MSG_WELCOME)).spawnPos);

  const cmd = proto.quantizeCommand(1, 0, 0, 0, 0);
  for (let i = 0; i < 60; i++) {
    const tick = predictor.tick;
    predictor.step(cmd);
    room.onMessage(player.id, proto.encodeInput(0, tick & 0xffff, [cmd]));
    room.step();
    predictor.reconcile(player.ackedInputTick, player.state);
  }

  // Shove the server's version sideways, as a knockback or a correction would.
  player.state.pos[1] += 40;
  const before = predictor.state.pos[1];
  const resimmed = predictor.reconcile(player.ackedInputTick, player.state);

  assert.equal(resimmed, true, 'a 40 unit disagreement must trigger a resim');
  assert.ok(
    Math.abs(predictor.state.pos[1] - before) > 1,
    'the simulation state should have moved to the server position',
  );
  // ...but the *drawn* position should barely have moved, because the error is
  // absorbed into the smoothing offset.
  const renderY = predictor.getRenderPos()[1];
  assert.ok(
    Math.abs(renderY - before) < 0.01,
    `render position jumped by ${Math.abs(renderY - before)} instead of easing`,
  );

  // And that offset decays away rather than persisting.
  for (let i = 0; i < 30; i++) predictor.decayError(1 / 60);
  assert.ok(
    Math.hypot(...predictor.error) < 0.5,
    'the correction should have been absorbed within ~half a second',
  );
});
