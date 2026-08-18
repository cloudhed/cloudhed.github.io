/**
 * M0/M1 test arena.
 *
 * Deliberately dull: a walled box with a ramp, a staircase, and a few pillars.
 * Its job is to exercise every case the collision code has to get right --
 * flat ground, an angled surface, step-up geometry, and inside corners where
 * two planes meet -- not to be fun.
 *
 * Shipped as a JS module rather than a fetched .json so that the server can
 * import it directly with no network dependency and no way for a client to
 * influence the world the server simulates.
 */

const WALL_H = 320;
const R = 800; // arena half-extent

/** @type {import('../map.js').MapDef} */
export const testbox = {
  name: 'testbox',
  brushes: [
    // Floor and ceiling.
    { aabb: [-R, -R, -32, R, R, 0], mat: 'floor' },
    { aabb: [-R, -R, WALL_H, R, R, WALL_H + 32], mat: 'ceiling' },

    // Perimeter walls.
    { aabb: [-R - 32, -R, 0, -R, R, WALL_H], mat: 'wall' },
    { aabb: [R, -R, 0, R + 32, R, WALL_H], mat: 'wall' },
    { aabb: [-R - 32, -R - 32, 0, R + 32, -R, WALL_H], mat: 'wall' },
    { aabb: [-R - 32, R, 0, R + 32, R + 32, WALL_H], mat: 'wall' },

    // Centre pillar, and two offset ones to make inside corners.
    { aabb: [-64, -64, 0, 64, 64, WALL_H], mat: 'wall' },
    { aabb: [280, -360, 0, 400, -240, WALL_H], mat: 'wall' },
    { aabb: [-400, 240, 0, -280, 360, WALL_H], mat: 'wall' },

    // A low block you can jump onto but not step onto.
    { aabb: [-200, -520, 0, 200, -400, 56], mat: 'block' },

    // Ramp rising along +X from z=0 to z=64. The sloped top face is what makes
    // this worth having: an AABB-only collision system cannot represent it.
    {
      planes: [
        [-0.30472, 0, 0.95238, -60.944], // sloped top
        [0, 0, -1, 0], // bottom
        [1, 0, 0, 400], // +X
        [-1, 0, 0, -200], // -X
        [0, 1, 0, 100], // +Y
        [0, -1, 0, 100], // -Y
      ],
      bounds: [200, -100, 0, 400, 100, 64],
      mat: 'ramp',
    },

    // Staircase: four 16-unit risers, under STEP_HEIGHT so they are walkable.
    { aabb: [-400, -100, 0, -352, 100, 16], mat: 'step' },
    { aabb: [-352, -100, 0, -304, 100, 32], mat: 'step' },
    { aabb: [-304, -100, 0, -256, 100, 48], mat: 'step' },
    { aabb: [-256, -100, 0, -208, 100, 64], mat: 'step' },
  ],

  entities: [
    // Three spawns per side, as the CTF design calls for. Spawn *selection*
    // (M4) is what keeps these usable despite being campable by design.
    // Note the z: the player box extends 24 units BELOW its origin, so a spawn
    // at z=8 would start embedded in the floor and the player would be frozen
    // solid. compileMap validates this rather than letting it be mysterious.
    { type: 'spawn', team: 'A', origin: [-600, -200, 40], angle: 0 },
    { type: 'spawn', team: 'A', origin: [-600, 0, 40], angle: 0 },
    { type: 'spawn', team: 'A', origin: [-600, 200, 40], angle: 0 },
    { type: 'spawn', team: 'B', origin: [600, -200, 40], angle: 180 },
    { type: 'spawn', team: 'B', origin: [600, 0, 40], angle: 180 },
    { type: 'spawn', team: 'B', origin: [600, 200, 40], angle: 180 },
  ],
};

export default testbox;
