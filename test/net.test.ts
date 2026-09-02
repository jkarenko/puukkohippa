import { describe, expect, it } from 'vitest';
import { decode, encode } from '../src/net/protocol.js';
import { Room } from '../src/net/room.js';
import { getArena } from '../src/sim/arena.js';
import { COUNTDOWN_TIME, TICK_RATE } from '../src/sim/constants.js';
import { predictLocalPlayer } from '../src/sim/sim.js';
import { EMPTY_INPUT, copyInput, type GameState, type PlayerInput } from '../src/sim/types.js';

function inp(partial: Partial<PlayerInput> = {}): PlayerInput {
  return { ...EMPTY_INPUT, ...partial };
}

/** Deep copy the way the wire does it (JSON, prevInput stripped and restored). */
function overWire(state: GameState): GameState {
  const s = decode<{ t: 'snapshot'; state: GameState }>(encode({ t: 'snapshot', state, acks: {} }))!.state;
  for (const p of s.players) p.prevInput = copyInput(EMPTY_INPUT);
  return s;
}

describe('Room input queue', () => {
  it('applies one queued input per tick and acknowledges its seq', () => {
    const room = new Room(1);
    const id = room.addPlayer('A', 1);
    room.addPlayer('B', 2);
    room.pushInput(id, 1, inp({ left: true }));
    room.pushInput(id, 2, inp({ left: true }));
    room.pushInput(id, 3, inp());
    expect(room.queued(id)).toBe(3);
    room.tick();
    expect(room.acks.get(id)).toBe(1);
    room.tick();
    room.tick();
    expect(room.acks.get(id)).toBe(3);
    expect(room.queued(id)).toBe(0);
    room.tick(); // queue empty: last input repeats, ack unchanged
    expect(room.acks.get(id)).toBe(3);
  });

  it('ignores stale or duplicate seqs and caps the buffer', () => {
    const room = new Room(1);
    const id = room.addPlayer('A', 1);
    room.pushInput(id, 5, inp());
    room.pushInput(id, 5, inp());
    room.pushInput(id, 4, inp());
    expect(room.queued(id)).toBe(1);
    for (let s = 6; s < 40; s++) room.pushInput(id, s, inp());
    expect(room.queued(id)).toBeLessThanOrEqual(8);
    room.tick();
    expect(room.acks.get(id)!).toBeGreaterThan(30);
  });

  it('strips prevInput from the wire', () => {
    const room = new Room(1);
    room.addPlayer('A', 1);
    const raw = encode({ t: 'snapshot', state: room.state, acks: room.ackRecord() });
    expect(raw).not.toContain('prevInput');
  });
});

describe('client prediction', () => {
  it('reproduces the server movement exactly for the same input sequence', () => {
    const room = new Room(99);
    const a = room.addPlayer('A', 1);
    const b = room.addPlayer('B', 2);
    // Get into the playing phase with an empty stream (last input repeats).
    for (let i = 0; i < COUNTDOWN_TIME * TICK_RATE + 5; i++) room.tick();
    expect(room.state.phase).toBe('playing');
    // Predict the runner: the knife holder's throw is server-only and changes their speed.
    const runner = room.state.players.find((p) => p.role === 'runner')!;
    const other = room.state.players.find((p) => p.role !== 'runner')!;
    const id = runner.id === a ? a : b;
    // Park the other player at the spawn farthest away so no touch happens.
    const spawns = getArena(room.state.seed).spawns;
    const far = spawns.reduce((best, s) =>
      Math.hypot(s.x - runner.x, s.y - runner.y) > Math.hypot(best.x - runner.x, best.y - runner.y) ? s : best,
    );
    other.x = far.x;
    other.y = far.y;

    // Snapshot as the client would receive it.
    const snapshot = overWire(room.state);
    const ack = room.acks.get(id)!;
    const predicted = { ...snapshot.players.find((p) => p.id === id)!, prevInput: copyInput(EMPTY_INPUT) };

    // A wiggly input sequence: turn, run, brake, charge (if holding the knife) etc.
    const seqInputs: PlayerInput[] = [];
    for (let k = 0; k < 90; k++) {
      seqInputs.push(
        inp({
          fwd: k < 60,
          left: k % 20 < 7,
          right: k % 20 > 14,
          back: k >= 70,
          throw: k >= 30 && k < 50,
        }),
      );
    }
    // Client sends one input per tick and predicts immediately; the server
    // consumes one per tick, a little later.
    seqInputs.forEach((input, i) => {
      room.pushInput(id, ack + 1 + i, input);
      predictLocalPlayer(snapshot, predicted, input);
      if (i >= 3) room.tick(); // server runs ~3 ticks behind the client
    });
    for (let i = 0; i < 3; i++) room.tick();

    const server = room.state.players.find((p) => p.id === id)!;
    expect(room.acks.get(id)).toBe(ack + seqInputs.length);
    // Interactions (touch, separation) are not predicted; keep B far away so none happen.
    expect(predicted.x).toBeCloseTo(server.x, 6);
    expect(predicted.y).toBeCloseTo(server.y, 6);
    expect(predicted.heading).toBeCloseTo(server.heading, 6);
    expect(predicted.moveSpeed).toBeCloseTo(server.moveSpeed, 6);
  });
});
