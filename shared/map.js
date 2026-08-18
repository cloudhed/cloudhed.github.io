/**
 * Compiles a map definition into the runtime structures the simulation uses.
 *
 * The same brush list is the single source of truth for collision *and* (from
 * M1 onwards) for the render geometry, which is generated from it at load. That
 * makes it impossible for what you can see and what you can walk into to
 * disagree -- a bug class that eats weeks on hand-built levels.
 */

import { PLAYER_MAXS, PLAYER_MINS } from './constants.js';
import { boxBrush, createTrace, planeBrush, traceBox } from './trace.js';

/**
 * @typedef {object} MapDef
 * @property {string} name
 * @property {Array<{aabb?: number[], planes?: number[][], bounds?: number[], mat?: string}>} brushes
 * @property {Array<{type: string, origin: number[], [k: string]: any}>} entities
 */

/**
 * @param {MapDef} def
 */
export function compileMap(def) {
  const brushes = [];
  const materials = [];

  for (const b of def.brushes) {
    let brush;
    if (b.aabb) {
      brush = boxBrush(b.aabb.slice(0, 3), b.aabb.slice(3, 6));
    } else if (b.planes) {
      if (!b.bounds) {
        throw new Error(`brush with explicit planes needs "bounds" for broadphase`);
      }
      brush = planeBrush(b.planes, b.bounds.slice(0, 3), b.bounds.slice(3, 6));
    } else {
      throw new Error('brush must have either "aabb" or "planes"');
    }
    brushes.push(brush);
    materials.push(b.mat || 'default');
  }

  const spawns = { A: [], B: [] };
  for (const e of def.entities) {
    if (e.type === 'spawn') {
      const team = e.team === 'B' ? 'B' : 'A';
      spawns[team].push({
        origin: Float32Array.from(e.origin),
        // Stored as the quantized u16 the command format uses, so a spawn angle
        // and a player-supplied angle are the same kind of thing.
        yaw: Math.round((((e.angle || 0) * Math.PI) / 180 / (Math.PI * 2)) * 65536) & 0xffff,
      });
    }
  }

  if (spawns.A.length === 0 || spawns.B.length === 0) {
    throw new Error(`map "${def.name}" needs at least one spawn per team`);
  }

  // A spawn embedded in geometry leaves the player permanently stuck: every
  // trace reports allsolid, so velocity is zeroed every tick and the player
  // simply never moves, with no error anywhere. Remember the player box extends
  // 24 units BELOW its origin, so a spawn sitting "on" a floor at z=0 needs an
  // origin of at least z=24. Fail loudly at load instead.
  const probe = createTrace();
  const world = { brushes };
  for (const team of ['A', 'B']) {
    for (const spot of spawns[team]) {
      traceBox(probe, spot.origin, spot.origin, PLAYER_MINS, PLAYER_MAXS, world);
      if (probe.startsolid) {
        throw new Error(
          `map "${def.name}": team ${team} spawn at [${[...spot.origin]}] is inside ` +
          `geometry. The player box spans z${PLAYER_MINS[2]}..+${PLAYER_MAXS[2]} ` +
          `relative to the origin, so raise it.`,
        );
      }
    }
  }

  // World extent, used for sanity checks and for the debug view's framing.
  const mins = [Infinity, Infinity, Infinity];
  const maxs = [-Infinity, -Infinity, -Infinity];
  for (const brush of brushes) {
    for (let i = 0; i < 3; i++) {
      if (brush.mins[i] < mins[i]) mins[i] = brush.mins[i];
      if (brush.maxs[i] > maxs[i]) maxs[i] = brush.maxs[i];
    }
  }

  return {
    name: def.name,
    brushes,
    materials,
    spawns,
    entities: def.entities,
    mins,
    maxs,
    /** Kept for the debug renderer, which draws boxes rather than real geometry. */
    def,
  };
}
