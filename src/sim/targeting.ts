import { wrapAngle } from './geom.js';
import type { Dir, PlayerState } from './types.js';

const DIR_OFFSET: Record<Dir, number> = {
  fwd: 0,
  right: Math.PI / 2,
  back: Math.PI,
  left: -Math.PI / 2,
};

/**
 * Pick the pass target for a direction relative to the thrower's heading.
 * The direction defines a 90 degree sector. The nearest candidate inside the
 * sector wins; if the sector is empty, the candidate angularly closest to the
 * sector wins (ties broken by distance).
 */
export function pickPassTarget(
  from: PlayerState,
  candidates: readonly PlayerState[],
  dir: Dir,
): PlayerState | null {
  const centre = from.heading + DIR_OFFSET[dir];
  let bestIn: PlayerState | null = null;
  let bestInDist = Infinity;
  let bestOut: PlayerState | null = null;
  let bestOutAng = Infinity;
  let bestOutDist = Infinity;
  for (const c of candidates) {
    if (c.id === from.id) continue;
    const dx = c.x - from.x;
    const dy = c.y - from.y;
    const d = Math.hypot(dx, dy);
    const ang = Math.abs(wrapAngle(Math.atan2(dy, dx) - centre));
    if (ang <= Math.PI / 4) {
      if (d < bestInDist) {
        bestInDist = d;
        bestIn = c;
      }
    } else {
      const angOut = ang - Math.PI / 4;
      if (angOut < bestOutAng - 1e-9 || (Math.abs(angOut - bestOutAng) <= 1e-9 && d < bestOutDist)) {
        bestOutAng = angOut;
        bestOutDist = d;
        bestOut = c;
      }
    }
  }
  return bestIn ?? bestOut;
}
