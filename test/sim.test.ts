import { beforeEach, describe, expect, it } from 'vitest';
import { getArena } from '../src/sim/arena.js';
import {
  BASE_SPEED,
  COUNTDOWN_TIME,
  KNIFE_CARRIER_SPEED_FACTOR,
  PLAYER_RADIUS,
  RUNNER_SPEED_BONUS_PER_CONVERSION,
  TICK_RATE,
} from '../src/sim/constants.js';
import { addPlayer, createState, findPlayer, speedFor, step } from '../src/sim/sim.js';
import { EMPTY_INPUT, type GameState, type PlayerInput, type PlayerState } from '../src/sim/types.js';

function inp(partial: Partial<PlayerInput> = {}): PlayerInput {
  return { ...EMPTY_INPUT, ...partial };
}

function run(state: GameState, inputs: Map<number, PlayerInput>, ticks: number): void {
  for (let i = 0; i < ticks; i++) step(state, inputs);
}

/** Bring a fresh two-player state into the 'playing' phase. */
function setupPlaying(): { state: GameState; it: PlayerState; runner: PlayerState } {
  const state = createState(4242);
  addPlayer(state, 'A', 0xff0000);
  addPlayer(state, 'B', 0x00ff00);
  const none = new Map<number, PlayerInput>();
  run(state, none, COUNTDOWN_TIME * TICK_RATE + 2);
  expect(state.phase).toBe('playing');
  const it = state.players.find((p) => p.role === 'puukottaja')!;
  const runner = state.players.find((p) => p.role === 'runner')!;
  return { state, it, runner };
}

/** Find an open horizontal stretch in the arena and place a player there facing +x. */
function placeInOpenRow(state: GameState, p: PlayerState, needed: number): void {
  const arena = getArena(state.seed);
  for (let y = 80; y < arena.height - 80; y += 20) {
    for (let x = 80; x < arena.width - needed - 80; x += 20) {
      let ok = true;
      for (let dx = -PLAYER_RADIUS * 2; dx <= needed && ok; dx += 6) {
        for (const o of arena.obstacles) {
          const cx = x + dx;
          if (cx + 20 > o.x && cx - 20 < o.x + o.w && y + 20 > o.y && y - 20 < o.y + o.h) {
            ok = false;
            break;
          }
        }
      }
      if (ok) {
        p.x = x;
        p.y = y;
        p.heading = 0;
        return;
      }
    }
  }
  throw new Error('no open row found');
}

describe('phases', () => {
  it('waits in the lobby until two players join, then counts down and plays', () => {
    const state = createState(1);
    const none = new Map<number, PlayerInput>();
    addPlayer(state, 'solo', 1);
    run(state, none, 10);
    expect(state.phase).toBe('lobby');
    addPlayer(state, 'second', 2);
    step(state, none);
    expect(state.phase).toBe('countdown');
    expect(state.round).toBe(1);
    expect(state.players.filter((p) => p.role === 'puukottaja')).toHaveLength(1);
    expect(state.knife.mode).toBe('held');
    run(state, none, COUNTDOWN_TIME * TICK_RATE + 1);
    expect(state.phase).toBe('playing');
  });
});

describe('speeds', () => {
  let ctx: ReturnType<typeof setupPlaying>;
  beforeEach(() => {
    ctx = setupPlaying();
  });

  it('knife carrier is 90 % of runner speed', () => {
    expect(speedFor(ctx.state, ctx.runner)).toBeCloseTo(BASE_SPEED);
    expect(speedFor(ctx.state, ctx.it)).toBeCloseTo(BASE_SPEED * KNIFE_CARRIER_SPEED_FACTOR);
  });

  it('runners speed up after a conversion, the carrier does not', () => {
    ctx.state.conversions = 1;
    expect(speedFor(ctx.state, ctx.runner)).toBeCloseTo(BASE_SPEED * (1 + RUNNER_SPEED_BONUS_PER_CONVERSION));
    expect(speedFor(ctx.state, ctx.it)).toBeCloseTo(BASE_SPEED * KNIFE_CARRIER_SPEED_FACTOR);
  });
});

describe('touch conversion', () => {
  it('a puukottaja touching a runner converts them', () => {
    const { state, it, runner } = setupPlaying();
    runner.x = it.x + PLAYER_RADIUS * 1.5;
    runner.y = it.y;
    step(state, new Map());
    expect(runner.role).toBe('puukottaja');
    expect(state.conversions).toBe(1);
    expect(it.catches).toBe(1);
    expect(state.events.some((e) => e.type === 'convert' && !e.viaKnife)).toBe(true);
  });

  it('ends the round when no runners remain', () => {
    const { state, it, runner } = setupPlaying();
    runner.x = it.x;
    runner.y = it.y;
    step(state, new Map());
    expect(state.phase).toBe('roundover');
    expect(state.lastCaught).toBe(runner.id);
    expect(runner.wins).toBe(1);
  });
});

describe('throwing', () => {
  it('a longer charge throws farther, and the knife lands on the ground', () => {
    const distances: number[] = [];
    for (const holdTicks of [3, 60]) {
      const { state, it, runner } = setupPlaying();
      placeInOpenRow(state, it, 900);
      runner.x = 60;
      runner.y = state.players[0]!.y + 400; // out of the way
      const startX = it.x;
      const inputs = new Map<number, PlayerInput>();
      inputs.set(it.id, inp({ throw: true }));
      run(state, inputs, holdTicks);
      expect(state.knife.mode).toBe('held');
      inputs.set(it.id, inp());
      step(state, inputs);
      expect(state.knife.mode).toBe('flying');
      run(state, inputs, 240);
      expect(state.knife.mode).toBe('ground');
      const k = state.knife as { x: number };
      distances.push(k.x - startX);
    }
    expect(distances[0]!).toBeGreaterThan(50);
    expect(distances[1]!).toBeGreaterThan(distances[0]! * 2);
  });

  it('holding the throw button brings the carrier to a stop with deceleration', () => {
    const { state, it, runner } = setupPlaying();
    placeInOpenRow(state, it, 600);
    runner.x = 60;
    runner.y = it.y + 400;
    const inputs = new Map<number, PlayerInput>();
    inputs.set(it.id, inp({ fwd: true }));
    run(state, inputs, 30);
    const movingX = it.x;
    // Keep holding forward, start charging.
    inputs.set(it.id, inp({ fwd: true, throw: true }));
    step(state, inputs); // rising edge: charge starts, this tick still moves at full speed
    step(state, inputs);
    const afterOneDecelTick = it.x;
    expect(afterOneDecelTick).toBeGreaterThan(movingX); // still sliding
    run(state, inputs, 60);
    const stoppedX = it.x;
    step(state, inputs);
    expect(it.x).toBe(stoppedX); // fully stopped while still charging
    expect(it.charge).toBeGreaterThan(0);
    expect(stoppedX - afterOneDecelTick).toBeLessThan(60); // short slide, not a long coast
    // Releasing throws; movement input works again right after.
    inputs.set(it.id, inp({ fwd: true }));
    step(state, inputs);
    expect(state.knife.mode).toBe('flying');
    step(state, inputs);
    expect(it.x).toBeGreaterThan(stoppedX);
  });

  it('a flying knife converts a runner and the runner picks it up', () => {
    const { state, it, runner } = setupPlaying();
    placeInOpenRow(state, it, 400);
    runner.x = it.x + 200;
    runner.y = it.y;
    const inputs = new Map<number, PlayerInput>();
    inputs.set(it.id, inp({ throw: true }));
    run(state, inputs, 30);
    inputs.set(it.id, inp());
    run(state, inputs, 60);
    expect(runner.role).toBe('puukottaja');
    expect(state.knife).toEqual({ mode: 'held', holder: runner.id });
    expect(state.events.some((e) => e.type === 'convert' && e.viaKnife)).toBe(true);
  });

  it('a knife on the ground blocks runners and is picked up by puukottajat', () => {
    const { state, it, runner } = setupPlaying();
    placeInOpenRow(state, it, 300);
    const kx = it.x + 150;
    const ky = it.y;
    // Knife lying across the corridor (perpendicular to the row).
    state.knife = { mode: 'ground', x: kx, y: ky, heading: Math.PI / 2 };
    runner.x = kx - 60;
    runner.y = ky;
    runner.heading = 0;
    it.x = kx - 600; // keep the puukottaja far away for now
    const inputs = new Map<number, PlayerInput>();
    inputs.set(runner.id, inp({ fwd: true }));
    run(state, inputs, 60);
    expect(runner.role).toBe('runner');
    expect(runner.x).toBeLessThan(kx);
    expect(state.knife.mode).toBe('ground');
    // Now a puukottaja walks into it (runner moved out of the way).
    runner.x = kx - 600;
    runner.y = ky + 200;
    it.x = kx - 40;
    it.y = ky;
    it.heading = 0;
    inputs.set(it.id, inp({ fwd: true }));
    inputs.set(runner.id, inp());
    run(state, inputs, 30);
    expect(state.knife).toEqual({ mode: 'held', holder: it.id });
  });

  it('pressing a direction while charging passes to the nearest puukottaja that way', () => {
    const { state, it, runner } = setupPlaying();
    addPlayer(state, 'C', 3);
    const c = state.players[2]!;
    // Make C a fellow puukottaja far away to the right of the thrower.
    c.role = 'puukottaja';
    placeInOpenRow(state, it, 400);
    c.x = it.x + 300;
    c.y = it.y;
    runner.x = it.x - 400;
    runner.y = it.y + 300;
    const inputs = new Map<number, PlayerInput>();
    inputs.set(it.id, inp({ throw: true }));
    run(state, inputs, 20);
    inputs.set(it.id, inp({ throw: true, fwd: true }));
    step(state, inputs);
    expect(state.knife.mode).toBe('flying');
    const k = state.knife as { target: number };
    expect(k.target).toBe(c.id);
    expect(state.events.some((e) => e.type === 'throw' && e.target === c.id)).toBe(true);
    run(state, inputs, 90);
    expect(state.knife).toEqual({ mode: 'held', holder: c.id });
    expect(findPlayer(state, runner.id)?.role).toBe('runner');
  });
});
