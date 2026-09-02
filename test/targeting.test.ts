import { describe, expect, it } from 'vitest';
import { pickPassTarget } from '../src/sim/targeting.js';
import { EMPTY_INPUT, copyInput, type PlayerState } from '../src/sim/types.js';

function p(id: number, x: number, y: number, heading = 0): PlayerState {
  return {
    id,
    name: `p${id}`,
    color: 0,
    x,
    y,
    heading,
    role: 'puukottaja',
    moveSpeed: 0,
    charge: -1,
    caughtTick: -1,
    catches: 0,
    wins: 0,
    prevInput: copyInput(EMPTY_INPUT),
  };
}

describe('pickPassTarget', () => {
  const me = p(1, 0, 0, 0); // facing +x

  it('picks the nearest candidate inside the forward sector', () => {
    const far = p(2, 300, 10);
    const near = p(3, 100, -20);
    expect(pickPassTarget(me, [far, near], 'fwd')?.id).toBe(3);
  });

  it('uses heading-relative sectors', () => {
    const right = p(2, 0, 100); // +y is "right" of +x heading (screen coords)
    const left = p(3, 0, -100);
    const back = p(4, -100, 0);
    expect(pickPassTarget(me, [right, left, back], 'right')?.id).toBe(2);
    expect(pickPassTarget(me, [right, left, back], 'left')?.id).toBe(3);
    expect(pickPassTarget(me, [right, left, back], 'back')?.id).toBe(4);
  });

  it('rotates sectors with the thrower heading', () => {
    const up = p(1, 0, 0, -Math.PI / 2); // facing -y
    const ahead = p(2, 0, -100);
    const behind = p(3, 0, 100);
    expect(pickPassTarget(up, [ahead, behind], 'fwd')?.id).toBe(2);
    expect(pickPassTarget(up, [ahead, behind], 'back')?.id).toBe(3);
  });

  it('falls back to the candidate angularly closest to an empty sector', () => {
    const a = p(2, -100, 90); // roughly back-right, ~138 deg
    const b = p(3, -100, -10); // almost straight back
    // Nothing is in the forward sector; a is closer to it than b.
    expect(pickPassTarget(me, [a, b], 'fwd')?.id).toBe(2);
  });

  it('ignores itself and returns null with no candidates', () => {
    expect(pickPassTarget(me, [me], 'fwd')).toBeNull();
    expect(pickPassTarget(me, [], 'left')).toBeNull();
  });
});
