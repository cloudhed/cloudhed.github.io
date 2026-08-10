/**
 * Authoritative game room. Runtime-agnostic on purpose: this file knows nothing
 * about Cloudflare or Node, only about `conn` objects with send()/close().
 * The adapters in ./adapters/ supply those.
 *
 * The room owns a fixed 60 Hz simulation driven by a self-correcting
 * accumulator anchored to an absolute epoch. A plain setInterval drifts, and
 * drift shows up as clients constantly mispredicting for no visible reason.
 */

import {
  DT, MAX_CATCHUP_STEPS, MAX_PLAYERS, PROTOCOL_VERSION, SNAPSHOT_INTERVAL,
} from '../../shared/constants.js';
import { compileMap } from '../../shared/map.js';
import testbox from '../../shared/maps/testbox.js';
import { copyPlayerState, createPlayerState, stepPlayer } from '../../shared/pmove.js';
import * as proto from '../../shared/protocol.js';

/** Kick a connection that has sent nothing at all for this long. */
const IDLE_TIMEOUT_MS = 60_000;

/** Commands buffered per player before we start dropping the oldest. */
const MAX_QUEUED_COMMANDS = 32;

/**
 * Largest burst of commands one player may have applied in a single tick.
 *
 * Credit refills at one per tick, so the sustained rate a client can achieve is
 * exactly the tick rate no matter what it sends -- there is no way to bank up
 * input and cash it in as a speed burst. The burst allowance just absorbs
 * normal network jitter, where two or three commands arrive together.
 */
const COMMAND_BURST = 8;

/**
 * Largest run of missing commands we will synthesize. Beyond this the client
 * has genuinely stalled rather than lost a packet or two, and inventing that
 * much input would be worse than letting it resynchronize.
 */
const MAX_GAP_FILL = 8;

/**
 * 16-bit sequence comparison: true when `a` is newer than `b`, tolerating
 * wraparound at 65535.
 */
function seqGreater(a, b) {
  const d = (a - b) & 0xffff;
  return d !== 0 && d < 0x8000;
}

export class Room {
  /**
   * @param {string} code the four-character room key
   * @param {{onEmpty?: () => void}} [hooks]
   */
  constructor(code, hooks = {}) {
    this.code = code;
    this.hooks = hooks;
    this.world = compileMap(testbox);
    /** @type {Map<number, any>} */
    this.players = new Map();
    this.nextId = 1;
    this.tick = 0;
    this.running = false;
    this.timer = null;
    this.epoch = 0;
    this.spawnCursor = { A: 0, B: 0 };
  }

  // -------------------------------------------------------------------------
  // Connection lifecycle
  // -------------------------------------------------------------------------

  /**
   * Registers a connection. The player is not simulated until it sends a valid
   * HELLO, so a port scanner cannot occupy a slot.
   * @param {{send: (b: ArrayBuffer) => void, close: () => void}} conn
   */
  addConnection(conn) {
    if (this.players.size >= MAX_PLAYERS) {
      conn.send(proto.encodeReject(proto.REJECT_FULL, 'This room is full.'));
      conn.close();
      return null;
    }

    const id = this.nextId++;
    if (this.nextId > 255) this.nextId = 1;

    const player = {
      id,
      conn,
      name: `player${id}`,
      team: this.pickTeam(),
      state: createPlayerState(),
      commands: [],
      lastCmdTick: 0xffff,
      ackedInputTick: proto.NO_ACK,
      lastCmd: proto.emptyCommand(),
      lastReceivedCmd: null,
      credits: COMMAND_BURST,
      lastSeenMs: Date.now(),
      joined: false,
      rttMs: 0,
    };
    this.spawn(player);
    this.players.set(id, player);
    return player;
  }

  removeConnection(id) {
    if (!this.players.delete(id)) return;
    if (this.players.size === 0) {
      this.stop();
      this.hooks.onEmpty?.();
    }
  }

  pickTeam() {
    let a = 0;
    let b = 0;
    for (const p of this.players.values()) {
      if (p.team === 0) a++;
      else b++;
    }
    return a <= b ? 0 : 1;
  }

  spawn(player) {
    const key = player.team === 0 ? 'A' : 'B';
    const list = this.world.spawns[key];
    const spot = list[this.spawnCursor[key] % list.length];
    this.spawnCursor[key]++;
    player.state.pos.set(spot.origin);
    player.state.vel.set([0, 0, 0]);
    player.state.onGround = false;
    player.spawnYaw = spot.yaw;
  }

  // -------------------------------------------------------------------------
  // Messages
  // -------------------------------------------------------------------------

  onMessage(id, buf) {
    const player = this.players.get(id);
    if (!player) return;
    player.lastSeenMs = Date.now();

    let type;
    try {
      type = proto.messageType(buf);
    } catch {
      return; // malformed; ignore rather than tearing the room down
    }

    switch (type) {
      case proto.MSG_HELLO:
        this.onHello(player, buf);
        break;
      case proto.MSG_INPUT:
        if (player.joined) this.onInput(player, buf);
        break;
      case proto.MSG_PING: {
        const { clientTimeMs } = proto.decodePing(buf);
        player.conn.send(proto.encodePong(clientTimeMs, this.tick));
        break;
      }
      default:
        break;
    }
  }

  onHello(player, buf) {
    if (player.joined) return;
    let hello;
    try {
      hello = proto.decodeHello(buf);
    } catch {
      return;
    }

    if (hello.protocolVersion !== PROTOCOL_VERSION) {
      player.conn.send(proto.encodeReject(
        proto.REJECT_VERSION,
        'This page is out of date. Reload to get the current version.',
      ));
      player.conn.close();
      return;
    }

    player.name = (hello.name || '').trim().slice(0, 20) || `player${player.id}`;
    player.joined = true;
    player.conn.send(proto.encodeWelcome(
      player.id, this.tick, player.team, this.world.name,
      player.state.pos, player.spawnYaw,
    ));
    this.start();
  }

  onInput(player, buf) {
    let msg;
    try {
      msg = proto.decodeInput(buf);
    } catch {
      return;
    }

    // Commands arrive with redundant copies of recent ones so that a dropped
    // packet does not create a gap. Keep only what we have not seen.
    for (let i = 0; i < msg.commands.length; i++) {
      const cmdTick = (msg.firstCommandTick + i) & 0xffff;
      if (!seqGreater(cmdTick, player.lastCmdTick)) continue;

      // Enough consecutive packets were lost that redundancy did not cover the
      // gap. Fill it by repeating the last command we did receive: input
      // changes slowly, so it is a close guess, and crucially it keeps our tick
      // count aligned with the client's. Simply skipping would leave the server
      // permanently a tick of movement behind what the client predicted, which
      // shows up as a correction every time.
      let gap = (cmdTick - player.lastCmdTick) & 0xffff;
      if (gap > 1 && gap <= MAX_GAP_FILL && player.lastReceivedCmd) {
        for (let t = gap - 1; t >= 1; t--) {
          player.commands.push({
            ...player.lastReceivedCmd,
            tick: (cmdTick - t) & 0xffff,
          });
        }
      }

      const cmd = msg.commands[i];
      cmd.tick = cmdTick;
      player.commands.push(cmd);
      player.lastReceivedCmd = cmd;
      player.lastCmdTick = cmdTick;
    }

    // A client that stops consuming (tabbed out, then returns) must not be able
    // to bank up minutes of input and replay it as a speed burst.
    if (player.commands.length > MAX_QUEUED_COMMANDS) {
      player.commands.splice(0, player.commands.length - MAX_QUEUED_COMMANDS);
    }
  }

  // -------------------------------------------------------------------------
  // Simulation
  // -------------------------------------------------------------------------

  start() {
    if (this.running) return;
    this.running = true;
    this.epoch = Date.now();
    this.scheduleNext();
  }

  stop() {
    this.running = false;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  scheduleNext() {
    if (!this.running) return;
    const dueMs = this.epoch + (this.tick + 1) * DT * 1000;
    const delay = Math.max(0, dueMs - Date.now());
    this.timer = setTimeout(() => this.onTimer(), delay);
  }

  onTimer() {
    if (!this.running) return;
    const now = Date.now();
    let steps = 0;
    while (
      now >= this.epoch + (this.tick + 1) * DT * 1000 &&
      steps < MAX_CATCHUP_STEPS
    ) {
      this.step();
      steps++;
    }
    // Descheduled long enough that catching up would be a burst of teleporting
    // players. Give up on the missed time and re-anchor instead.
    if (steps >= MAX_CATCHUP_STEPS) {
      this.epoch = now - this.tick * DT * 1000;
    }
    this.scheduleNext();
  }

  step() {
    const now = Date.now();

    for (const player of this.players.values()) {
      if (!player.joined) continue;

      if (now - player.lastSeenMs > IDLE_TIMEOUT_MS) {
        player.conn.close();
        continue;
      }

      // A player's simulation is driven by their command stream, not by our
      // frame rate. If nothing arrived this tick they simply do not advance,
      // and we catch up when the next packet lands.
      //
      // The alternative -- stepping every player every tick and repeating the
      // last command when the queue is dry -- desynchronizes permanently: the
      // server would apply a command the client never predicted, and since the
      // acknowledgement still points at the last *real* command the client
      // compares against the wrong history entry and resimulates forever.
      player.credits = Math.min(player.credits + 1, COMMAND_BURST);
      while (player.commands.length > 0 && player.credits > 0) {
        const cmd = player.commands.shift();
        stepPlayer(player.state, cmd, this.world);
        player.lastCmd = cmd;
        player.ackedInputTick = cmd.tick;
        player.credits--;
      }
    }

    this.tick = (this.tick + 1) & 0xffff;

    if (this.tick % SNAPSHOT_INTERVAL === 0) this.broadcastSnapshots();
  }

  broadcastSnapshots() {
    const all = [];
    for (const p of this.players.values()) {
      if (p.joined) all.push(p);
    }

    for (const p of all) {
      const entities = [];
      for (const q of all) {
        if (q.id === p.id) continue;
        entities.push({
          id: q.id,
          pos: q.state.pos,
          yaw: q.lastCmd.yaw,
          onGround: q.state.onGround,
          team: q.team,
        });
      }
      try {
        p.conn.send(proto.encodeSnapshot({
          serverTick: this.tick,
          ackedInputTick: p.ackedInputTick,
          own: p.state,
          entities,
        }));
      } catch {
        // Socket died between the liveness check and here; the adapter's close
        // handler will clean it up.
      }
    }
  }
}

export { copyPlayerState, createPlayerState };
