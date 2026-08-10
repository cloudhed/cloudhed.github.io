/**
 * Swept AABB-vs-convex-brush tracing.
 *
 * A brush is a set of planes whose normals point outwards; a point is inside
 * the brush when it is behind every plane. Sweeping a *box* rather than a point
 * is handled by Minkowski-expanding each plane by the box half-extents, which
 * is exact for an axis-aligned box and costs one line:
 *
 *     dist += |nx|*hx + |ny|*hy + |nz|*hz
 *
 * After that the box is a point, so the whole thing reduces to the classic
 * enter/exit fraction loop. An axis-aligned box is just a 6-plane brush, so
 * nothing is lost by supporting arbitrary convex brushes -- and it buys ramps
 * and angled walls, which are most of what makes an arena feel like Quake.
 */

import { dot, EPS } from './math.js';

/** Q3's SURFACE_CLIP_EPSILON: keeps the box a hair off the surface. */
const CLIP_EPSILON = 0.125;

/**
 * @typedef {{ planes: Float64Array, count: number,
 *             mins: Float64Array, maxs: Float64Array }} Brush
 */

/**
 * Builds a 6-plane brush from an axis-aligned box.
 * Plane layout is [nx, ny, nz, dist] with the normal pointing out of the brush.
 */
export function boxBrush(mins, maxs) {
  const planes = new Float64Array(6 * 4);
  const write = (i, nx, ny, nz, d) => {
    planes[i * 4 + 0] = nx;
    planes[i * 4 + 1] = ny;
    planes[i * 4 + 2] = nz;
    planes[i * 4 + 3] = d;
  };
  write(0, 1, 0, 0, maxs[0]);
  write(1, -1, 0, 0, -mins[0]);
  write(2, 0, 1, 0, maxs[1]);
  write(3, 0, -1, 0, -mins[1]);
  write(4, 0, 0, 1, maxs[2]);
  write(5, 0, 0, -1, -mins[2]);
  return {
    planes,
    count: 6,
    mins: Float64Array.from(mins),
    maxs: Float64Array.from(maxs),
  };
}

/**
 * Builds a brush from an explicit plane list, deriving its bounding box by
 * clipping against the supplied world extent. The bounds are only used for
 * broadphase rejection, so a conservative over-estimate is fine.
 */
export function planeBrush(planes, mins, maxs) {
  const arr = new Float64Array(planes.length * 4);
  for (let i = 0; i < planes.length; i++) {
    arr[i * 4 + 0] = planes[i][0];
    arr[i * 4 + 1] = planes[i][1];
    arr[i * 4 + 2] = planes[i][2];
    arr[i * 4 + 3] = planes[i][3];
  }
  return {
    planes: arr,
    count: planes.length,
    mins: Float64Array.from(mins),
    maxs: Float64Array.from(maxs),
  };
}

export function createTrace() {
  return {
    fraction: 1,
    normal: new Float32Array(3),
    endpos: new Float32Array(3),
    startsolid: false,
    allsolid: false,
    hit: false,
  };
}

/**
 * Traces one brush, narrowing `tr` if this brush is hit earlier than whatever
 * is already recorded. `p1`/`p2` are the *offset* (box-centre) endpoints and
 * `half` the box half-extents.
 */
function traceBrush(tr, brush, p1, p2, half) {
  const planes = brush.planes;
  let enterFrac = -1;
  let leaveFrac = 1;
  let clipIndex = -1;
  let startsOutside = false;
  let endsOutside = false;

  for (let i = 0; i < brush.count; i++) {
    const o = i * 4;
    const nx = planes[o], ny = planes[o + 1], nz = planes[o + 2];
    // Minkowski expansion: push the plane out by the box's extent along it.
    const dist =
      planes[o + 3] +
      Math.abs(nx) * half[0] + Math.abs(ny) * half[1] + Math.abs(nz) * half[2];

    const d1 = p1[0] * nx + p1[1] * ny + p1[2] * nz - dist;
    const d2 = p2[0] * nx + p2[1] * ny + p2[2] * nz - dist;

    if (d2 > 0) endsOutside = true;
    if (d1 > 0) startsOutside = true;

    // Entirely in front of this plane for the whole sweep: cannot hit.
    if (d1 > 0 && (d2 >= CLIP_EPSILON || d2 >= d1)) return;
    // Entirely behind: this plane does not bound the sweep.
    if (d1 <= 0 && d2 <= 0) continue;

    if (d1 > d2) {
      // Crossing inwards.
      let f = (d1 - CLIP_EPSILON) / (d1 - d2);
      if (f < 0) f = 0;
      if (f > enterFrac) {
        enterFrac = f;
        clipIndex = i;
      }
    } else {
      // Crossing outwards.
      let f = (d1 + CLIP_EPSILON) / (d1 - d2);
      if (f > 1) f = 1;
      if (f < leaveFrac) leaveFrac = f;
    }
  }

  if (!startsOutside) {
    // Started inside the brush.
    tr.startsolid = true;
    if (!endsOutside) tr.allsolid = true;
    tr.fraction = 0;
    tr.hit = true;
    return;
  }

  if (enterFrac < leaveFrac && enterFrac > -1 && enterFrac < tr.fraction) {
    tr.fraction = enterFrac < 0 ? 0 : enterFrac;
    const o = clipIndex * 4;
    tr.normal[0] = planes[o];
    tr.normal[1] = planes[o + 1];
    tr.normal[2] = planes[o + 2];
    tr.hit = true;
  }
}

// Scratch, module-level so the hot path never allocates.
const _p1 = new Float64Array(3);
const _p2 = new Float64Array(3);
const _half = new Float64Array(3);
const _offset = new Float64Array(3);
const _sweepMins = new Float64Array(3);
const _sweepMaxs = new Float64Array(3);

/**
 * Sweeps the box [mins,maxs] (relative to the entity origin) from `start` to
 * `end` through the world, writing the result into `tr`.
 *
 * `tr.fraction` is the portion of the move completed, `tr.endpos` the resulting
 * origin, and `tr.normal` the surface normal of the first thing hit.
 */
export function traceBox(tr, start, end, mins, maxs, world) {
  tr.fraction = 1;
  tr.startsolid = false;
  tr.allsolid = false;
  tr.hit = false;
  tr.normal[0] = tr.normal[1] = tr.normal[2] = 0;

  // Asymmetric boxes are handled by tracing the box *centre* and expanding the
  // planes by the half-extents.
  for (let i = 0; i < 3; i++) {
    _half[i] = (maxs[i] - mins[i]) * 0.5;
    _offset[i] = (maxs[i] + mins[i]) * 0.5;
    _p1[i] = start[i] + _offset[i];
    _p2[i] = end[i] + _offset[i];
    _sweepMins[i] = Math.min(_p1[i], _p2[i]) - _half[i] - 1;
    _sweepMaxs[i] = Math.max(_p1[i], _p2[i]) + _half[i] + 1;
  }

  const brushes = world.brushes;
  for (let b = 0; b < brushes.length; b++) {
    const brush = brushes[b];
    // Broadphase rejection against the swept bounds.
    if (
      brush.mins[0] > _sweepMaxs[0] || brush.maxs[0] < _sweepMins[0] ||
      brush.mins[1] > _sweepMaxs[1] || brush.maxs[1] < _sweepMins[1] ||
      brush.mins[2] > _sweepMaxs[2] || brush.maxs[2] < _sweepMins[2]
    ) {
      continue;
    }
    traceBrush(tr, brush, _p1, _p2, _half);
    if (tr.allsolid) break;
  }

  const f = tr.fraction;
  tr.endpos[0] = start[0] + (end[0] - start[0]) * f;
  tr.endpos[1] = start[1] + (end[1] - start[1]) * f;
  tr.endpos[2] = start[2] + (end[2] - start[2]) * f;
  return tr;
}

/**
 * Reflects `vin` off a plane, scaled slightly past it (`overbounce`) so the
 * next trace never starts inside the surface.
 */
export function clipVelocity(out, vin, normal, overbounce) {
  let backoff = dot(vin, normal);
  if (backoff < 0) backoff *= overbounce;
  else backoff /= overbounce;
  out[0] = vin[0] - normal[0] * backoff;
  out[1] = vin[1] - normal[1] * backoff;
  out[2] = vin[2] - normal[2] * backoff;
  // Squash denormal-ish residue so resting contacts settle exactly.
  for (let i = 0; i < 3; i++) if (Math.abs(out[i]) < EPS) out[i] = 0;
  return out;
}
