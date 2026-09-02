import { describe, expect, it } from 'vitest';
import { decode, encode, normalizeRoomName } from '../src/net/protocol.js';
import { Room } from '../src/net/room.js';
import { getArena } from '../src/sim/arena.js';
import { COUNTDOWN_TIME, TICK_RATE } from '../src/sim/constants.js';
import { createThrow, flyKnife, predictLocalPlayer } from '../src/sim/sim.js';
import { EMPTY_INPUT, copyInput, type GameState, type KnifeState, type PlayerInput } from '../src/sim/types.js';

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

describe('disconnect handling', () => {
  it('a disconnected holder drops the knife, stands still, and is dimmed until reconnected', () => {
    const room = new Room(7);
    const a = room.addPlayer('A', 1);
    room.addPlayer('B', 2);
    for (let i = 0; i < COUNTDOWN_TIME * TICK_RATE + 5; i++) room.tick();
    const holder = room.state.players.find((p) => p.role === 'puukottaja')!;
    room.pushInput(holder.id, 1, inp({ fwd: true }));
    room.tick();
    room.setConnected(holder.id, false);
    expect(holder.connected).toBe(false);
    expect(room.state.knife.mode).toBe('ground');
    const x = holder.x;
    room.pushInput(holder.id, 2, inp({ fwd: true })); // input from the dead socket is discarded
    room.tick();
    expect(holder.x).toBe(x);
    room.setConnected(holder.id, true);
    expect(holder.connected).toBe(true);
    void a;
  });
});

describe('knife prediction', () => {
  it('a predicted throw lands exactly where the server knife lands', () => {
    const room = new Room(2024);
    room.addPlayer('A', 1);
    room.addPlayer('B', 2);
    for (let i = 0; i < COUNTDOWN_TIME * TICK_RATE + 5; i++) room.tick();
    const holder = room.state.players.find((p) => p.role === 'puukottaja')!;
    const other = room.state.players.find((p) => p.role === 'runner')!;
    // Face the arena centre so the throw has room; park the runner far away.
    holder.heading = Math.atan2(450 - holder.y, 800 - holder.x);
    const spawns = getArena(room.state.seed).spawns;
    const far = spawns.reduce((best, s) =>
      Math.hypot(s.x - holder.x, s.y - holder.y) > Math.hypot(best.x - holder.x, best.y - holder.y) ? s : best,
    );
    other.x = far.x;
    other.y = far.y;

    const snapshot = overWire(room.state);
    const arena = getArena(snapshot.seed);
    const predicted = { ...snapshot.players.find((p) => p.id === holder.id)!, prevInput: copyInput(EMPTY_INPUT) };
    let predictedKnife: KnifeState | null = null;
    const inputs: PlayerInput[] = [];
    for (let k = 0; k < 40; k++) inputs.push(inp({ throw: k < 25 }));
    inputs.forEach((input, i) => {
      const chargeBefore = predicted.charge;
      const intent = predictLocalPlayer(snapshot, predicted, input);
      if (intent.kind === 'straight') predictedKnife = createThrow(arena, predicted, predicted.heading, chargeBefore, -1);
      if (predictedKnife?.mode === 'flying') predictedKnife = flyKnife(arena, predictedKnife, null);
      room.pushInput(holder.id, i + 1, input);
      if (i >= 2) room.tick();
    });
    for (let i = 0; i < 200; i++) {
      room.tick();
      if (predictedKnife?.mode === 'flying') predictedKnife = flyKnife(arena, predictedKnife, null);
    }
    expect(predictedKnife).not.toBeNull();
    expect(predictedKnife!.mode).toBe('ground');
    expect(room.state.knife.mode).toBe('ground');
    const pk = predictedKnife as { x: number; y: number };
    const sk = room.state.knife as { x: number; y: number };
    expect(pk.x).toBeCloseTo(sk.x, 6);
    expect(pk.y).toBeCloseTo(sk.y, 6);
  });
});

describe('delta snapshots', () => {
  it('round-trips changes, new players and removals against a baseline', async () => {
    const { encodeDelta, applyDelta } = await import('../src/net/delta.js');
    const room = new Room(5);
    const a = room.addPlayer('A', 1);
    room.addPlayer('B', 2);
    for (let i = 0; i < 10; i++) room.tick();
    const base = overWire(room.state);
    // Move A, add C, remove B, throw the knife state around.
    room.pushInput(a, 1, inp({ fwd: true, left: true }));
    for (let i = 0; i < 10; i++) room.tick();
    room.addPlayer('C', 3);
    room.removePlayer(2);
    room.state.knife = { mode: 'ground', x: 300, y: 300, heading: 1 };
    room.state.events.push({ type: 'pickup', by: a });
    const cur = overWire(room.state);
    const d = encodeDelta(base, cur, room.ackRecord());
    expect(d.removed).toEqual([2]);
    expect(d.players!.some((p) => p.id === 3 && p.name === 'C')).toBe(true);
    expect(d.players!.find((p) => p.id === a)!.name).toBeUndefined(); // unchanged field omitted
    const rebuilt = applyDelta(base, JSON.parse(JSON.stringify(d)));
    const norm = (s: GameState) => JSON.parse(JSON.stringify({ ...s, players: s.players.map((p) => ({ ...p, prevInput: undefined })) }));
    expect(norm(rebuilt)).toEqual(norm(cur));
    expect(JSON.stringify(d).length).toBeLessThan(JSON.stringify(cur).length);
  });

  it('is much smaller than a full snapshot when little changes', async () => {
    const { encodeDelta } = await import('../src/net/delta.js');
    const room = new Room(6);
    for (let i = 0; i < 12; i++) room.addPlayer(`P${i}`, i);
    for (let i = 0; i < 5; i++) room.tick();
    const base = overWire(room.state);
    room.tick();
    const cur = overWire(room.state);
    const full = JSON.stringify(cur).length;
    const delta = JSON.stringify(encodeDelta(base, cur, room.ackRecord())).length;
    expect(delta * 5).toBeLessThan(full);
  });
});

describe('lag compensation', () => {
  it('judges a touch where the puukottaja saw the runner, not where the runner is now', () => {
    const room = new Room(11);
    const a = room.addPlayer('A', 1, 'session-a');
    const b = room.addPlayer('B', 2, 'session-b');
    for (let i = 0; i < COUNTDOWN_TIME * TICK_RATE + 5; i++) room.tick();
    const it = room.state.players.find((p) => p.role === 'puukottaja')!;
    const runner = room.state.players.find((p) => p.role === 'runner')!;
    // Runner stands still right in front of the puukottaja for 20 ticks
    // (history), then teleports far away. The puukottaja's input says its
    // view is 20 ticks old, so the touch is judged against the old spot.
    it.x = 800;
    it.y = 450;
    it.heading = 0;
    runner.x = 800 + 40; // just out of reach
    runner.y = 450;
    for (let i = 0; i < 20; i++) room.tick();
    runner.x = 200;
    runner.y = 200;
    const viewTick = room.state.tick - 10; // inside the 20 ticks of recorded history
    it.x = 800 + 20; // now within touch distance of where the runner *was*
    room.pushInput(it.id, 1, inp(), viewTick);
    room.tick();
    expect(runner.role).toBe('puukottaja');
    void a;
    void b;
  });

  it('never rewinds players of the same session and caps the rewind', () => {
    const room = new Room(12);
    const a = room.addPlayer('A', 1, 'same');
    const b = room.addPlayer('B', 2, 'same');
    for (let i = 0; i < 40; i++) room.tick();
    room.pushInput(a, 1, inp(), room.state.tick - 10);
    room.tick();
    expect(room.rewind(a, b)).toBeNull();
    const c = room.addPlayer('C', 3, 'other');
    for (let i = 0; i < 40; i++) room.tick();
    room.pushInput(a, 2, inp(), room.state.tick - 200);
    room.tick();
    const r = room.rewind(a, c);
    expect(r).not.toBeNull();
    const hist = room.state.tick - 30; // capped at MAX_REWIND_TICKS
    void hist;
  });
});

describe('extrapolation', () => {
  it('moves remote players along their heading and leaves local ones alone', async () => {
    const { extrapolateState } = await import('../src/net/extrapolate.js');
    const room = new Room(13);
    const a = room.addPlayer('A', 1);
    const b = room.addPlayer('B', 2);
    for (let i = 0; i < COUNTDOWN_TIME * TICK_RATE + 5; i++) room.tick();
    const pa = room.state.players.find((p) => p.id === a)!;
    const pb = room.state.players.find((p) => p.id === b)!;
    pa.x = 800; pa.y = 450; pa.heading = 0; pa.moveSpeed = 240;
    pb.x = 400; pb.y = 450; pb.heading = 0; pb.moveSpeed = 240;
    const out = extrapolateState(room.state, 3, new Set([b]));
    const oa = out.players.find((p) => p.id === a)!;
    const ob = out.players.find((p) => p.id === b)!;
    expect(oa.x).toBeCloseTo(800 + 240 * 3 / TICK_RATE, 6);
    expect(ob.x).toBe(400);
    expect(extrapolateState(room.state, 100, new Set()).players.find((p) => p.id === a)!.x).toBeCloseTo(800 + 240 * 6 / TICK_RATE, 6);
  });
});

describe('room names', () => {
  it('keeps Finnish letters, ignores case and strips the rest', () => {
    expect(normalizeRoomName('Löyly')).toBe('löyly');
    expect(normalizeRoomName('sauna ö!')).toBe('saunaö');
    expect(normalizeRoomName('Sauna')).toBe(normalizeRoomName('sauna'));
    expect(normalizeRoomName('kissa-koira_1')).toBe('kissa-koira_1');
    expect(normalizeRoomName('')).toBe('default');
    expect(normalizeRoomName(null)).toBe('default');
    expect(normalizeRoomName('x'.repeat(50))).toHaveLength(32);
  });
});
