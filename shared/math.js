/**
 * Minimal vector math on plain 3-element arrays (or Float32Array).
 *
 * Every function writes into a caller-supplied output array. Nothing here
 * allocates, because this code runs 60 times a second on the server and is
 * replayed dozens of times per frame during reconciliation on the client.
 */

export const EPS = 1e-6;

export function vec3(x = 0, y = 0, z = 0) {
  return new Float32Array([x, y, z]);
}

export function set(out, x, y, z) {
  out[0] = x;
  out[1] = y;
  out[2] = z;
  return out;
}

export function copy(out, a) {
  out[0] = a[0];
  out[1] = a[1];
  out[2] = a[2];
  return out;
}

export function add(out, a, b) {
  out[0] = a[0] + b[0];
  out[1] = a[1] + b[1];
  out[2] = a[2] + b[2];
  return out;
}

export function sub(out, a, b) {
  out[0] = a[0] - b[0];
  out[1] = a[1] - b[1];
  out[2] = a[2] - b[2];
  return out;
}

/** out = a + b * s */
export function addScaled(out, a, b, s) {
  out[0] = a[0] + b[0] * s;
  out[1] = a[1] + b[1] * s;
  out[2] = a[2] + b[2] * s;
  return out;
}

export function scale(out, a, s) {
  out[0] = a[0] * s;
  out[1] = a[1] * s;
  out[2] = a[2] * s;
  return out;
}

export function dot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function cross(out, a, b) {
  const x = a[1] * b[2] - a[2] * b[1];
  const y = a[2] * b[0] - a[0] * b[2];
  const z = a[0] * b[1] - a[1] * b[0];
  out[0] = x;
  out[1] = y;
  out[2] = z;
  return out;
}

export function length(a) {
  return Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]);
}

export function lengthXY(a) {
  return Math.sqrt(a[0] * a[0] + a[1] * a[1]);
}

export function distance(a, b) {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  const dz = a[2] - b[2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/** Normalizes in place and returns the original length. */
export function normalize(out) {
  const len = length(out);
  if (len > EPS) {
    const inv = 1 / len;
    out[0] *= inv;
    out[1] *= inv;
    out[2] *= inv;
  }
  return len;
}

export function lerp(a, b, t) {
  return a + (b - a) * t;
}

export function lerpVec(out, a, b, t) {
  out[0] = a[0] + (b[0] - a[0]) * t;
  out[1] = a[1] + (b[1] - a[1]) * t;
  out[2] = a[2] + (b[2] - a[2]) * t;
  return out;
}

export function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Wraps an angle to (-PI, PI]. */
export function wrapAngle(a) {
  a = a % (Math.PI * 2);
  if (a > Math.PI) a -= Math.PI * 2;
  else if (a <= -Math.PI) a += Math.PI * 2;
  return a;
}

/** Shortest-arc interpolation between two angles. */
export function lerpAngle(a, b, t) {
  return a + wrapAngle(b - a) * t;
}

/**
 * Deterministic PRNG. Seeded explicitly and passed around rather than using
 * Math.random, so a replayed simulation produces the same result.
 */
export function xorshift32(seed) {
  let s = seed | 0 || 0x9e3779b9;
  return function next() {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    s |= 0;
    // Map to [0, 1).
    return (s >>> 0) / 4294967296;
  };
}
