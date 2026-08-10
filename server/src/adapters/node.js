/**
 * Local development server. Serves the static client AND the game websocket on
 * one port, so the whole thing runs with:
 *
 *     node server/src/adapters/node.js
 *
 * There is no npm install: the WebSocket framing below is about 120 lines of
 * RFC 6455, which is cheaper than owning a dependency in a repo that otherwise
 * has none. It drives the exact same Room class the Durable Object does, so if
 * it works here it works deployed.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH } from '../../../shared/constants.js';
import { Room } from '../room.js';

const PORT = Number(process.env.PORT || 8787);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// ---------------------------------------------------------------------------
// Minimal RFC 6455 server socket
// ---------------------------------------------------------------------------

const OP_CONT = 0x0;
const OP_TEXT = 0x1;
const OP_BIN = 0x2;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;

function frame(opcode, payload) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeUInt32BE(Math.floor(len / 2 ** 32), 2);
    header.writeUInt32BE(len >>> 0, 6);
  }
  header[0] = 0x80 | opcode; // FIN set; we never fragment outbound
  return Buffer.concat([header, payload]);
}

class ServerSocket {
  constructor(socket) {
    this.socket = socket;
    this.buf = Buffer.alloc(0);
    this.fragments = [];
    this.fragmentOp = 0;
    this.closed = false;
    this.onmessage = null;
    this.onclose = null;

    socket.on('data', (chunk) => this.onData(chunk));
    socket.on('close', () => this.fireClose());
    socket.on('error', () => this.fireClose());
  }

  fireClose() {
    if (this.closed) return;
    this.closed = true;
    this.onclose?.();
  }

  onData(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;

    for (;;) {
      if (this.buf.length < 2) return;

      const b0 = this.buf[0];
      const b1 = this.buf[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let offset = 2;

      if (len === 126) {
        if (this.buf.length < offset + 2) return;
        len = this.buf.readUInt16BE(offset);
        offset += 2;
      } else if (len === 127) {
        if (this.buf.length < offset + 8) return;
        const hi = this.buf.readUInt32BE(offset);
        const lo = this.buf.readUInt32BE(offset + 4);
        len = hi * 2 ** 32 + lo;
        offset += 8;
      }

      let mask = null;
      if (masked) {
        if (this.buf.length < offset + 4) return;
        mask = this.buf.subarray(offset, offset + 4);
        offset += 4;
      }

      if (this.buf.length < offset + len) return;

      const payload = Buffer.from(this.buf.subarray(offset, offset + len));
      if (mask) {
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      }
      this.buf = this.buf.subarray(offset + len);

      this.handleFrame(fin, opcode, payload);
      if (this.closed) return;
    }
  }

  handleFrame(fin, opcode, payload) {
    switch (opcode) {
      case OP_CLOSE:
        this.close();
        return;
      case OP_PING:
        this.socket.write(frame(OP_PONG, payload));
        return;
      case OP_PONG:
        return;
      case OP_CONT:
        this.fragments.push(payload);
        if (fin) {
          const full = Buffer.concat(this.fragments);
          this.fragments = [];
          this.deliver(this.fragmentOp, full);
        }
        return;
      case OP_TEXT:
      case OP_BIN:
        if (fin) {
          this.deliver(opcode, payload);
        } else {
          this.fragmentOp = opcode;
          this.fragments = [payload];
        }
        return;
      default:
        this.close();
    }
  }

  deliver(opcode, payload) {
    if (opcode !== OP_BIN) return; // the game protocol is binary only
    const ab = payload.buffer.slice(
      payload.byteOffset,
      payload.byteOffset + payload.byteLength,
    );
    this.onmessage?.(ab);
  }

  send(arrayBuffer) {
    if (this.closed) return;
    this.socket.write(frame(OP_BIN, Buffer.from(arrayBuffer)));
  }

  close() {
    if (this.closed) return;
    try {
      this.socket.write(frame(OP_CLOSE, Buffer.alloc(0)));
    } catch {
      // already gone
    }
    this.socket.destroy();
    this.fireClose();
  }
}

// ---------------------------------------------------------------------------
// Rooms
// ---------------------------------------------------------------------------

/** @type {Map<string, Room>} */
const rooms = new Map();

function normalizeCode(raw) {
  const code = (raw || '').toUpperCase();
  if (code.length !== ROOM_CODE_LENGTH) return null;
  for (const ch of code) if (!ROOM_CODE_ALPHABET.includes(ch)) return null;
  return code;
}

function getRoom(code) {
  let room = rooms.get(code);
  if (!room) {
    room = new Room(code, {
      onEmpty: () => {
        rooms.delete(code);
        console.log(`[room ${code}] empty, released`);
      },
    });
    rooms.set(code, room);
    console.log(`[room ${code}] created`);
  }
  return room;
}

// ---------------------------------------------------------------------------
// HTTP + upgrade
// ---------------------------------------------------------------------------

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/') pathname = '/game/index.html';
  if (pathname.endsWith('/')) pathname += 'index.html';

  const filePath = path.join(ROOT, pathname);
  // Refuse anything that escapes the repo root.
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403).end('forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
      return;
    }
    res.writeHead(200, {
      'content-type': MIME[path.extname(filePath)] || 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(data);
  });
});

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const match = /^\/r\/([^/]+)$/.exec(url.pathname);
  const code = match ? normalizeCode(match[1]) : null;
  const key = req.headers['sec-websocket-key'];

  if (!code || !key) {
    socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
    socket.destroy();
    return;
  }

  const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  socket.setNoDelay(true);
  if (head && head.length) socket.unshift(head);

  const ws = new ServerSocket(socket);
  const room = getRoom(code);
  const player = room.addConnection(ws);
  if (!player) return;

  console.log(`[room ${code}] player ${player.id} connected`);
  ws.onmessage = (buf) => room.onMessage(player.id, buf);
  ws.onclose = () => {
    console.log(`[room ${code}] player ${player.id} disconnected`);
    room.removeConnection(player.id);
  };
});

server.listen(PORT, () => {
  console.log(`\n  dev server  http://localhost:${PORT}/game/`);
  console.log(`  websocket   ws://localhost:${PORT}/r/<CODE>\n`);
});
