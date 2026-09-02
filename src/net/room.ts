import { addPlayer, createState, removePlayer, step } from '../sim/sim.js';
import { EMPTY_INPUT, copyInput, type GameEvent, type GameState, type PlayerInput } from '../sim/types.js';

/** Inputs buffered ahead of the simulation; beyond this the oldest are dropped. */
const MAX_QUEUE = 8;

interface QueuedInput {
  seq: number;
  input: PlayerInput;
}

/**
 * A room owns one authoritative simulation and the input stream of every
 * player in it. The server keeps one per room name; the browser keeps one
 * for offline couch play. Both drive it with `tick()` at the fixed tick rate.
 *
 * Inputs arrive either immediately (`setInput`, couch play) or as a
 * sequenced stream (`pushInput`, online play) where exactly one queued input
 * is consumed per tick so the client can replay the same sequence when it
 * predicts its own players. If the queue runs dry the last input repeats.
 */
export class Room {
  readonly state: GameState;
  /** Last input seq applied for each player, for client reconciliation. */
  readonly acks = new Map<number, number>();
  private readonly inputs = new Map<number, PlayerInput>();
  private readonly queues = new Map<number, QueuedInput[]>();

  constructor(seed: number) {
    this.state = createState(seed);
  }

  addPlayer(name: string, color: number): number {
    const p = addPlayer(this.state, name, color);
    this.inputs.set(p.id, copyInput(EMPTY_INPUT));
    this.queues.set(p.id, []);
    this.acks.set(p.id, 0);
    return p.id;
  }

  removePlayer(id: number): void {
    removePlayer(this.state, id);
    this.inputs.delete(id);
    this.queues.delete(id);
    this.acks.delete(id);
  }

  /** Apply an input immediately from the next tick on (no sequencing). */
  setInput(id: number, input: PlayerInput): void {
    if (!this.inputs.has(id)) return;
    this.inputs.set(id, copyInput(input));
  }

  /** Queue a sequenced input. Out-of-order or duplicate seqs are ignored. */
  pushInput(id: number, seq: number, input: PlayerInput): void {
    const q = this.queues.get(id);
    if (!q) return;
    const last = q.length ? q[q.length - 1]!.seq : (this.acks.get(id) ?? 0);
    if (seq <= last) return;
    q.push({ seq, input: copyInput(input) });
    if (q.length > MAX_QUEUE) q.splice(0, q.length - MAX_QUEUE);
  }

  /** Number of inputs buffered for a player (diagnostics). */
  queued(id: number): number {
    return this.queues.get(id)?.length ?? 0;
  }

  tick(): void {
    for (const [id, q] of this.queues) {
      const next = q.shift();
      if (next) {
        this.inputs.set(id, next.input);
        this.acks.set(id, next.seq);
      }
    }
    step(this.state, this.inputs);
  }

  /** Returns and clears the events accumulated since the last flush. */
  flushEvents(): GameEvent[] {
    const ev = this.state.events;
    this.state.events = [];
    return ev;
  }

  ackRecord(): Record<string, number> {
    const r: Record<string, number> = {};
    for (const [id, seq] of this.acks) r[id] = seq;
    return r;
  }

  get playerCount(): number {
    return this.state.players.length;
  }
}
