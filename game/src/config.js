/**
 * Deployment configuration.
 *
 * The client (GitHub Pages) and the server (Cloudflare Workers) deploy
 * independently, so the client needs to be told where the server lives.
 */

/**
 * Hostname of the deployed worker. Set this after the first
 * `npx wrangler deploy` -- it prints the workers.dev subdomain.
 */
export const SERVER_HOST = 'arena-server.example.workers.dev';

/**
 * Resolves the websocket URL for a room code.
 *
 * Order of precedence:
 *   1. ?server=host:port  (explicit override, used for testing)
 *   2. the page's own host, when running against the local dev server
 *   3. SERVER_HOST
 */
export function serverUrl(code) {
  const override = new URLSearchParams(location.search).get('server');
  if (override) {
    const insecure = /^(localhost|127\.|\[::1\])/.test(override);
    return `${insecure ? 'ws' : 'wss'}://${override}/r/${code}`;
  }

  const host = location.hostname;
  if (host === 'localhost' || host === '127.0.0.1' || host === '[::1]') {
    // The Node dev adapter serves the client and the socket on one port.
    return `ws://${location.host}/r/${code}`;
  }

  return `wss://${SERVER_HOST}/r/${code}`;
}
