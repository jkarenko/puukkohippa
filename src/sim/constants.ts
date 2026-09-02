/**
 * Tunable game constants. Everything gameplay-related lives here so the
 * feel of the game can be adjusted without touching the simulation code.
 * Distances are pixels, times are seconds, speeds are pixels per second.
 */

export const ARENA_W = 1600;
export const ARENA_H = 900;

export const TICK_RATE = 60;
export const DT = 1 / TICK_RATE;
/** Server -> client snapshot rate. */
export const SNAPSHOT_EVERY_TICKS = 3; // 20 Hz

export const MAX_PLAYERS = 32;
export const MIN_PLAYERS_TO_START = 2;

export const PLAYER_RADIUS = 14;
export const BASE_SPEED = 240;
export const TURN_RATE = 3.8; // rad/s

/** The knife carrier moves at this fraction of the runners' base speed (before conversion bonuses). */
export const KNIFE_CARRIER_SPEED_FACTOR = 0.9;
/** Runners get this much faster (multiplicative bonus) per conversion in a round. */
export const RUNNER_SPEED_BONUS_PER_CONVERSION = 0.06;
export const RUNNER_SPEED_BONUS_CAP = 0.6;

/** Seconds of holding the throw button to reach full charge. */
export const CHARGE_TIME = 1.2;
export const THROW_SPEED_MIN = 380;
export const THROW_SPEED_MAX = 1150;
/** Flying knife deceleration (px/s^2). Range = v^2 / (2 * decel). */
export const KNIFE_DECEL = 560;
export const KNIFE_STOP_SPEED = 45;

export const KNIFE_LENGTH = 38;
export const KNIFE_WIDTH = 10;
/** Collision radius of the knife while flying. */
export const KNIFE_FLY_RADIUS = 5;
/** The thrower cannot catch their own knife before this many seconds of flight. */
export const KNIFE_RECATCH_DELAY = 0.25;

export const COUNTDOWN_TIME = 3;
export const ROUND_OVER_TIME = 5;

/** Role hat colours. */
export const COLOR_PUUKOTTAJA = 0xe53935;
export const COLOR_RUNNER = 0xfdd835;
