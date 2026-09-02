import { describe, expect, it } from 'vitest';
import { arenaIsFree, generateArena, getArena } from '../src/sim/arena.js';
import { ARENA_H, ARENA_W, PLAYER_RADIUS } from '../src/sim/constants.js';

describe('generateArena', () => {
  it('is deterministic for a seed', () => {
    const a = generateArena(12345);
    const b = generateArena(12345);
    expect(a.obstacles).toEqual(b.obstacles);
    expect(a.spawns).toEqual(b.spawns);
  });

  it('produces different arenas for different seeds', () => {
    expect(generateArena(1).obstacles).not.toEqual(generateArena(2).obstacles);
  });

  it('has border walls, obstacles and free spawn points for many seeds', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const a = generateArena(seed);
      expect(a.width).toBe(ARENA_W);
      expect(a.height).toBe(ARENA_H);
      expect(a.obstacles.length).toBeGreaterThan(8);
      expect(a.spawns.length).toBeGreaterThanOrEqual(8);
      for (const s of a.spawns) {
        expect(arenaIsFree(a, s.x, s.y, PLAYER_RADIUS * 2)).toBe(true);
      }
    }
  });

  it('memoises through getArena', () => {
    expect(getArena(77)).toBe(getArena(77));
  });
});
