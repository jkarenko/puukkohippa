import { EMPTY_INPUT, copyInput, type GameEvent, type GameState, type KnifeState, type PlayerState } from '../sim/types.js';

/**
 * Delta snapshot: only what changed since a baseline snapshot the client has
 * acknowledged. Players are diffed field by field; new players arrive whole.
 */
export interface DeltaMsg {
  t: 'delta';
  /** Tick of the baseline snapshot this delta applies to. */
  base: number;
  tick: number;
  top?: Partial<Omit<GameState, 'players' | 'knife' | 'events' | 'tick'>>;
  players?: Array<Partial<PlayerState> & { id: number }>;
  removed?: number[];
  knife?: KnifeState;
  events?: GameEvent[];
  acks: Record<string, number>;
}

const TOP_KEYS = ['phase', 'phaseEndsTick', 'round', 'seed', 'conversions', 'lastCaught', 'roundStartTick', 'nextPlayerId'] as const;
const PLAYER_KEYS = ['name', 'color', 'x', 'y', 'heading', 'role', 'moveSpeed', 'charge', 'caughtTick', 'catches', 'wins', 'connected'] as const;

export function encodeDelta(base: GameState, cur: GameState, acks: Record<string, number>): DeltaMsg {
  const d: DeltaMsg = { t: 'delta', base: base.tick, tick: cur.tick, acks };
  const top: Record<string, unknown> = {};
  for (const k of TOP_KEYS) if (base[k] !== cur[k]) top[k] = cur[k];
  if (Object.keys(top).length) d.top = top as DeltaMsg['top'];

  const baseById = new Map(base.players.map((p) => [p.id, p]));
  const players: DeltaMsg['players'] = [];
  const seen = new Set<number>();
  for (const p of cur.players) {
    seen.add(p.id);
    const b = baseById.get(p.id);
    if (!b) {
      const whole: Record<string, unknown> = { id: p.id };
      for (const k of PLAYER_KEYS) whole[k] = p[k];
      players.push(whole as Partial<PlayerState> & { id: number });
      continue;
    }
    const diff: Record<string, unknown> = { id: p.id };
    let changed = false;
    for (const k of PLAYER_KEYS) {
      if (b[k] !== p[k]) {
        diff[k] = p[k];
        changed = true;
      }
    }
    if (changed) players.push(diff as Partial<PlayerState> & { id: number });
  }
  if (players.length) d.players = players;
  const removed = base.players.filter((p) => !seen.has(p.id)).map((p) => p.id);
  if (removed.length) d.removed = removed;
  if (JSON.stringify(base.knife) !== JSON.stringify(cur.knife)) d.knife = cur.knife;
  if (cur.events.length) d.events = cur.events;
  return d;
}

/** Rebuild the full state a delta describes. The baseline is not mutated. */
export function applyDelta(base: GameState, d: DeltaMsg): GameState {
  const removed = new Set(d.removed ?? []);
  const changes = new Map((d.players ?? []).map((p) => [p.id, p]));
  const players: PlayerState[] = [];
  for (const b of base.players) {
    if (removed.has(b.id)) continue;
    const c = changes.get(b.id);
    changes.delete(b.id);
    players.push(c ? { ...b, ...c, prevInput: copyInput(EMPTY_INPUT) } : b);
  }
  // Anything left in `changes` is a new player, sent whole.
  for (const c of changes.values()) players.push({ ...(c as PlayerState), prevInput: copyInput(EMPTY_INPUT) });
  return {
    ...base,
    ...(d.top ?? {}),
    tick: d.tick,
    players,
    knife: d.knife ?? base.knife,
    events: d.events ?? [],
  };
}
