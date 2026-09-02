export type Role = 'runner' | 'puukottaja';

export interface PlayerInput {
  fwd: boolean;
  back: boolean;
  left: boolean;
  right: boolean;
  throw: boolean;
}

export const EMPTY_INPUT: Readonly<PlayerInput> = Object.freeze({
  fwd: false,
  back: false,
  left: false,
  right: false,
  throw: false,
});

export function copyInput(i: PlayerInput): PlayerInput {
  return { fwd: i.fwd, back: i.back, left: i.left, right: i.right, throw: i.throw };
}

export function inputsEqual(a: PlayerInput, b: PlayerInput): boolean {
  return (
    a.fwd === b.fwd && a.back === b.back && a.left === b.left && a.right === b.right && a.throw === b.throw
  );
}

export interface Vec {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Arena {
  seed: number;
  width: number;
  height: number;
  /** Solid rectangles, including the outer border walls. */
  obstacles: Rect[];
  /** Guaranteed-free, well-spread spawn points. */
  spawns: Vec[];
}

export interface PlayerState {
  id: number;
  name: string;
  /** Body colour as 0xRRGGBB. */
  color: number;
  x: number;
  y: number;
  /** Heading in radians, 0 = +x, increasing clockwise on screen. */
  heading: number;
  role: Role;
  /** Throw charge 0..1 while charging, -1 when not charging. */
  charge: number;
  /** Tick at which this player was last converted, -1 if never this round. */
  caughtTick: number;
  /** Conversions made this round (touch or knife). */
  catches: number;
  /** Rounds survived as the last runner. */
  wins: number;
  /** Previous tick's input, used for edge detection. */
  prevInput: PlayerInput;
}

export type KnifeState =
  | { mode: 'held'; holder: number }
  | {
      mode: 'flying';
      x: number;
      y: number;
      heading: number;
      vx: number;
      vy: number;
      thrower: number;
      /** Intended pass target, -1 for a straight throw. */
      target: number;
      airTime: number;
    }
  | { mode: 'ground'; x: number; y: number; heading: number };

export type Phase = 'lobby' | 'countdown' | 'playing' | 'roundover';

export type GameEvent =
  | { type: 'convert'; who: number; by: number; viaKnife: boolean }
  | { type: 'throw'; by: number; target: number; charge: number }
  | { type: 'pickup'; by: number }
  | { type: 'knifeLanded' }
  | { type: 'roundStart'; round: number }
  | { type: 'roundOver'; winner: number };

export interface GameState {
  tick: number;
  phase: Phase;
  /** Tick at which the current phase ends (countdown / roundover). */
  phaseEndsTick: number;
  round: number;
  /** Arena seed for the current round. */
  seed: number;
  players: PlayerState[];
  knife: KnifeState;
  /** Conversions this round; drives the runner speed bonus. */
  conversions: number;
  /** Last player who was converted, -1 if none. They start the next round as puukottaja. */
  lastCaught: number;
  roundStartTick: number;
  /** Events produced by the most recent step(s). Cleared by the room when flushed. */
  events: GameEvent[];
  nextPlayerId: number;
}

export type Dir = 'fwd' | 'back' | 'left' | 'right';
