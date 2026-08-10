/**
 * Cloudflare Durable Object adapter.
 *
 * One Durable Object per room, named by the four-character room code, so
 * `idFromName("K7QM")` *is* the matchmaking system -- no room registry, no
 * database, no lobby service, no cleanup job.
 *
 * Note `server.accept()` rather than `state.acceptWebSocket()`: the Hibernation
 * API exists so a chat room can drop out of memory between messages, but a game
 * server ticks 60 times a second and never idles. Hibernation would also mean
 * in-memory state cannot be relied on between events, which is precisely what
 * this object is made of. Idle rooms cost nothing because they stop ticking and
 * the object is evicted once the last player leaves.
 */

import { Room } from '../room.js';

export class GameRoom {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    /** @type {Room | null} */
    this.room = null;
  }

  async fetch(request) {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('expected websocket', { status: 426 });
    }

    const url = new URL(request.url);
    const code = (url.pathname.split('/').pop() || '').toUpperCase();

    if (!this.room) {
      this.room = new Room(code, {
        onEmpty: () => {
          // Nothing to do: with no sockets and no tick loop the object has no
          // pending work, so the runtime evicts it on its own.
        },
      });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();

    const conn = {
      send(buf) {
        try {
          server.send(buf);
        } catch {
          // Socket closed underneath us; the close handler cleans up.
        }
      },
      close() {
        try {
          server.close();
        } catch {
          // already closing
        }
      },
    };

    const player = this.room.addConnection(conn);
    if (player) {
      server.addEventListener('message', (event) => {
        if (event.data instanceof ArrayBuffer) {
          this.room.onMessage(player.id, event.data);
        }
      });
      const cleanup = () => this.room?.removeConnection(player.id);
      server.addEventListener('close', cleanup);
      server.addEventListener('error', cleanup);
    }

    return new Response(null, { status: 101, webSocket: client });
  }
}
