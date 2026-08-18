/**
 * Binary wire format.
 *
 * Hand-written DataView reads and writes. Not JSON (5-8x larger and it churns
 * the GC), and not protobuf/flatbuffers (a dependency, and neither gives the
 * bit-level quantization control that makes the snapshot small).
 *
 * M0 sends complete snapshots. The `lastAckedSnapshotTick` field in INPUT and
 * the keyframe bit in SNAPSHOT are already on the wire so that delta
 * compression against the client's last acknowledged snapshot can be added at
 * M2 without a format break.
 */

import { POS_LIMIT, POS_SCALE, PROTOCOL_VERSION } from './constants.js';
import { clamp } from './math.js';

export const MSG_HELLO = 1;
export const MSG_INPUT = 2;
export const MSG_WELCOME = 3;
export const MSG_SNAPSHOT = 4;
export const MSG_REJECT = 5;
export const MSG_PING = 6;
export const MSG_PONG = 7;

export const REJECT_VERSION = 1;
export const REJECT_FULL = 2;
export const REJECT_BAD_ROOM = 3;

export const SNAP_KEYFRAME = 1 << 0;
export const ENT_ONGROUND = 1 << 0;

/**
 * `ackedInputTick` value meaning "this client's commands have not reached me
 * yet". Sent between joining and the first input packet arriving. The client
 * must not reconcile against these snapshots -- the state in them was produced
 * without running any of its commands, so comparing would discard perfectly
 * good prediction and cause a spurious resimulation once real acks begin.
 */
export const NO_ACK = 0xffff;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

// ---------------------------------------------------------------------------
// Tiny cursor helpers
// ---------------------------------------------------------------------------

class Writer {
  constructor(size) {
    this.buf = new ArrayBuffer(size);
    this.view = new DataView(this.buf);
    this.off = 0;
  }
  u8(v) { this.view.setUint8(this.off, v); this.off += 1; return this; }
  i8(v) { this.view.setInt8(this.off, v); this.off += 1; return this; }
  u16(v) { this.view.setUint16(this.off, v, true); this.off += 2; return this; }
  i16(v) { this.view.setInt16(this.off, v, true); this.off += 2; return this; }
  u32(v) { this.view.setUint32(this.off, v, true); this.off += 4; return this; }
  f32(v) { this.view.setFloat32(this.off, v, true); this.off += 4; return this; }
  str(s) {
    const bytes = textEncoder.encode(s.slice(0, 255));
    this.u8(bytes.length);
    new Uint8Array(this.buf, this.off, bytes.length).set(bytes);
    this.off += bytes.length;
    return this;
  }
  /** Returns exactly the bytes written, not the over-allocated buffer. */
  done() { return this.buf.slice(0, this.off); }
}

class Reader {
  constructor(buf) {
    this.view = new DataView(buf);
    this.buf = buf;
    this.off = 0;
  }
  u8() { const v = this.view.getUint8(this.off); this.off += 1; return v; }
  i8() { const v = this.view.getInt8(this.off); this.off += 1; return v; }
  u16() { const v = this.view.getUint16(this.off, true); this.off += 2; return v; }
  i16() { const v = this.view.getInt16(this.off, true); this.off += 2; return v; }
  u32() { const v = this.view.getUint32(this.off, true); this.off += 4; return v; }
  f32() { const v = this.view.getFloat32(this.off, true); this.off += 4; return v; }
  str() {
    const len = this.u8();
    const s = textDecoder.decode(new Uint8Array(this.buf, this.off, len));
    this.off += len;
    return s;
  }
  get remaining() { return this.buf.byteLength - this.off; }
}

export function messageType(buf) {
  return new DataView(buf).getUint8(0);
}

// ---------------------------------------------------------------------------
// Command quantization
// ---------------------------------------------------------------------------

/**
 * Converts raw analogue input into the exact integers that go on the wire.
 *
 * The client MUST predict with the output of this function rather than with
 * the raw values, or it simulates something subtly different from what the
 * server receives and mispredicts forever at a low level. This is one of the
 * most common netcode bugs and it is entirely avoided by quantizing first.
 */
export function quantizeCommand(forward, right, yawRadians, pitchRadians, buttons, weapon = 0) {
  const TAU = Math.PI * 2;
  let y = yawRadians % TAU;
  if (y < 0) y += TAU;
  return {
    forward: Math.round(clamp(forward, -1, 1) * 127),
    right: Math.round(clamp(right, -1, 1) * 127),
    yaw: Math.round((y / TAU) * 65536) & 0xffff,
    pitch: Math.round(clamp(pitchRadians / (Math.PI / 2), -1, 1) * 32767),
    buttons: buttons & 0xff,
    weapon: weapon & 0xff,
  };
}

export function emptyCommand() {
  return { forward: 0, right: 0, yaw: 0, pitch: 0, buttons: 0, weapon: 0 };
}

function quantPos(v) {
  return Math.round(clamp(v, -POS_LIMIT, POS_LIMIT) * POS_SCALE);
}

// ---------------------------------------------------------------------------
// Client -> server
// ---------------------------------------------------------------------------

export function encodeHello(name) {
  return new Writer(4 + 256).u8(MSG_HELLO).u16(PROTOCOL_VERSION).str(name).done();
}

export function decodeHello(buf) {
  const r = new Reader(buf);
  r.u8();
  return { protocolVersion: r.u16(), name: r.str() };
}

/**
 * @param {number} lastAckedSnapshotTick reserved for delta baselines (M2)
 * @param {number} firstCommandTick tick of commands[0]
 * @param {Array} commands includes a couple of already-acked ones for redundancy
 */
export function encodeInput(lastAckedSnapshotTick, firstCommandTick, commands) {
  const w = new Writer(6 + commands.length * 8);
  w.u8(MSG_INPUT);
  w.u16(lastAckedSnapshotTick & 0xffff);
  w.u16(firstCommandTick & 0xffff);
  w.u8(commands.length);
  for (const c of commands) {
    w.i8(c.forward);
    w.i8(c.right);
    w.u16(c.yaw);
    w.i16(c.pitch);
    w.u8(c.buttons);
    w.u8(c.weapon);
  }
  return w.done();
}

export function decodeInput(buf) {
  const r = new Reader(buf);
  r.u8();
  const lastAckedSnapshotTick = r.u16();
  const firstCommandTick = r.u16();
  const count = r.u8();
  const commands = [];
  for (let i = 0; i < count; i++) {
    commands.push({
      forward: r.i8(),
      right: r.i8(),
      yaw: r.u16(),
      pitch: r.i16(),
      buttons: r.u8(),
      weapon: r.u8(),
    });
  }
  return { lastAckedSnapshotTick, firstCommandTick, commands };
}

export function encodePing(clientTimeMs) {
  return new Writer(5).u8(MSG_PING).u32(clientTimeMs >>> 0).done();
}

export function decodePing(buf) {
  const r = new Reader(buf);
  r.u8();
  return { clientTimeMs: r.u32() };
}

// ---------------------------------------------------------------------------
// Server -> client
// ---------------------------------------------------------------------------

/**
 * Carries the spawn position so the client can start its simulation from
 * exactly the state the server will start from.
 *
 * Without this the client has to learn where it is from the first snapshot,
 * by which time it has already predicted a hundred milliseconds of movement
 * from the wrong place -- and adopting the server position then resets its
 * position without resetting how many ticks it has simulated, which
 * desynchronizes the two for good.
 */
export function encodeWelcome(yourId, serverTick, team, mapName, spawnPos, spawnYaw) {
  return new Writer(22 + 256)
    .u8(MSG_WELCOME).u8(yourId).u16(serverTick & 0xffff).u8(team)
    .f32(spawnPos[0]).f32(spawnPos[1]).f32(spawnPos[2])
    .u16(spawnYaw & 0xffff)
    .str(mapName)
    .done();
}

export function decodeWelcome(buf) {
  const r = new Reader(buf);
  r.u8();
  const yourId = r.u8();
  const serverTick = r.u16();
  const team = r.u8();
  const spawnPos = new Float32Array([r.f32(), r.f32(), r.f32()]);
  const spawnYaw = r.u16();
  return { yourId, serverTick, team, spawnPos, spawnYaw, mapName: r.str() };
}

export function encodeReject(reason, message) {
  return new Writer(3 + 256).u8(MSG_REJECT).u8(reason).str(message).done();
}

export function decodeReject(buf) {
  const r = new Reader(buf);
  r.u8();
  return { reason: r.u8(), message: r.str() };
}

export function encodePong(clientTimeMs, serverTick) {
  return new Writer(7).u8(MSG_PONG).u32(clientTimeMs >>> 0).u16(serverTick & 0xffff).done();
}

export function decodePong(buf) {
  const r = new Reader(buf);
  r.u8();
  return { clientTimeMs: r.u32(), serverTick: r.u16() };
}

/**
 * @param {object} p
 * @param {number} p.serverTick
 * @param {number} p.ackedInputTick last command from this client that was run
 * @param {object} p.own authoritative state for the receiving client
 * @param {Array} p.entities every *other* player
 */
export function encodeSnapshot({ serverTick, ackedInputTick, own, entities }) {
  const w = new Writer(32 + entities.length * 9);
  w.u8(MSG_SNAPSHOT);
  w.u16(serverTick & 0xffff);
  w.u16(ackedInputTick & 0xffff);
  w.u8(SNAP_KEYFRAME);

  // Own state goes at full float32 precision: reconciliation compares the
  // client's predicted state against these numbers directly, so quantizing
  // them would trip the mispredict threshold on every single snapshot.
  w.f32(own.pos[0]); w.f32(own.pos[1]); w.f32(own.pos[2]);
  w.f32(own.vel[0]); w.f32(own.vel[1]); w.f32(own.vel[2]);
  w.u8(own.onGround ? ENT_ONGROUND : 0);

  w.u8(entities.length);
  for (const e of entities) {
    w.u8(e.id);
    w.i16(quantPos(e.pos[0]));
    w.i16(quantPos(e.pos[1]));
    w.i16(quantPos(e.pos[2]));
    w.u8((e.yaw >> 8) & 0xff); // u16 yaw down to 8 bits: 1.4 deg, plenty to
    w.u8((e.onGround ? ENT_ONGROUND : 0) | ((e.team & 3) << 4)); // pick 1 of 8 sprites
  }
  return w.done();
}

export function decodeSnapshot(buf) {
  const r = new Reader(buf);
  r.u8();
  const serverTick = r.u16();
  const ackedInputTick = r.u16();
  const flags = r.u8();

  const own = {
    pos: new Float32Array([r.f32(), r.f32(), r.f32()]),
    vel: new Float32Array([r.f32(), r.f32(), r.f32()]),
    onGround: false,
  };
  own.onGround = (r.u8() & ENT_ONGROUND) !== 0;

  const count = r.u8();
  const entities = [];
  for (let i = 0; i < count; i++) {
    const id = r.u8();
    const x = r.i16() / POS_SCALE;
    const y = r.i16() / POS_SCALE;
    const z = r.i16() / POS_SCALE;
    const yaw = r.u8() << 8;
    const state = r.u8();
    entities.push({
      id,
      pos: new Float32Array([x, y, z]),
      yaw,
      onGround: (state & ENT_ONGROUND) !== 0,
      team: (state >> 4) & 3,
    });
  }

  return { serverTick, ackedInputTick, flags, own, entities };
}
