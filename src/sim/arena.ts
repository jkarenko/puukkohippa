import { ARENA_H, ARENA_W, PLAYER_RADIUS } from './constants.js';
import { circleRectOverlap, rectsOverlap } from './geom.js';
import { Rng } from './rng.js';
import type { Arena, Rect, Vec } from './types.js';

const BORDER = 24;
/** Obstacle placement is snapped to this grid so corridors line up nicely. */
const SNAP = 8;
/** Minimum clearance between obstacles: room for two players side by side. */
const MIN_GAP = PLAYER_RADIUS * 2 * 2 + 8;
/** Cell size of the walkability raster used for the connectivity check. */
const CELL = 12;

const arenaCache = new Map<number, Arena>();

/** Memoised arena for a seed. Client and server call this independently. */
export function getArena(seed: number): Arena {
  let a = arenaCache.get(seed);
  if (!a) {
    a = generateArena(seed);
    arenaCache.set(seed, a);
    if (arenaCache.size > 8) {
      const oldest = arenaCache.keys().next().value;
      if (oldest !== undefined) arenaCache.delete(oldest);
    }
  }
  return a;
}

function snap(v: number): number {
  return Math.round(v / SNAP) * SNAP;
}

function borderWalls(w: number, h: number): Rect[] {
  return [
    { x: 0, y: 0, w, h: BORDER },
    { x: 0, y: h - BORDER, w, h: BORDER },
    { x: 0, y: 0, w: BORDER, h },
    { x: w - BORDER, y: 0, w: BORDER, h },
  ];
}

type Feature = Rect[];

function makeBlock(rng: Rng): Feature {
  return [{ x: 0, y: 0, w: snap(rng.float(60, 220)), h: snap(rng.float(60, 220)) }];
}

function makeWall(rng: Rng): Feature {
  const len = snap(rng.float(180, 520));
  const t = snap(rng.float(16, 32));
  return rng.chance(0.5) ? [{ x: 0, y: 0, w: len, h: t }] : [{ x: 0, y: 0, w: t, h: len }];
}

function makeCorner(rng: Rng): Feature {
  const a = snap(rng.float(120, 320));
  const b = snap(rng.float(120, 320));
  const t = snap(rng.float(16, 32));
  // Canonical L: corner at the origin, arms along +x and +y. Mirror into one
  // of the four orientations.
  const rects: Rect[] = [
    { x: 0, y: 0, w: a, h: t },
    { x: 0, y: 0, w: t, h: b },
  ];
  const flipX = rng.chance(0.5);
  const flipY = rng.chance(0.5);
  return rects.map((r) => ({
    x: flipX ? -(r.x + r.w) : r.x,
    y: flipY ? -(r.y + r.h) : r.y,
    w: r.w,
    h: r.h,
  }));
}

function featureBounds(f: Feature): Rect {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const r of f) {
    x0 = Math.min(x0, r.x);
    y0 = Math.min(y0, r.y);
    x1 = Math.max(x1, r.x + r.w);
    y1 = Math.max(y1, r.y + r.h);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

function translate(f: Feature, dx: number, dy: number): Feature {
  return f.map((r) => ({ x: r.x + dx, y: r.y + dy, w: r.w, h: r.h }));
}

function isFree(x: number, y: number, r: number, obstacles: Rect[]): boolean {
  for (const o of obstacles) if (circleRectOverlap(x, y, r, o)) return false;
  return true;
}

/**
 * Rasterises walkable cells and returns the fraction of walkable cells that
 * belong to the largest connected component, plus the cells themselves.
 */
function connectivity(
  w: number,
  h: number,
  obstacles: Rect[],
): { fraction: number; mainCells: Vec[] } {
  const cols = Math.floor(w / CELL);
  const rows = Math.floor(h / CELL);
  const free = new Uint8Array(cols * rows);
  let freeCount = 0;
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const cx = (i + 0.5) * CELL;
      const cy = (j + 0.5) * CELL;
      if (isFree(cx, cy, PLAYER_RADIUS + 1, obstacles)) {
        free[j * cols + i] = 1;
        freeCount++;
      }
    }
  }
  const comp = new Int32Array(cols * rows).fill(-1);
  let best = -1;
  let bestSize = 0;
  let nComp = 0;
  const stack: number[] = [];
  for (let start = 0; start < free.length; start++) {
    if (!free[start] || comp[start] !== -1) continue;
    const id = nComp++;
    let size = 0;
    stack.push(start);
    comp[start] = id;
    while (stack.length) {
      const c = stack.pop() as number;
      size++;
      const i = c % cols;
      const j = (c - i) / cols;
      const nb = [c - 1, c + 1, c - cols, c + cols];
      const ok = [i > 0, i < cols - 1, j > 0, j < rows - 1];
      for (let k = 0; k < 4; k++) {
        const n = nb[k] as number;
        if (ok[k] && free[n] && comp[n] === -1) {
          comp[n] = id;
          stack.push(n);
        }
      }
    }
    if (size > bestSize) {
      bestSize = size;
      best = id;
    }
  }
  const mainCells: Vec[] = [];
  for (let c = 0; c < comp.length; c++) {
    if (comp[c] === best) {
      const i = c % cols;
      const j = (c - i) / cols;
      mainCells.push({ x: (i + 0.5) * CELL, y: (j + 0.5) * CELL });
    }
  }
  return { fraction: freeCount ? bestSize / freeCount : 0, mainCells };
}

function pickSpawns(rng: Rng, cells: Vec[], obstacles: Rect[], count: number): Vec[] {
  const spawns: Vec[] = [];
  const minDist = 90;
  const candidates = cells.filter((c) => isFree(c.x, c.y, PLAYER_RADIUS * 2.5, obstacles));
  // Deterministic shuffle.
  for (let i = candidates.length - 1; i > 0; i--) {
    const j = rng.int(0, i);
    const t = candidates[i] as Vec;
    candidates[i] = candidates[j] as Vec;
    candidates[j] = t;
  }
  for (const c of candidates) {
    if (spawns.length >= count) break;
    let ok = true;
    for (const s of spawns) {
      if (Math.hypot(s.x - c.x, s.y - c.y) < minDist) {
        ok = false;
        break;
      }
    }
    if (ok) spawns.push({ x: c.x, y: c.y });
  }
  return spawns;
}

export function generateArena(seed: number, width = ARENA_W, height = ARENA_H): Arena {
  for (let attempt = 0; attempt < 32; attempt++) {
    const rng = new Rng((seed + attempt * 7919) >>> 0);
    const obstacles: Rect[] = borderWalls(width, height);
    const featureCount = rng.int(11, 17);
    let placed = 0;
    let tries = 0;
    while (placed < featureCount && tries < 400) {
      tries++;
      const roll = rng.next();
      const f = roll < 0.4 ? makeBlock(rng) : roll < 0.75 ? makeWall(rng) : makeCorner(rng);
      const b = featureBounds(f);
      const x = snap(rng.float(BORDER + MIN_GAP, width - BORDER - MIN_GAP - b.w)) - b.x;
      const y = snap(rng.float(BORDER + MIN_GAP, height - BORDER - MIN_GAP - b.h)) - b.y;
      const moved = translate(f, x, y);
      let ok = true;
      for (const r of moved) {
        // Keep the centre of the arena a bit more open so play starts spread out.
        for (const o of obstacles) {
          if (rectsOverlap(r, o, MIN_GAP)) {
            ok = false;
            break;
          }
        }
        if (!ok) break;
      }
      if (!ok) continue;
      obstacles.push(...moved);
      placed++;
    }
    const conn = connectivity(width, height, obstacles);
    if (conn.fraction < 0.97) continue;
    const spawns = pickSpawns(rng, conn.mainCells, obstacles, 48);
    if (spawns.length < 8) continue;
    return { seed, width, height, obstacles, spawns };
  }
  // Extremely unlikely fallback: an empty arena is always valid.
  const obstacles = borderWalls(width, height);
  const spawns: Vec[] = [];
  for (let i = 0; i < 8; i++) spawns.push({ x: 200 + i * 150, y: height / 2 });
  return { seed, width, height, obstacles, spawns };
}

/** Whether a circle at (x, y) is free of all arena obstacles. */
export function arenaIsFree(arena: Arena, x: number, y: number, r: number): boolean {
  return isFree(x, y, r, arena.obstacles);
}
