/**
 * Cloudflare Worker entry point. Routes `/r/<CODE>` websocket upgrades to the
 * Durable Object named by that code and does nothing else.
 */

import { ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH } from '../../shared/constants.js';

export { GameRoom } from './adapters/cf.js';

function normalizeCode(raw) {
  const code = (raw || '').toUpperCase();
  if (code.length !== ROOM_CODE_LENGTH) return null;
  for (const ch of code) if (!ROOM_CODE_ALPHABET.includes(ch)) return null;
  return code;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return new Response('ok', { headers: { 'content-type': 'text/plain' } });
    }

    const match = /^\/r\/([^/]+)$/.exec(url.pathname);
    if (!match) return new Response('not found', { status: 404 });

    const code = normalizeCode(match[1]);
    if (!code) return new Response('bad room code', { status: 400 });

    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('expected websocket', { status: 426 });
    }

    const id = env.ROOMS.idFromName(code);
    return env.ROOMS.get(id).fetch(request);
  },
};
