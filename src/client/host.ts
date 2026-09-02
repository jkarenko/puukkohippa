import { PROTOCOL_VERSION, decode, encode, type ClientMsg, type ServerMsg } from '../net/protocol.js';
import { Room } from '../net/room.js';
import { TICK_RATE } from '../sim/constants.js';
import { lerp, lerpAngle } from '../sim/geom.js';
import { predictLocalPlayer } from '../sim/sim.js';
import {
  EMPTY_INPUT,
  copyInput,
  type GameEvent,
  type GameState,
  type PlayerInput,
  type PlayerState,
} from '../sim/types.js';

export interface Frame {
  state: GameState | null;
  events: GameEvent[];
}

export interface NetStats {
  rttMs: number;
  /** Inputs sent but not yet acknowledged by a snapshot (per local player, max). */
  unacked: number;
  /** Distance of the last reconciliation correction, px. */
  lastCorrection: number;
}

/**
 * Where the authoritative simulation lives. The scene only talks to this
 * interface, so couch play (LocalHost) and online play (NetHost) render and
 * control identically. A single client may own several players (one per
 * local control slot) on either host.
 */
export interface Host {
  readonly kind: 'local' | 'net';
  readonly status: string;
  /** Called when a slot's player has been created and has an id. */
  onJoined: ((slot: string, id: number) => void) | null;
  join(slot: string, name: string, color: number): void;
  leave(id: number): void;
  setInput(id: number, input: PlayerInput): void;
  /** Advance / flush; call once per rendered frame. */
  update(nowMs: number): void;
  /** State to render for this frame plus events since the previous frame. */
  frame(nowMs: number): Frame;
  stats(): NetStats | null;
  destroy(): void;
}

const TICK_MS = 1000 / TICK_RATE;

// ---------------------------------------------------------------- local

export class LocalHost implements Host {
  readonly kind = 'local' as const;
  readonly status = 'offline couch mode';
  onJoined: Host['onJoined'] = null;
  private readonly room: Room;
  private acc = 0;
  private last = -1;

  constructor(seed: number) {
    this.room = new Room(seed);
  }

  join(slot: string, name: string, color: number): void {
    const id = this.room.addPlayer(name, color);
    this.onJoined?.(slot, id);
  }

  leave(id: number): void {
    this.room.removePlayer(id);
  }

  setInput(id: number, input: PlayerInput): void {
    this.room.setInput(id, input);
  }

  update(nowMs: number): void {
    if (this.last < 0) this.last = nowMs;
    this.acc += Math.min(250, nowMs - this.last);
    this.last = nowMs;
    while (this.acc >= TICK_MS) {
      this.acc -= TICK_MS;
      this.room.tick();
    }
  }

  frame(): Frame {
    return { state: this.room.state, events: this.room.flushEvents() };
  }

  stats(): null {
    return null;
  }

  destroy(): void {}
}

// ------------------------------------------------------------------ net

interface Snapshot {
  state: GameState;
  tick: number;
  /** Local receipt time in ms. */
  at: number;
}

interface LocalPlayer {
  /** Latest sampled input from the controls. */
  cur: PlayerInput;
  /** Inputs sent but not yet acknowledged, oldest first. */
  pending: Array<{ seq: number; input: PlayerInput }>;
  /** Input of the last acknowledged seq, needed for edge detection when replaying. */
  lastAcked: PlayerInput;
  /** Predicted state: last snapshot + replayed pending inputs + inputs since. */
  predicted: PlayerState | null;
  /** Visual error left over from the last correction, decays towards zero. */
  errX: number;
  errY: number;
  errHeading: number;
}

/** Render remote players this many ticks behind the estimated server tick. */
const INTERP_DELAY_TICKS = 7; // ~117 ms: two snapshot intervals plus jitter margin
/** How fast reconciliation errors are smoothed out (fraction per second). */
const ERROR_DECAY_PER_S = 18;
/** Corrections larger than this snap instead of smoothing. */
const SNAP_DISTANCE = 120;

export class NetHost implements Host {
  readonly kind = 'net' as const;
  status = 'connecting';
  onJoined: Host['onJoined'] = null;

  private ws: WebSocket | null = null;
  private readonly snapshots: Snapshot[] = [];
  private pendingEvents: GameEvent[] = [];
  private readonly slots = new Map<string, { name: string; color: number; id: number | null }>();
  private readonly local = new Map<number, LocalPlayer>();
  private clientTick = 0;
  private acc = 0;
  private last = -1;
  private lastFrameAt = -1;
  /** Estimated `localTime - serverTick * TICK_MS`, smoothed. */
  private tickOffset: number | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private lastPingAt = 0;
  private closed = false;
  private readonly netStats: NetStats = { rttMs: 0, unacked: 0, lastCorrection: 0 };

  constructor(
    private readonly url: string,
    private readonly room: string,
  ) {
    this.connect();
  }

  private connect(): void {
    if (this.closed) return;
    this.status = `connecting to ${this.room}`;
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => {
      this.send({ t: 'hello', room: this.room, v: PROTOCOL_VERSION });
      // Re-register every slot we already had (reconnect case).
      for (const [slot, s] of this.slots) {
        s.id = null;
        this.send({ t: 'join', slot, name: s.name, color: s.color });
      }
      this.local.clear();
      this.tickOffset = null;
    };
    ws.onmessage = (ev) => {
      const msg = decode<ServerMsg>(String(ev.data));
      if (msg) this.handle(msg);
    };
    ws.onclose = () => {
      this.status = 'disconnected, retrying…';
      this.snapshots.length = 0;
      if (!this.closed) this.reconnectTimer = setTimeout(() => this.connect(), 1500);
    };
    ws.onerror = () => {
      /* onclose follows */
    };
  }

  private send(msg: ClientMsg): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(encode(msg));
  }

  private handle(msg: ServerMsg): void {
    switch (msg.t) {
      case 'welcome':
        this.status = `online · room "${msg.room}"`;
        break;
      case 'joined': {
        const s = this.slots.get(msg.slot);
        if (s) s.id = msg.id;
        this.local.set(msg.id, {
          cur: copyInput(EMPTY_INPUT),
          pending: [],
          lastAcked: copyInput(EMPTY_INPUT),
          predicted: null,
          errX: 0,
          errY: 0,
          errHeading: 0,
        });
        this.onJoined?.(msg.slot, msg.id);
        break;
      }
      case 'snapshot':
        this.onSnapshot(msg.state, msg.acks);
        break;
      case 'pong':
        this.netStats.rttMs = performance.now() - msg.sent;
        break;
      case 'error':
        this.status = `server: ${msg.message}`;
        break;
    }
  }

  private onSnapshot(state: GameState, acks: Record<string, number>): void {
    const at = performance.now();
    // The wire strips prevInput; give every player a valid one.
    for (const p of state.players) p.prevInput = copyInput(EMPTY_INPUT);
    this.pendingEvents.push(...state.events);
    state.events = [];
    this.snapshots.push({ state, tick: state.tick, at });
    while (this.snapshots.length > 16) this.snapshots.shift();

    // Server tick timeline: local time at which server tick 0 "happened".
    const off = at - state.tick * TICK_MS;
    this.tickOffset = this.tickOffset === null ? off : this.tickOffset + (off - this.tickOffset) * 0.1;

    this.reconcile(state, acks);
  }

  /** Rebuild each local player's prediction from the authoritative snapshot. */
  private reconcile(state: GameState, acks: Record<string, number>): void {
    let maxUnacked = 0;
    for (const [id, lp] of this.local) {
      const authoritative = state.players.find((p) => p.id === id);
      if (!authoritative) {
        lp.predicted = null;
        continue;
      }
      const ack = acks[String(id)] ?? 0;
      while (lp.pending.length && lp.pending[0]!.seq <= ack) {
        lp.lastAcked = lp.pending.shift()!.input;
      }
      maxUnacked = Math.max(maxUnacked, lp.pending.length);

      const before = lp.predicted;
      const next: PlayerState = { ...authoritative, prevInput: copyInput(lp.lastAcked) };
      for (const { input } of lp.pending) predictLocalPlayer(state, next, input);

      if (before) {
        // Carry the visual difference so the correction is smoothed, not popped.
        const dx = before.x + lp.errX - next.x;
        const dy = before.y + lp.errY - next.y;
        const dist = Math.hypot(dx, dy);
        this.netStats.lastCorrection = Math.hypot(before.x - next.x, before.y - next.y);
        if (dist > SNAP_DISTANCE || before.role !== next.role) {
          lp.errX = lp.errY = lp.errHeading = 0;
        } else {
          lp.errX = dx;
          lp.errY = dy;
          lp.errHeading = wrap(before.heading + lp.errHeading - next.heading);
        }
      }
      lp.predicted = next;
    }
    this.netStats.unacked = maxUnacked;
  }

  join(slot: string, name: string, color: number): void {
    if (this.slots.has(slot)) return;
    this.slots.set(slot, { name, color, id: null });
    this.send({ t: 'join', slot, name, color });
  }

  leave(id: number): void {
    for (const [slot, s] of this.slots) if (s.id === id) this.slots.delete(slot);
    this.local.delete(id);
    this.send({ t: 'leave', id });
  }

  setInput(id: number, input: PlayerInput): void {
    const lp = this.local.get(id);
    if (lp) lp.cur = copyInput(input);
  }

  update(nowMs: number): void {
    if (this.last < 0) this.last = nowMs;
    this.acc += Math.min(250, nowMs - this.last);
    this.last = nowMs;
    const latest = this.snapshots[this.snapshots.length - 1]?.state ?? null;
    while (this.acc >= TICK_MS) {
      this.acc -= TICK_MS;
      this.clientTick++;
      if (this.local.size === 0) continue;
      const batch: Array<{ id: number; input: PlayerInput }> = [];
      for (const [id, lp] of this.local) {
        const input = copyInput(lp.cur);
        lp.pending.push({ seq: this.clientTick, input });
        if (lp.pending.length > 120) lp.pending.shift(); // 2 s without acks: stop growing
        batch.push({ id, input });
        if (lp.predicted && latest) predictLocalPlayer(latest, lp.predicted, input);
      }
      this.send({ t: 'input', seq: this.clientTick, inputs: batch });
    }
    if (nowMs - this.lastPingAt > 2000) {
      this.lastPingAt = nowMs;
      this.send({ t: 'ping', sent: performance.now() });
    }
  }

  frame(nowMs: number): Frame {
    const events = this.pendingEvents;
    this.pendingEvents = [];
    const dt = this.lastFrameAt < 0 ? 0 : Math.min(0.1, (nowMs - this.lastFrameAt) / 1000);
    this.lastFrameAt = nowMs;

    const base = this.interpolated();
    if (!base) return { state: null, events };

    // Local players come from prediction, everyone else from interpolation.
    const decay = Math.exp(-ERROR_DECAY_PER_S * dt);
    const players = base.players.map((p) => {
      const lp = this.local.get(p.id);
      if (!lp?.predicted) return p;
      lp.errX *= decay;
      lp.errY *= decay;
      lp.errHeading *= decay;
      return { ...lp.predicted, x: lp.predicted.x + lp.errX, y: lp.predicted.y + lp.errY, heading: lp.predicted.heading + lp.errHeading };
    });
    return { state: { ...base, players }, events };
  }

  /** Remote view of the world at the render tick, interpolated by server tick. */
  private interpolated(): GameState | null {
    const n = this.snapshots.length;
    if (n === 0 || this.tickOffset === null) return null;
    const newest = this.snapshots[n - 1]!;
    if (n === 1) return newest.state;
    const renderTick = (performance.now() - this.tickOffset) / TICK_MS - INTERP_DELAY_TICKS;
    if (renderTick >= newest.tick) return newest.state;
    const oldest = this.snapshots[0]!;
    if (renderTick <= oldest.tick) return oldest.state;
    for (let i = 0; i < n - 1; i++) {
      const a = this.snapshots[i]!;
      const b = this.snapshots[i + 1]!;
      if (a.tick <= renderTick && renderTick <= b.tick) {
        const t = (renderTick - a.tick) / (b.tick - a.tick);
        return interpolate(a.state, b.state, t);
      }
    }
    return newest.state;
  }

  stats(): NetStats {
    return this.netStats;
  }

  destroy(): void {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
  }
}

function wrap(a: number): number {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

function interpolate(a: GameState, b: GameState, t: number): GameState {
  const byId = new Map(a.players.map((p) => [p.id, p]));
  const players = b.players.map((pb) => {
    const pa = byId.get(pb.id);
    if (!pa || pa.role !== pb.role) return pb;
    return { ...pb, x: lerp(pa.x, pb.x, t), y: lerp(pa.y, pb.y, t), heading: lerpAngle(pa.heading, pb.heading, t) };
  });
  let knife = b.knife;
  if (a.knife.mode === 'flying' && b.knife.mode === 'flying') {
    knife = { ...b.knife, x: lerp(a.knife.x, b.knife.x, t), y: lerp(a.knife.y, b.knife.y, t) };
  }
  return { ...b, players, knife };
}
