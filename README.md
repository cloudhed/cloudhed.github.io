# cloudhed.github.io

cloudheds assortment of tools

- **[Gruppsortare](https://cloudhed.github.io/group-sorter.html)** — group sorting tool
- **[Arena CTF](https://cloudhed.github.io/game/)** — browser capture-the-flag arena shooter (in progress)

## Arena CTF

A Quake-style CTF arena shooter that runs in the browser, joined with a
four-character room key. Desktop only (mouse + keyboard).

Currently at **M0**: the netcode spine. No graphics yet by design — M0 exists to
prove client prediction, server reconciliation and entity interpolation are
correct, using a top-down debug view and a built-in lag simulator. Netcode
dictates the architecture, so it gets built before the renderer.

### Layout

| Path | What |
| --- | --- |
| `shared/` | Simulation code imported **verbatim** by both client and server |
| `game/` | Browser client (no build step — native ES modules) |
| `server/` | Cloudflare Worker + Durable Object, one per room code |
| `tests/` | Pure-function tests for `shared/` |

`shared/pmove.js` is the file client and server must agree on exactly. Nothing
in `shared/` may reference `window`, `document`, `THREE`, `Math.random`, `Date`
or `performance` — determinism there is what makes rollback and replay possible.

### Running it locally

No `npm install`, no build step:

```sh
node server/src/adapters/node.js     # serves the client AND the websocket
```

Then open <http://localhost:8787/game/>, create a room, and open a second tab
with the same code to play against yourself.

### Tests

```sh
node --test "tests/*.test.js"
```

### Deploying

The client deploys with `git push` (GitHub Pages). The server is separate:

```sh
cd server && npx wrangler deploy
```

Then set `SERVER_HOST` in `game/src/config.js` to the printed `workers.dev`
hostname. Bump `PROTOCOL_VERSION` in `shared/constants.js` whenever the wire
format changes, so stale clients are told to reload instead of failing oddly.
