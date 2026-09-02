import { getArena } from '../sim/arena.js';
import { DT, PLAYER_RADIUS } from '../sim/constants.js';
import { flyKnife, resolveObstacles } from '../sim/sim.js';
import type { FlyingKnife, GameState, KnifeState } from '../sim/types.js';

/** Never guess further ahead than this; beyond it, freezing looks better than drifting. */
export const MAX_EXTRAPOLATION_TICKS = 6;

/**
 * Dead reckoning for late snapshots: every player not in `skip` keeps moving
 * along their heading at their last speed, the flying knife keeps flying.
 * Returns a new state; `state` is not mutated.
 */
export function extrapolateState(state: GameState, ticks: number, skip: ReadonlySet<number>): GameState {
  const n = Math.min(MAX_EXTRAPOLATION_TICKS, Math.max(0, Math.floor(ticks)));
  if (n === 0) return state;
  const arena = getArena(state.seed);
  const players = state.players.map((p) => {
    if (skip.has(p.id) || p.moveSpeed === 0 || !p.connected) return p;
    const q = { ...p, x: p.x + Math.cos(p.heading) * p.moveSpeed * DT * n, y: p.y + Math.sin(p.heading) * p.moveSpeed * DT * n };
    resolveObstacles(arena, q, PLAYER_RADIUS);
    return q;
  });
  let knife: KnifeState = state.knife;
  if (knife.mode === 'flying' && !skip.has(knife.thrower)) {
    let k: KnifeState = { ...knife };
    for (let i = 0; i < n && k.mode === 'flying'; i++) k = flyKnife(arena, k as FlyingKnife, null);
    knife = k;
  }
  return { ...state, players, knife };
}
