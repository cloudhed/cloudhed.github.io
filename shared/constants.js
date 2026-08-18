/**
 * Shared tuning constants. Imported verbatim by client and server.
 *
 * Units are Quake units (1 unit ~= 1 inch). A player runs at 320 u/s, a large
 * arena is 2000-3000 units across. Keeping Quake units means the movement
 * constants below can be copied from Q3 without retuning.
 */

/** Bumped whenever the wire format changes. Mismatched clients are rejected. */
export const PROTOCOL_VERSION = 1;

// ---------------------------------------------------------------------------
// Timing
// ---------------------------------------------------------------------------

/** Simulation steps per second. Fixed, identical on client and server. */
export const TICK_RATE = 60;
export const DT = 1 / TICK_RATE;

/** Send a snapshot every Nth tick. 2 => 30 Hz. */
export const SNAPSHOT_INTERVAL = 2;

/** Client transmits accumulated commands this many times per second. */
export const INPUT_SEND_RATE = 30;

/**
 * Commands re-sent from the unacked backlog on top of the new ones.
 *
 * With 2 new commands per packet at 30Hz, a value of 4 puts every command in
 * three consecutive packets, so three in a row must be lost before the server
 * sees a gap. That costs 32 bytes per packet -- about 1KB/s -- and is the
 * cheapest reliability in the whole protocol.
 */
export const INPUT_REDUNDANCY = 4;

/** Never simulate more than this many catch-up steps in one go. */
export const MAX_CATCHUP_STEPS = 5;

// ---------------------------------------------------------------------------
// Movement (Quake 3 VQ3 values)
// ---------------------------------------------------------------------------

export const GRAVITY = 800;
export const MAX_SPEED = 320;
/** Scale applied to the normalized wish direction. */
export const CMD_SCALE = 400;
export const FRICTION = 6;
export const STOP_SPEED = 100;
export const ACCELERATE = 10;
export const AIR_ACCELERATE = 1;

/**
 * Quake 1 / CPM clamp the air wishspeed to 30 before accelerating, which makes
 * strafe-jumping require a sharper angle. VQ3 does not clamp at all and is more
 * forgiving, which is what we want for beginners. Set to 30 for Q1-style air
 * control.
 */
export const AIR_WISH_CAP = Infinity;

export const JUMP_VELOCITY = 270;
export const STEP_HEIGHT = 18;

/** Surfaces at least this upright count as ground (cos ~45 degrees). */
export const MIN_WALK_NORMAL = 0.7;

/** Velocity is scaled slightly past the plane so we never re-enter it. */
export const OVERCLIP = 1.001;

/** Player bounding box, relative to the entity origin (at the feet). */
export const PLAYER_MINS = [-15, -15, -24];
export const PLAYER_MAXS = [15, 15, 32];
export const EYE_HEIGHT = 26;

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

export const BTN_JUMP = 1 << 0;
export const BTN_FIRE = 1 << 1;
export const BTN_ALTFIRE = 1 << 2;
export const BTN_USE = 1 << 3;
export const BTN_CROUCH = 1 << 4;

// ---------------------------------------------------------------------------
// Wire quantization
// ---------------------------------------------------------------------------

/**
 * Replicated (remote) positions are i16 at 1/POS_SCALE unit precision.
 * 16 => +/-2048 units of world, 0.0625 unit resolution. Invisible at this scale.
 * The owning client's own position is sent at full float32 precision instead,
 * because reconciliation compares against it directly.
 */
export const POS_SCALE = 16;
export const POS_LIMIT = 32767 / POS_SCALE;

export const MAX_PLAYERS = 16;

// ---------------------------------------------------------------------------
// Prediction
// ---------------------------------------------------------------------------

/** Commands retained for replay. 2 seconds at 60 Hz. */
export const INPUT_BUFFER_SIZE = 128;

/** Position mismatch (units) above which the client resimulates. */
export const RECONCILE_POS_TOLERANCE = 0.01;
/** Velocity mismatch (units/s) above which the client resimulates. */
export const RECONCILE_VEL_TOLERANCE = 0.5;

/** Prediction error decays to ~0.1% over this many seconds. */
export const ERROR_SMOOTH_TIME = 0.1;

/** Remote entities render at least this far in the past. */
export const MIN_INTERP_DELAY_MS = 100;

// ---------------------------------------------------------------------------
// Room codes
// ---------------------------------------------------------------------------

/**
 * Crockford-ish alphabet with I, O, U, 0 and 1 removed: unambiguous when read
 * aloud across a room, and no accidental words. 31^4 = 923,521 codes.
 */
export const ROOM_CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTVWXYZ';
export const ROOM_CODE_LENGTH = 4;
