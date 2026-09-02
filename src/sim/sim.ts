import { getArena } from './arena.js';
import {
  BASE_SPEED,
  CHARGE_DECEL,
  CHARGE_TIME,
  COUNTDOWN_TIME,
  DT,
  KNIFE_CARRIER_SPEED_FACTOR,
  KNIFE_DECEL,
  KNIFE_FLY_RADIUS,
  KNIFE_LENGTH,
  KNIFE_RECATCH_DELAY,
  KNIFE_STOP_SPEED,
  KNIFE_WIDTH,
  MIN_PLAYERS_TO_START,
  PLAYER_RADIUS,
  ROUND_OVER_TIME,
  RUNNER_SPEED_BONUS_CAP,
  RUNNER_SPEED_BONUS_PER_CONVERSION,
  THROW_SPEED_MAX,
  THROW_SPEED_MIN,
  TICK_RATE,
  TURN_RATE,
} from './constants.js';
import { circleObbPush, circleRectOverlap, circleRectPush, lerp, wrapAngle } from './geom.js';
import { Rng, nextSeed } from './rng.js';
import { pickPassTarget } from './targeting.js';
import {
  EMPTY_INPUT,
  copyInput,
  type Arena,
  type Dir,
  type FlyingKnife,
  type GameState,
  type KnifeState,
  type PlayerInput,
  type PlayerState,
  type ThrowIntent,
  type Vec,
} from './types.js';

const DIRS: Dir[] = ['fwd', 'back', 'left', 'right'];

export function createState(seed: number): GameState {
  return {
    tick: 0,
    phase: 'lobby',
    phaseEndsTick: 0,
    round: 0,
    seed: seed >>> 0,
    players: [],
    knife: { mode: 'ground', x: 0, y: 0, heading: 0 },
    conversions: 0,
    lastCaught: -1,
    roundStartTick: 0,
    events: [],
    nextPlayerId: 1,
  };
}

export function findPlayer(state: GameState, id: number): PlayerState | undefined {
  return state.players.find((p) => p.id === id);
}

export function runnerSpeedMultiplier(state: GameState): number {
  return 1 + Math.min(RUNNER_SPEED_BONUS_CAP, RUNNER_SPEED_BONUS_PER_CONVERSION * state.conversions);
}

export function speedFor(state: GameState, p: PlayerState): number {
  const runnerSpeed = BASE_SPEED * runnerSpeedMultiplier(state);
  if (p.role === 'runner') return runnerSpeed;
  if (state.knife.mode === 'held' && state.knife.holder === p.id) {
    // Relative to the runners' original speed, not their boosted speed.
    return BASE_SPEED * KNIFE_CARRIER_SPEED_FACTOR;
  }
  return BASE_SPEED;
}

function freeSpawn(state: GameState, arena: Arena, rng: Rng): { x: number; y: number; heading: number } {
  const order = arena.spawns.slice();
  for (let i = order.length - 1; i > 0; i--) {
    const j = rng.int(0, i);
    const t = order[i]!;
    order[i] = order[j]!;
    order[j] = t;
  }
  for (const s of order) {
    let ok = true;
    for (const p of state.players) {
      if (Math.hypot(p.x - s.x, p.y - s.y) < PLAYER_RADIUS * 3) {
        ok = false;
        break;
      }
    }
    if (ok) return { x: s.x, y: s.y, heading: rng.float(-Math.PI, Math.PI) };
  }
  const s = order[0] ?? { x: arena.width / 2, y: arena.height / 2 };
  return { x: s.x, y: s.y, heading: 0 };
}

/** Add a player. Late joiners during a round start as runners. */
export function addPlayer(state: GameState, name: string, color: number): PlayerState {
  const arena = getArena(state.seed);
  const rng = new Rng((state.seed ^ (state.tick * 2654435761)) >>> 0);
  const pos = freeSpawn(state, arena, rng);
  const p: PlayerState = {
    id: state.nextPlayerId++,
    name,
    color,
    x: pos.x,
    y: pos.y,
    heading: pos.heading,
    role: 'runner',
    moveSpeed: 0,
    charge: -1,
    caughtTick: -1,
    catches: 0,
    wins: 0,
    connected: true,
    prevInput: copyInput(EMPTY_INPUT),
  };
  state.players.push(p);
  return p;
}

export function removePlayer(state: GameState, id: number): void {
  const idx = state.players.findIndex((p) => p.id === id);
  if (idx === -1) return;
  state.players.splice(idx, 1);
  if (state.knife.mode === 'held' && state.knife.holder === id) {
    const p = state.players[idx] ?? state.players[0];
    // Drop the knife where the player stood, or hand it to someone if the
    // round is in progress and there is another puukottaja.
    const other = state.players.find((q) => q.role === 'puukottaja');
    if (other) state.knife = { mode: 'held', holder: other.id };
    else state.knife = { mode: 'ground', x: p?.x ?? 100, y: p?.y ?? 100, heading: 0 };
  }
  if (state.lastCaught === id) state.lastCaught = -1;
}

function startRound(state: GameState): void {
  state.round++;
  state.seed = nextSeed(state.seed ^ state.round);
  const arena = getArena(state.seed);
  const rng = new Rng(state.seed);
  state.conversions = 0;
  state.roundStartTick = state.tick;
  // Place everyone fresh.
  const placed: PlayerState[] = [];
  for (const p of state.players) {
    p.role = 'runner';
    p.moveSpeed = 0;
    p.charge = -1;
    p.caughtTick = -1;
    p.catches = 0;
    p.prevInput = copyInput(EMPTY_INPUT);
    // freeSpawn checks against all players, so temporarily move the unplaced far away.
    p.x = -10000;
    p.y = -10000;
  }
  for (const p of state.players) {
    const pos = freeSpawn(state, arena, rng);
    p.x = pos.x;
    p.y = pos.y;
    p.heading = pos.heading;
    placed.push(p);
  }
  let it = state.players.find((p) => p.id === state.lastCaught);
  if (!it) it = rng.pick(state.players);
  it.role = 'puukottaja';
  state.knife = { mode: 'held', holder: it.id };
  state.phase = 'countdown';
  state.phaseEndsTick = state.tick + Math.round(COUNTDOWN_TIME * TICK_RATE);
  state.events.push({ type: 'roundStart', round: state.round });
}

function convert(state: GameState, who: PlayerState, by: PlayerState, viaKnife: boolean): void {
  if (who.role === 'puukottaja') return;
  who.role = 'puukottaja';
  who.caughtTick = state.tick;
  who.charge = -1;
  by.catches++;
  state.conversions++;
  state.lastCaught = who.id;
  state.events.push({ type: 'convert', who: who.id, by: by.id, viaKnife });
}

/**
 * Build the flying knife for a throw, or null when the knife would spawn
 * inside a wall (point-blank throw into an obstacle: it stays in hand).
 */
export function createThrow(
  arena: Arena,
  thrower: PlayerState,
  angle: number,
  charge: number,
  target: number,
): FlyingKnife | null {
  const speed = lerp(THROW_SPEED_MIN, THROW_SPEED_MAX, Math.max(0, Math.min(1, charge)));
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const startDist = PLAYER_RADIUS + KNIFE_FLY_RADIUS + 1;
  const sx = thrower.x + cos * startDist;
  const sy = thrower.y + sin * startDist;
  if (hitsObstacle(arena, sx, sy, KNIFE_FLY_RADIUS)) return null;
  return { mode: 'flying', x: sx, y: sy, heading: angle, vx: cos * speed, vy: sin * speed, thrower: thrower.id, target, airTime: 0 };
}

function throwKnife(state: GameState, thrower: PlayerState, angle: number, charge: number, target: number): void {
  const k = createThrow(getArena(state.seed), thrower, angle, charge, target);
  if (!k) return;
  state.knife = k;
  state.events.push({ type: 'throw', by: thrower.id, target, charge });
}

function pickup(state: GameState, p: PlayerState): void {
  state.knife = { mode: 'held', holder: p.id };
  state.events.push({ type: 'pickup', by: p.id });
}

function land(state: GameState, x: number, y: number, heading: number): void {
  state.knife = { mode: 'ground', x, y, heading };
  state.events.push({ type: 'knifeLanded' });
}

export function resolveObstacles(arena: Arena, p: { x: number; y: number }, r: number): void {
  // Two passes so corner overlaps settle.
  for (let pass = 0; pass < 2; pass++) {
    let any = false;
    for (const o of arena.obstacles) {
      const push = circleRectPush(p.x, p.y, r, o);
      if (push) {
        p.x += push.x;
        p.y += push.y;
        any = true;
      }
    }
    if (!any) break;
  }
}

function hitsObstacle(arena: Arena, x: number, y: number, r: number): boolean {
  for (const o of arena.obstacles) if (circleRectOverlap(x, y, r, o)) return true;
  return false;
}

function movePlayer(state: GameState, arena: Arena, p: PlayerState, input: PlayerInput, frozen: boolean): void {
  if (frozen) {
    p.moveSpeed = 0;
    return;
  }
  if (input.left) p.heading -= TURN_RATE * DT;
  if (input.right) p.heading += TURN_RATE * DT;
  p.heading = wrapAngle(p.heading);
  if (p.charge >= 0) {
    // Charging a throw: movement input is ignored and the player slides to a stop.
    const drop = CHARGE_DECEL * DT;
    if (Math.abs(p.moveSpeed) <= drop) p.moveSpeed = 0;
    else p.moveSpeed -= Math.sign(p.moveSpeed) * drop;
  } else {
    const move = (input.fwd ? 1 : 0) - (input.back ? 1 : 0);
    p.moveSpeed = move === 0 ? 0 : speedFor(state, p) * (move < 0 ? 0.75 : 1) * move;
  }
  if (p.moveSpeed !== 0) {
    p.x += Math.cos(p.heading) * p.moveSpeed * DT;
    p.y += Math.sin(p.heading) * p.moveSpeed * DT;
  }
  resolveObstacles(arena, p, PLAYER_RADIUS);
}

/**
 * Charge bookkeeping shared by the authoritative step and client prediction.
 * Mutates `p.charge` and reports whether a throw should happen this tick.
 */
function updateCharge(state: GameState, p: PlayerState, input: PlayerInput, interactive: boolean): ThrowIntent {
  const holding = state.knife.mode === 'held' && state.knife.holder === p.id;
  if (!holding || !interactive) {
    p.charge = -1;
    return { kind: 'none' };
  }
  const prev = p.prevInput;
  if (p.charge < 0) {
    if (input.throw && !prev.throw) p.charge = 0;
    return { kind: 'none' };
  }
  if (!input.throw) {
    p.charge = -1;
    return { kind: 'straight' };
  }
  p.charge = Math.min(1, p.charge + DT / CHARGE_TIME);
  // A freshly pressed direction while charging passes to a fellow puukottaja.
  for (const d of DIRS) {
    if (input[d] && !prev[d]) {
      const mates = state.players.filter((q) => q.role === 'puukottaja' && q.id !== p.id);
      const target = pickPassTarget(p, mates, d);
      if (target) {
        p.charge = -1;
        return { kind: 'pass', target };
      }
      return { kind: 'none' };
    }
  }
  return { kind: 'none' };
}

function updateThrowing(state: GameState, p: PlayerState, input: PlayerInput, interactive: boolean): void {
  const charge = p.charge;
  const r = updateCharge(state, p, input, interactive);
  if (r.kind === 'straight') throwKnife(state, p, p.heading, charge, -1);
  else if (r.kind === 'pass') {
    throwKnife(state, p, Math.atan2(r.target.y - p.y, r.target.x - p.x), charge, r.target.id);
  }
}

/**
 * Advance a flying knife one tick against the arena. `onSubstep` runs after
 * each sub-movement and returns true if something caught the knife. Returns
 * the knife's new state: itself while still flying, or a ground state.
 */
export function flyKnife(arena: Arena, k: FlyingKnife, onSubstep: ((k: FlyingKnife) => boolean) | null): KnifeState {
  const speed = Math.hypot(k.vx, k.vy);
  const stepLen = speed * DT;
  const substeps = Math.max(1, Math.ceil(stepLen / 4));
  const sx = k.vx * DT / substeps;
  const sy = k.vy * DT / substeps;
  for (let s = 0; s < substeps; s++) {
    const nx = k.x + sx;
    const ny = k.y + sy;
    if (hitsObstacle(arena, nx, ny, KNIFE_FLY_RADIUS)) return { mode: 'ground', x: k.x, y: k.y, heading: k.heading };
    k.x = nx;
    k.y = ny;
    if (onSubstep && onSubstep(k)) return k;
  }
  k.airTime += DT;
  const newSpeed = speed - KNIFE_DECEL * DT;
  if (newSpeed <= KNIFE_STOP_SPEED) return { mode: 'ground', x: k.x, y: k.y, heading: k.heading };
  const f = newSpeed / speed;
  k.vx *= f;
  k.vy *= f;
  return k;
}

function updateKnife(state: GameState, arena: Arena, rewind: StepOptions['rewind'] | null): void {
  const k = state.knife;
  if (k.mode !== 'flying') return;
  let caught = false;
  const result = flyKnife(arena, k, (fk) => {
    for (const p of state.players) {
      const seen = (rewind && p.id !== fk.thrower && rewind(fk.thrower, p.id)) || p;
      if (Math.hypot(seen.x - fk.x, seen.y - fk.y) >= PLAYER_RADIUS + KNIFE_FLY_RADIUS) continue;
      if (p.id === fk.thrower && fk.airTime < KNIFE_RECATCH_DELAY) continue;
      if (p.role === 'runner') {
        const by = findPlayer(state, fk.thrower) ?? p;
        convert(state, p, by, true);
      }
      // A disconnected player is a sitting duck but must not hold the knife.
      if (p.connected) pickup(state, p);
      else land(state, fk.x, fk.y, fk.heading);
      caught = true;
      return true;
    }
    return false;
  });
  if (caught) return;
  if (result.mode === 'ground') land(state, result.x, result.y, result.heading);
}

/** Whether a puukottaja at this position would pick up a resting knife. */
export function touchesGroundKnife(k: KnifeState, p: PlayerState): boolean {
  if (k.mode !== 'ground') return false;
  return circleObbPush(p.x, p.y, PLAYER_RADIUS, k.x, k.y, k.heading, KNIFE_LENGTH / 2, KNIFE_WIDTH / 2) !== null;
}

/** Drop a held knife at the holder's feet (used when the holder disconnects). */
export function dropKnife(state: GameState, id: number): void {
  if (state.knife.mode !== 'held' || state.knife.holder !== id) return;
  const p = findPlayer(state, id);
  if (!p) return;
  p.charge = -1;
  land(state, p.x, p.y, p.heading);
}

/** Push a runner out of the ground knife. Returns true if the player touched it. */
function groundKnifePush(state: GameState, p: PlayerState): boolean {
  const k = state.knife;
  if (k.mode !== 'ground') return false;
  const push = circleObbPush(p.x, p.y, PLAYER_RADIUS, k.x, k.y, k.heading, KNIFE_LENGTH / 2, KNIFE_WIDTH / 2);
  if (!push) return false;
  if (p.role === 'runner') {
    p.x += push.x;
    p.y += push.y;
  }
  return true;
}

function groundKnifeInteractions(state: GameState): void {
  for (const p of state.players) {
    if (groundKnifePush(state, p) && p.role === 'puukottaja' && p.connected) {
      pickup(state, p);
      return;
    }
  }
}

function playerInteractions(
  state: GameState,
  arena: Arena,
  interactive: boolean,
  rewind: StepOptions['rewind'] | null,
): void {
  const ps = state.players;
  const minD = PLAYER_RADIUS * 2;
  if (interactive) {
    // Touches are judged from the puukottaja's point of view (lag compensated).
    for (const a of ps) {
      if (a.role !== 'puukottaja') continue;
      for (const b of ps) {
        if (b.role !== 'runner') continue;
        const seen = (rewind && rewind(a.id, b.id)) || b;
        if (Math.hypot(seen.x - a.x, seen.y - a.y) < minD) convert(state, b, a, false);
      }
    }
  }
  for (let i = 0; i < ps.length; i++) {
    for (let j = i + 1; j < ps.length; j++) separateBodies(arena, ps[i]!, ps[j]!);
  }
}

/** Push two overlapping players apart (half each) and keep them out of walls. Shared with prediction. */
export function separateBodies(arena: Arena, a: PlayerState, b: PlayerState): void {
  const minD = PLAYER_RADIUS * 2;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const d = Math.hypot(dx, dy);
  if (d >= minD) return;
  const nx = d > 1e-6 ? dx / d : 1;
  const ny = d > 1e-6 ? dy / d : 0;
  const push = (minD - d) / 2;
  a.x -= nx * push;
  a.y -= ny * push;
  b.x += nx * push;
  b.y += ny * push;
  resolveObstacles(arena, a, PLAYER_RADIUS);
  resolveObstacles(arena, b, PLAYER_RADIUS);
}

export interface StepOptions {
  /**
   * Lag compensation: where `viewer` currently sees `target`. Return null to
   * use the live position. Only touch and knife-hit checks consult this.
   */
  rewind?: (viewerId: number, targetId: number) => Vec | null;
}

const NO_REWIND: StepOptions = {};

/** Advance the simulation by one fixed tick. Inputs map player id -> input. */
export function step(state: GameState, inputs: ReadonlyMap<number, PlayerInput>, opts: StepOptions = NO_REWIND): void {
  state.tick++;
  const arena = getArena(state.seed);

  // Phase transitions.
  switch (state.phase) {
    case 'lobby':
      if (state.players.length >= MIN_PLAYERS_TO_START) startRound(state);
      break;
    case 'countdown':
      if (state.players.length < MIN_PLAYERS_TO_START) state.phase = 'lobby';
      else if (state.tick >= state.phaseEndsTick) state.phase = 'playing';
      break;
    case 'playing':
      if (state.players.length < MIN_PLAYERS_TO_START) state.phase = 'lobby';
      break;
    case 'roundover':
      if (state.tick >= state.phaseEndsTick) {
        if (state.players.length >= MIN_PLAYERS_TO_START) startRound(state);
        else state.phase = 'lobby';
      }
      break;
  }

  const phase = state.phase;
  const interactive = phase === 'playing';
  const playing = phase === 'playing' || phase === 'countdown';

  for (const p of state.players) {
    const input = inputs.get(p.id) ?? EMPTY_INPUT;
    const frozen = phase === 'countdown' && p.role === 'puukottaja';
    movePlayer(state, arena, p, input, frozen);
    if (playing) updateThrowing(state, p, input, interactive);
    else p.charge = -1;
  }

  const rewind = opts.rewind ?? null;
  if (interactive) {
    updateKnife(state, arena, rewind);
    groundKnifeInteractions(state);
  }
  playerInteractions(state, arena, interactive, rewind);

  // Keep the knife holder consistent if the holder vanished.
  if (state.knife.mode === 'held' && !findPlayer(state, state.knife.holder)) {
    const other = state.players.find((q) => q.role === 'puukottaja');
    if (other) state.knife = { mode: 'held', holder: other.id };
  }

  if (interactive) {
    const runners = state.players.filter((p) => p.role === 'runner');
    if (runners.length === 0 && state.players.length >= MIN_PLAYERS_TO_START) {
      const winner = findPlayer(state, state.lastCaught);
      if (winner) winner.wins++;
      state.phase = 'roundover';
      state.phaseEndsTick = state.tick + Math.round(ROUND_OVER_TIME * TICK_RATE);
      state.events.push({ type: 'roundOver', winner: winner?.id ?? -1 });
    }
  }

  for (const p of state.players) {
    const input = inputs.get(p.id) ?? EMPTY_INPUT;
    p.prevInput = copyInput(input);
  }
}

/**
 * Client-side prediction for one locally controlled player. Applies exactly
 * the movement and charge rules of `step` for that player and nothing else:
 * no throws, conversions, pickups or body separation. Everything it reads
 * from `state` (phase, knife holder, conversions, other players) comes from
 * the last snapshot; only `p` is mutated.
 */
export function predictLocalPlayer(state: GameState, p: PlayerState, input: PlayerInput): ThrowIntent {
  const arena = getArena(state.seed);
  const phase = state.phase;
  const frozen = phase === 'countdown' && p.role === 'puukottaja';
  movePlayer(state, arena, p, input, frozen);
  let intent: ThrowIntent = { kind: 'none' };
  if (phase === 'playing' || phase === 'countdown') intent = updateCharge(state, p, input, phase === 'playing');
  else p.charge = -1;
  if (phase === 'playing') groundKnifePush(state, p);
  p.prevInput = copyInput(input);
  return intent;
}

export function knifeWorldPosition(state: GameState): { x: number; y: number; heading: number } | null {
  const k: KnifeState = state.knife;
  if (k.mode === 'held') {
    const h = findPlayer(state, k.holder);
    if (!h) return null;
    // Carried in the right hand, pointing forward.
    const side = Math.PI / 2;
    return {
      x: h.x + Math.cos(h.heading + side) * (PLAYER_RADIUS * 0.8) + Math.cos(h.heading) * 8,
      y: h.y + Math.sin(h.heading + side) * (PLAYER_RADIUS * 0.8) + Math.sin(h.heading) * 8,
      heading: h.heading,
    };
  }
  return { x: k.x, y: k.y, heading: k.heading };
}
