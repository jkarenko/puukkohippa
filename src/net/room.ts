import { addPlayer, createState, dropKnife, findPlayer, removePlayer, step } from '../sim/sim.js';
import { EMPTY_INPUT, copyInput, type GameEvent, type GameState, type PlayerInput, type Vec } from '../sim/types.js';

/**
 * Inputs buffered ahead of the simulation (2 s); beyond this the oldest are
 * dropped. The client's clock control keeps the depth near a small
 * jitter-derived target; the room only needs headroom for stall bursts.
 */
export const MAX_QUEUE = 120;
/** Backlog above which the room applies several inputs per tick to catch up. */
export const CATCHUP_THRESHOLD = 12;
/** Inputs applied per tick while catching up (3x time compression). */
export const CATCHUP_PER_TICK = 3;
/** Position history kept for lag compensation, in ticks. */
const HISTORY_TICKS = 64;
/** Never rewind a target further back than this (500 ms). */
export const MAX_REWIND_TICKS = 30;

interface QueuedInput {
  seq: number;
  input: PlayerInput;
  /** Server tick the sender's remote view was rendered at, if reported. */
  view: number | null;
}

interface HistoryEntry {
  tick: number;
  pos: Map<number, Vec>;
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
  /** Which session owns each player; players of one session are never rewound against each other. */
  readonly owners = new Map<number, string>();
  private readonly inputs = new Map<number, PlayerInput>();
  private readonly queues = new Map<number, QueuedInput[]>();
  /** Latest reported view tick per player, updated when their input is applied. */
  private readonly views = new Map<number, number>();
  private readonly history: Array<HistoryEntry | undefined> = new Array(HISTORY_TICKS);
  /** Players driven by the sequenced input stream (online); they freeze when it runs dry. */
  private readonly streaming = new Set<number>();
  /** Diagnostics: ticks in which a streaming player had no input, and inputs applied in catch-up. */
  readonly stats = { starvedTicks: 0, catchupInputs: 0 };
  /** Lag compensation hook handed to the sim; see `rewind`. */
  private readonly rewindHook = (viewer: number, target: number): Vec | null => this.rewind(viewer, target);

  constructor(seed: number) {
    this.state = createState(seed);
  }

  addPlayer(name: string, color: number, owner = ''): number {
    const p = addPlayer(this.state, name, color);
    this.inputs.set(p.id, copyInput(EMPTY_INPUT));
    this.queues.set(p.id, []);
    this.acks.set(p.id, 0);
    if (owner) this.owners.set(p.id, owner);
    return p.id;
  }

  removePlayer(id: number): void {
    removePlayer(this.state, id);
    this.inputs.delete(id);
    this.queues.delete(id);
    this.acks.delete(id);
    this.owners.delete(id);
    this.views.delete(id);
    this.streaming.delete(id);
  }

  /**
   * Where `viewer` saw `target` when their latest applied input was made:
   * the target's position `tick - view` ticks ago, capped at MAX_REWIND_TICKS.
   * Null when there is nothing to compensate (same session, no view, no history).
   */
  rewind(viewer: number, target: number): Vec | null {
    const view = this.views.get(viewer);
    if (view === undefined) return null;
    const ov = this.owners.get(viewer);
    if (ov === undefined || ov === this.owners.get(target)) return null;
    const delay = Math.min(MAX_REWIND_TICKS, this.state.tick - view);
    if (delay <= 0) return null;
    const at = this.state.tick - delay;
    const entry = this.history[at % HISTORY_TICKS];
    if (!entry || entry.tick !== at) return null;
    return entry.pos.get(target) ?? null;
  }

  /**
   * Mark a player's connection state. A disconnected player stands still,
   * drops the knife, and is drawn dimmed until removed or reconnected.
   */
  setConnected(id: number, connected: boolean): void {
    const p = findPlayer(this.state, id);
    if (!p) return;
    p.connected = connected;
    if (!connected) {
      this.inputs.set(id, copyInput(EMPTY_INPUT));
      this.queues.set(id, []);
      dropKnife(this.state, id);
    }
  }

  /** Apply an input immediately from the next tick on (no sequencing). */
  setInput(id: number, input: PlayerInput): void {
    if (!this.inputs.has(id) || !findPlayer(this.state, id)?.connected) return;
    this.inputs.set(id, copyInput(input));
  }

  /** Queue a sequenced input. Out-of-order or duplicate seqs are ignored. */
  pushInput(id: number, seq: number, input: PlayerInput, view: number | null = null): void {
    const q = this.queues.get(id);
    if (!q || !findPlayer(this.state, id)?.connected) return;
    const last = q.length ? q[q.length - 1]!.seq : (this.acks.get(id) ?? 0);
    if (seq <= last) return;
    this.streaming.add(id);
    q.push({ seq, input: copyInput(input), view });
    if (q.length > MAX_QUEUE) q.splice(0, q.length - MAX_QUEUE);
  }

  /** Number of inputs buffered for a player (diagnostics). */
  queued(id: number): number {
    return this.queues.get(id)?.length ?? 0;
  }

  tick(): void {
    // The server never invents input: a streaming player whose queue is empty
    // is frozen for the tick, and a backlog (inputs that arrived in a burst
    // after a stall) is worked off several per tick. Either way the player's
    // path is exactly the sequence the client predicted, only shifted in time.
    const sequences = new Map<number, PlayerInput[]>();
    for (const [id, q] of this.queues) {
      if (!this.streaming.has(id)) continue;
      const n = q.length > CATCHUP_THRESHOLD ? Math.min(CATCHUP_PER_TICK, q.length) : Math.min(1, q.length);
      const batch: PlayerInput[] = [];
      for (let i = 0; i < n; i++) {
        const next = q.shift()!;
        batch.push(next.input);
        this.inputs.set(id, next.input);
        this.acks.set(id, next.seq);
        if (next.view !== null) this.views.set(id, next.view);
      }
      if (n === 0) this.stats.starvedTicks++;
      else if (n > 1) this.stats.catchupInputs += n - 1;
      sequences.set(id, batch);
    }
    step(this.state, this.inputs, { rewind: this.rewindHook, sequences });
    const pos = new Map<number, Vec>();
    for (const p of this.state.players) pos.set(p.id, { x: p.x, y: p.y });
    this.history[this.state.tick % HISTORY_TICKS] = { tick: this.state.tick, pos };
  }

  /** Returns and clears the events accumulated since the last flush. */
  flushEvents(): GameEvent[] {
    const ev = this.state.events;
    this.state.events = [];
    return ev;
  }

  bufRecord(): Record<string, number> {
    const r: Record<string, number> = {};
    for (const [id, q] of this.queues) r[id] = q.length;
    return r;
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
