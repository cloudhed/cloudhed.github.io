/**
 * M0 entry point: fixed-step loop, room join, and the wiring between input,
 * prediction, interpolation and the debug renderer.
 *
 * The loop is a fixed-timestep accumulator, never a requestAnimationFrame
 * delta. Using the frame delta as the physics timestep makes the simulation
 * differ between a 60Hz and a 144Hz machine, which means the client and server
 * disagree permanently and reconciliation fights itself forever.
 */

import {
  DT, INPUT_REDUNDANCY, INPUT_SEND_RATE, MAX_CATCHUP_STEPS,
  ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH,
} from '../../shared/constants.js';
import { compileMap } from '../../shared/map.js';
import testbox from '../../shared/maps/testbox.js';
import { quantizeCommand } from '../../shared/protocol.js';
import { serverUrl } from './config.js';
import { Input } from './input/input.js';
import { Connection } from './net/connection.js';
import { Interpolator } from './net/interp.js';
import { Predictor } from './net/predict.js';
import { TopDownRenderer } from './render/topdown.js';

const world = compileMap(testbox);
const params = new URLSearchParams(location.search);

const canvas = /** @type {HTMLCanvasElement} */ (document.getElementById('view'));
const input = new Input(canvas);
const renderer = new TopDownRenderer(canvas, world);
const predictor = new Predictor(world);
const interpolator = new Interpolator();

/** @type {Connection | null} */
let connection = null;
let joined = false;
let localTeam = 0;
let lastAckedSnapshotTick = 0;
let serverConfirmedPos = null;

/** Commands generated but possibly not yet acknowledged, for redundant resend. */
const recentCommands = [];
let commandsSinceSend = 0;
let lastInputSendMs = 0;

// ---------------------------------------------------------------------------
// Room codes
// ---------------------------------------------------------------------------

function randomRoomCode() {
  const bytes = new Uint8Array(ROOM_CODE_LENGTH);
  crypto.getRandomValues(bytes);
  let out = '';
  for (const b of bytes) out += ROOM_CODE_ALPHABET[b % ROOM_CODE_ALPHABET.length];
  return out;
}

function normalizeRoomCode(raw) {
  const code = (raw || '').toUpperCase().replace(/\s/g, '');
  if (code.length !== ROOM_CODE_LENGTH) return null;
  for (const ch of code) if (!ROOM_CODE_ALPHABET.includes(ch)) return null;
  return code;
}

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

function join(code, name) {
  connection?.close();
  joined = false;
  interpolator.reset();
  setStatus(`connecting to ${code}...`);

  connection = new Connection(serverUrl(code), {
    onOpen: () => setStatus(`joining ${code}...`),
    onWelcome: (w) => {
      // Start the local simulation from exactly the state the server will start
      // from, at tick zero, so the two run the same command sequence.
      predictor.reset(w.spawnPos);
      recentCommands.length = 0;
      commandsSinceSend = 0;
      input.yaw = (w.spawnYaw / 65536) * Math.PI * 2;
      input.pitch = 0;

      joined = true;
      localTeam = w.team;
      setStatus('');
      document.body.classList.add('playing');
      document.getElementById('roomBadge').textContent = code;
      const url = new URL(location.href);
      url.searchParams.set('r', code);
      history.replaceState(null, '', url);
    },
    onSnapshot: (snap) => {
      predictor.reconcile(snap.ackedInputTick, snap.own);
      interpolator.addSnapshot(snap.serverTick, snap.entities);
      lastAckedSnapshotTick = snap.serverTick;
      serverConfirmedPos = snap.own.pos;
    },
    onReject: (r) => {
      setStatus(r.message);
      document.body.classList.remove('playing');
    },
    onClose: () => {
      if (joined) setStatus('disconnected. reload to rejoin.');
      joined = false;
      document.body.classList.remove('playing');
    },
  });

  applyLagSettings();
  connection.connect(name);
}

// ---------------------------------------------------------------------------
// Fixed-step loop
// ---------------------------------------------------------------------------

let accumulator = 0;
let lastFrameMs = performance.now();
let frameTimeEma = 16.7;

function frame() {
  requestAnimationFrame(frame);

  const now = performance.now();
  let dt = (now - lastFrameMs) / 1000;
  lastFrameMs = now;
  // A backgrounded tab produces an enormous delta; do not try to catch up on it.
  if (dt > 0.25) dt = 0.25;
  frameTimeEma += (dt * 1000 - frameTimeEma) * 0.1;

  connection?.pump();

  accumulator += dt;
  let steps = 0;
  while (accumulator >= DT && steps < MAX_CATCHUP_STEPS) {
    simulateOneTick();
    accumulator -= DT;
    steps++;
  }
  if (steps >= MAX_CATCHUP_STEPS) accumulator = 0;

  maybeSendInput(now);
  predictor.decayError(dt);
  render();
  updateHud();
}

function simulateOneTick() {
  const raw = input.sample();
  // Quantize BEFORE predicting, so the client simulates exactly the numbers the
  // server will receive. Predicting with raw floats and sending rounded ones
  // causes permanent low-grade mispredicts.
  const cmd = quantizeCommand(raw.forward, raw.right, raw.yaw, raw.pitch, raw.buttons);

  const tick = predictor.tick;
  predictor.step(cmd);

  recentCommands.push({ ...cmd, tick });
  if (recentCommands.length > 24) recentCommands.shift();
  commandsSinceSend++;
}

function maybeSendInput(nowMs) {
  if (!joined || !connection) return;
  if (nowMs - lastInputSendMs < 1000 / INPUT_SEND_RATE) return;
  lastInputSendMs = nowMs;
  if (commandsSinceSend === 0) return;

  // Re-send a couple of already-transmitted commands alongside the new ones.
  // They are contiguous by construction, cost 8 bytes each, and make upstream
  // packet loss invisible to the server.
  const count = Math.min(recentCommands.length, commandsSinceSend + INPUT_REDUNDANCY);
  const batch = recentCommands.slice(recentCommands.length - count);
  connection.sendInput(lastAckedSnapshotTick, batch[0].tick & 0xffff, batch);
  commandsSinceSend = 0;
}

function render() {
  const raw = input.sample();
  renderer.draw({
    localPos: predictor.getRenderPos(),
    localRawPos: predictor.state.pos,
    serverPos: serverConfirmedPos,
    localYaw: raw.yaw,
    localTeam,
    remotes: joined ? interpolator.sample() : [],
  });
}

// ---------------------------------------------------------------------------
// HUD and controls
// ---------------------------------------------------------------------------

const hud = document.getElementById('hud');
const statusEl = document.getElementById('status');

function setStatus(text) {
  statusEl.textContent = text;
  statusEl.style.display = text ? 'block' : 'none';
}

function updateHud() {
  const speed = Math.hypot(predictor.state.vel[0], predictor.state.vel[1]);
  const err = Math.hypot(predictor.error[0], predictor.error[1], predictor.error[2]);
  const rows = [
    ['fps', (1000 / frameTimeEma).toFixed(0)],
    ['speed', `${speed.toFixed(0)} u/s`],
    ['ground', predictor.state.onGround ? 'yes' : 'no'],
    ['tick', predictor.tick],
    ['rtt', connection ? `${connection.rttMs} ms` : '-'],
    ['resims', predictor.resimulations],
    ['last resim', `${predictor.lastResimSteps} steps`],
    ['smoothing', `${err.toFixed(3)} u`],
    ['hard snaps', predictor.snapped],
    ['interp delay', `${interpolator.interpDelayMs.toFixed(0)} ms`],
    ['jitter', `${interpolator.jitterEmaMs.toFixed(1)} ms`],
    ['players', 1 + interpolator.entities.size],
    ['down', connection ? `${(connection.rateIn / 1024).toFixed(1)} KB/s` : '-'],
    ['up', connection ? `${(connection.rateOut / 1024).toFixed(1)} KB/s` : '-'],
  ];
  hud.innerHTML = rows
    .map(([k, v]) => `<div><span>${k}</span><b>${v}</b></div>`)
    .join('');
}

function applyLagSettings() {
  if (!connection) return;
  connection.setConditions({
    latencyMs: Number(document.getElementById('lag').value) / 2,
    jitterMs: Number(document.getElementById('jitter').value),
    lossPct: Number(document.getElementById('loss').value),
    mode: document.getElementById('mode').value,
  });
}

function bindControls() {
  for (const id of ['lag', 'jitter', 'loss']) {
    const el = document.getElementById(id);
    const out = document.getElementById(`${id}Out`);
    const update = () => {
      out.textContent = el.value;
      applyLagSettings();
    };
    el.addEventListener('input', update);
    update();
  }
  document.getElementById('mode').addEventListener('change', applyLagSettings);

  document.getElementById('markers').addEventListener('change', (e) => {
    renderer.showDebugMarkers = e.target.checked;
  });

  const codeInput = /** @type {HTMLInputElement} */ (document.getElementById('code'));
  const nameInput = /** @type {HTMLInputElement} */ (document.getElementById('name'));

  document.getElementById('joinBtn').addEventListener('click', () => {
    const code = normalizeRoomCode(codeInput.value);
    if (!code) {
      setStatus(`room codes are ${ROOM_CODE_LENGTH} characters from ${ROOM_CODE_ALPHABET}`);
      return;
    }
    join(code, nameInput.value || 'player');
  });

  document.getElementById('createBtn').addEventListener('click', () => {
    const code = randomRoomCode();
    codeInput.value = code;
    join(code, nameInput.value || 'player');
  });

  codeInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') document.getElementById('joinBtn').click();
  });
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

function boot() {
  input.attach();
  bindControls();

  // ?lag=150&jitter=30&loss=5 preconfigures the simulator; ?r=CODE auto-joins.
  for (const [param, id] of [['lag', 'lag'], ['jitter', 'jitter'], ['loss', 'loss']]) {
    const v = params.get(param);
    if (v !== null) {
      document.getElementById(id).value = v;
      document.getElementById(`${id}Out`).textContent = v;
    }
  }

  const auto = normalizeRoomCode(params.get('r'));
  if (auto) {
    document.getElementById('code').value = auto;
    join(auto, params.get('name') || 'player');
  } else {
    setStatus('create a room, or enter a 4-character code to join one');
  }

  requestAnimationFrame(frame);
}

boot();
