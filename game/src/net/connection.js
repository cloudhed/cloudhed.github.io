/**
 * Protocol layer: handshake, input transmission, snapshot dispatch, RTT.
 * Owns a Transport and knows nothing about rendering or simulation.
 */

import * as proto from '../../../shared/protocol.js';
import { Transport } from './transport.js';

const PING_INTERVAL_MS = 1000;

export class Connection {
  /**
   * @param {string} url
   * @param {{onWelcome?: Function, onSnapshot?: Function, onReject?: Function,
   *          onOpen?: Function, onClose?: Function}} handlers
   */
  constructor(url, handlers = {}) {
    this.handlers = handlers;
    this.transport = new Transport(url, {
      onOpen: () => this.onOpen(),
      onMessage: (buf) => this.onMessage(buf),
      onClose: (info) => this.handlers.onClose?.(info),
      onError: () => {},
    });

    this.name = 'player';
    this.joined = false;
    this.yourId = 0;
    this.team = 0;

    this.rttMs = 0;
    this.lastPingAt = 0;

    /** Bytes seen in the last second, for the debug overlay. */
    this.bytesIn = 0;
    this.bytesOut = 0;
    this.rateIn = 0;
    this.rateOut = 0;
    this.rateWindowStart = 0;
  }

  connect(name) {
    this.name = name;
    this.transport.connect();
  }

  onOpen() {
    this.send(proto.encodeHello(this.name));
    this.handlers.onOpen?.();
  }

  send(buf) {
    this.bytesOut += buf.byteLength;
    this.transport.send(buf);
  }

  onMessage(buf) {
    this.bytesIn += buf.byteLength;
    let type;
    try {
      type = proto.messageType(buf);
    } catch {
      return;
    }

    switch (type) {
      case proto.MSG_WELCOME: {
        const w = proto.decodeWelcome(buf);
        this.joined = true;
        this.yourId = w.yourId;
        this.team = w.team;
        this.handlers.onWelcome?.(w);
        break;
      }
      case proto.MSG_SNAPSHOT: {
        this.handlers.onSnapshot?.(proto.decodeSnapshot(buf));
        break;
      }
      case proto.MSG_REJECT: {
        this.handlers.onReject?.(proto.decodeReject(buf));
        break;
      }
      case proto.MSG_PONG: {
        const p = proto.decodePong(buf);
        // performance.now() is fractional; the wire value is a truncated u32.
        const sent = p.clientTimeMs;
        const now = Math.floor(performance.now()) >>> 0;
        this.rttMs = (now - sent) >>> 0;
        break;
      }
      default:
        break;
    }
  }

  sendInput(lastAckedSnapshotTick, firstCommandTick, commands) {
    if (!this.joined || commands.length === 0) return;
    this.send(proto.encodeInput(lastAckedSnapshotTick, firstCommandTick, commands));
  }

  /** Call every frame: releases delayed packets and maintains RTT/bandwidth. */
  pump() {
    this.transport.pump();

    const now = performance.now();
    if (this.joined && now - this.lastPingAt > PING_INTERVAL_MS) {
      this.lastPingAt = now;
      this.send(proto.encodePing(Math.floor(now) >>> 0));
    }

    if (now - this.rateWindowStart >= 1000) {
      const elapsed = (now - this.rateWindowStart) / 1000;
      this.rateIn = this.bytesIn / elapsed;
      this.rateOut = this.bytesOut / elapsed;
      this.bytesIn = 0;
      this.bytesOut = 0;
      this.rateWindowStart = now;
    }
  }

  setConditions(opts) {
    this.transport.setConditions(opts);
  }

  close() {
    this.transport.close();
  }
}
