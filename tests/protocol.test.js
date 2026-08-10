/**
 * Wire format round trips and quantization behaviour.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { POS_SCALE, PROTOCOL_VERSION } from '../shared/constants.js';
import * as proto from '../shared/protocol.js';

test('hello round trips', () => {
  const buf = proto.encodeHello('squidkid');
  assert.equal(proto.messageType(buf), proto.MSG_HELLO);
  const out = proto.decodeHello(buf);
  assert.equal(out.protocolVersion, PROTOCOL_VERSION);
  assert.equal(out.name, 'squidkid');
});

test('input round trips with every command intact', () => {
  const commands = [
    { forward: 127, right: -127, yaw: 0, pitch: 32767, buttons: 1, weapon: 0 },
    { forward: 0, right: 0, yaw: 65535, pitch: -32767, buttons: 255, weapon: 3 },
    { forward: -1, right: 1, yaw: 32768, pitch: 0, buttons: 0, weapon: 0 },
  ];
  const buf = proto.encodeInput(1234, 9999, commands);
  const out = proto.decodeInput(buf);
  assert.equal(out.lastAckedSnapshotTick, 1234);
  assert.equal(out.firstCommandTick, 9999);
  assert.deepEqual(out.commands, commands);
});

test('an input packet stays small', () => {
  const commands = new Array(4).fill(proto.emptyCommand());
  // 6 byte header + 8 per command. At 30Hz this is ~1.1 KB/s upstream.
  assert.equal(proto.encodeInput(0, 0, commands).byteLength, 6 + 4 * 8);
});

test('quantizeCommand clamps and wraps the way the server expects', () => {
  const c = proto.quantizeCommand(5, -5, -Math.PI / 2, 99, 0);
  assert.equal(c.forward, 127, 'forward clamps to the i8 range');
  assert.equal(c.right, -127, 'right clamps to the i8 range');
  assert.ok(c.yaw >= 0 && c.yaw <= 0xffff, 'yaw wraps into u16');
  assert.equal(c.pitch, 32767, 'pitch clamps to straight up');
});

test('quantizing is idempotent, so prediction and transmission agree', () => {
  // The client predicts with the output of quantizeCommand. Re-quantizing the
  // decoded values must not drift, or every tick mispredicts a little.
  const first = proto.quantizeCommand(0.37, -0.82, 2.4, 0.31, 3);
  const buf = proto.encodeInput(0, 0, [first]);
  const { commands } = proto.decodeInput(buf);
  assert.deepEqual(commands[0], first);
});

test('snapshot round trips, with own state at full precision', () => {
  const own = {
    pos: new Float32Array([123.456, -78.9, 24.125]),
    vel: new Float32Array([320, -0.5, 0]),
    onGround: true,
  };
  const entities = [
    { id: 7, pos: new Float32Array([100.25, -200.5, 24]), yaw: 0x4200, onGround: false, team: 1 },
    { id: 9, pos: new Float32Array([-1000, 1000, 0]), yaw: 0, onGround: true, team: 0 },
  ];
  const buf = proto.encodeSnapshot({
    serverTick: 4242, ackedInputTick: 77, own, entities,
  });
  const out = proto.decodeSnapshot(buf);

  assert.equal(out.serverTick, 4242);
  assert.equal(out.ackedInputTick, 77);
  assert.ok(out.flags & proto.SNAP_KEYFRAME);

  // Own state is float32 on the wire, so it survives exactly.
  assert.deepEqual([...out.own.pos], [...own.pos]);
  assert.deepEqual([...out.own.vel], [...own.vel]);
  assert.equal(out.own.onGround, true);

  // Remote positions are quantized; the error must stay under half a step.
  const tolerance = 0.5 / POS_SCALE;
  for (let i = 0; i < entities.length; i++) {
    assert.equal(out.entities[i].id, entities[i].id);
    assert.equal(out.entities[i].team, entities[i].team);
    assert.equal(out.entities[i].onGround, entities[i].onGround);
    for (let k = 0; k < 3; k++) {
      assert.ok(
        Math.abs(out.entities[i].pos[k] - entities[i].pos[k]) <= tolerance,
        `entity ${i} axis ${k} drifted too far`,
      );
    }
  }
});

test('snapshot size stays within the bandwidth budget', () => {
  const own = {
    pos: new Float32Array(3), vel: new Float32Array(3), onGround: false,
  };
  const entities = [];
  for (let i = 0; i < 15; i++) {
    entities.push({
      id: i, pos: new Float32Array(3), yaw: 0, onGround: false, team: i & 1,
    });
  }
  const buf = proto.encodeSnapshot({ serverTick: 0, ackedInputTick: 0, own, entities });
  // 16 players at 30Hz should stay well under 10 KB/s down.
  assert.ok(buf.byteLength < 200, `snapshot was ${buf.byteLength} bytes`);
  assert.ok(buf.byteLength * 30 < 10 * 1024, 'downstream budget exceeded');
});

test('reject round trips', () => {
  const buf = proto.encodeReject(proto.REJECT_VERSION, 'reload the page');
  const out = proto.decodeReject(buf);
  assert.equal(out.reason, proto.REJECT_VERSION);
  assert.equal(out.message, 'reload the page');
});

test('ping/pong round trips', () => {
  const buf = proto.encodePong(4294967295, 65535);
  const out = proto.decodePong(buf);
  assert.equal(out.clientTimeMs, 4294967295);
  assert.equal(out.serverTick, 65535);
});
