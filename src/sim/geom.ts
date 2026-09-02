import type { Rect, Vec } from './types.js';

export const TAU = Math.PI * 2;

export function wrapAngle(a: number): number {
  a = a % TAU;
  if (a > Math.PI) a -= TAU;
  if (a < -Math.PI) a += TAU;
  return a;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function lerpAngle(a: number, b: number, t: number): number {
  return a + wrapAngle(b - a) * t;
}

export function dist(ax: number, ay: number, bx: number, by: number): number {
  return Math.hypot(bx - ax, by - ay);
}

export function rectsOverlap(a: Rect, b: Rect, margin = 0): boolean {
  return (
    a.x - margin < b.x + b.w &&
    a.x + a.w + margin > b.x &&
    a.y - margin < b.y + b.h &&
    a.y + a.h + margin > b.y
  );
}

export function circleRectOverlap(cx: number, cy: number, r: number, rect: Rect): boolean {
  const nx = Math.max(rect.x, Math.min(cx, rect.x + rect.w));
  const ny = Math.max(rect.y, Math.min(cy, rect.y + rect.h));
  const dx = cx - nx;
  const dy = cy - ny;
  return dx * dx + dy * dy < r * r;
}

/**
 * Minimal translation vector that moves a circle out of a rectangle, or null
 * if they do not overlap. Handles the "centre inside rect" case by pushing
 * along the axis with the smallest penetration.
 */
export function circleRectPush(cx: number, cy: number, r: number, rect: Rect): Vec | null {
  const inside = cx > rect.x && cx < rect.x + rect.w && cy > rect.y && cy < rect.y + rect.h;
  if (inside) {
    const dl = cx - rect.x + r;
    const dr = rect.x + rect.w - cx + r;
    const dt = cy - rect.y + r;
    const db = rect.y + rect.h - cy + r;
    const m = Math.min(dl, dr, dt, db);
    if (m === dl) return { x: -dl, y: 0 };
    if (m === dr) return { x: dr, y: 0 };
    if (m === dt) return { x: 0, y: -dt };
    return { x: 0, y: db };
  }
  const nx = Math.max(rect.x, Math.min(cx, rect.x + rect.w));
  const ny = Math.max(rect.y, Math.min(cy, rect.y + rect.h));
  const dx = cx - nx;
  const dy = cy - ny;
  const d2 = dx * dx + dy * dy;
  if (d2 >= r * r) return null;
  const d = Math.sqrt(d2);
  if (d < 1e-6) {
    // Exactly on the edge: push straight away from the rect centre.
    const ccx = rect.x + rect.w / 2;
    const ccy = rect.y + rect.h / 2;
    const ax = cx - ccx;
    const ay = cy - ccy;
    if (Math.abs(ax) / rect.w > Math.abs(ay) / rect.h) return { x: Math.sign(ax) * r, y: 0 };
    return { x: 0, y: Math.sign(ay) * r };
  }
  const push = r - d;
  return { x: (dx / d) * push, y: (dy / d) * push };
}

/**
 * Minimal translation for a circle against an oriented box centred at
 * (ox, oy) with the given rotation and half extents (along its own axes).
 */
export function circleObbPush(
  cx: number,
  cy: number,
  r: number,
  ox: number,
  oy: number,
  angle: number,
  halfL: number,
  halfW: number,
): Vec | null {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const dx = cx - ox;
  const dy = cy - oy;
  // Circle centre in box-local frame.
  const lx = dx * cos + dy * sin;
  const ly = -dx * sin + dy * cos;
  const push = circleRectPush(lx, ly, r, { x: -halfL, y: -halfW, w: halfL * 2, h: halfW * 2 });
  if (!push) return null;
  // Rotate the push back into world frame.
  return { x: push.x * cos - push.y * sin, y: push.x * sin + push.y * cos };
}

export function circleObbOverlap(
  cx: number,
  cy: number,
  r: number,
  ox: number,
  oy: number,
  angle: number,
  halfL: number,
  halfW: number,
): boolean {
  return circleObbPush(cx, cy, r, ox, oy, angle, halfL, halfW) !== null;
}
