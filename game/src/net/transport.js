/**
 * Raw socket wrapper, with the lag simulator spliced into both directions.
 *
 * Everything above this file talks to the `Transport` interface and nothing
 * else, so switching WebSocket for WebTransport later (HTTP/3 datagrams, real
 * unreliable delivery) means replacing this one file.
 */

import { LagSim } from './lagsim.js';

export class Transport {
  /**
   * @param {string} url
   * @param {{onOpen?: Function, onMessage?: (b: ArrayBuffer) => void,
   *          onClose?: (info: {code: number, reason: string}) => void,
   *          onError?: Function}} handlers
   */
  constructor(url, handlers = {}) {
    this.url = url;
    this.handlers = handlers;
    this.socket = null;
    this.open = false;

    // Separate simulators per direction, so a configured latency of 75ms means
    // a round trip of 150ms.
    this.inbound = new LagSim((buf) => this.handlers.onMessage?.(buf), 0xa1b2c3);
    this.outbound = new LagSim((buf) => this.rawSend(buf), 0xc3b2a1);
  }

  connect() {
    const socket = new WebSocket(this.url);
    socket.binaryType = 'arraybuffer';
    this.socket = socket;

    socket.onopen = () => {
      this.open = true;
      this.handlers.onOpen?.();
    };
    socket.onmessage = (event) => {
      if (event.data instanceof ArrayBuffer) this.inbound.push(event.data);
    };
    socket.onclose = (event) => {
      this.open = false;
      this.handlers.onClose?.({ code: event.code, reason: event.reason });
    };
    socket.onerror = () => {
      this.handlers.onError?.();
    };
  }

  /** Applies simulated upstream conditions, then sends. */
  send(buf) {
    this.outbound.push(buf);
  }

  rawSend(buf) {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(buf);
    }
  }

  /** Must be called every frame to release delayed packets. */
  pump() {
    this.inbound.pump();
    this.outbound.pump();
  }

  setConditions({ latencyMs, jitterMs, lossPct, mode }) {
    for (const sim of [this.inbound, this.outbound]) {
      if (latencyMs !== undefined) sim.latencyMs = latencyMs;
      if (jitterMs !== undefined) sim.jitterMs = jitterMs;
      if (lossPct !== undefined) sim.lossPct = lossPct;
      if (mode !== undefined) sim.mode = mode;
    }
  }

  close() {
    this.inbound.reset();
    this.outbound.reset();
    this.socket?.close();
  }
}
