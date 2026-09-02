import { applyDelta, type DeltaMsg } from '../net/delta.js';
import { extrapolateState } from '../net/extrapolate.js';
import { PROTOCOL_VERSION, decode, encode, type ClientMsg, type ServerMsg } from '../net/protocol.js';
import { Room } from '../net/room.js';
import { TICK_RATE } from '../sim/constants.js';
import { lerp, lerpAngle } from '../sim/geom.js';
import { getArena } from '../sim/arena.js';
import { createThrow, flyKnife, predictLocalPlayer, touchesGroundKnife } from '../sim/sim.js';
import {
  EMPTY_INPUT,
  copyInput,
  type FlyingKnife,
  type GameEvent,
  type GameState,
  type KnifeState,
  type PlayerInput,
  type PlayerState,
} from '../sim/types.js';

export interface Frame {
  state: GameState | null;
  events: GameEvent[];
}

export interface NetStats {
  rttMs: number;
  /** Deltas that referenced a baseline we no longer had (should stay 0). */
  deltaMisses: number;
  /** Ticks the remote view is currently extrapolated ahead of the newest snapshot. */
  extrapolated: number;
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

/**
 * The client's belief about the knife while the server has not confirmed a
 * local throw or pickup yet. Deterministic flight means a predicted throw
 * lands exactly where the server's will.
 */
interface KnifePrediction {
  knife: KnifeState;
  kind: 'throw' | 'pickup';
  /** Player the prediction belongs to (thrower or picker). */
  by: number;
  sinceTick: number;
}

/** Give up on a knife prediction the server never confirmed after this many client ticks. */
const KNIFE_PREDICTION_TIMEOUT_TICKS = 90;

const SESSION_KEY = 'puukkohippa-session';

/** Stable per-tab id so a reconnect resumes the same players. */
function sessionId(): string {
  try {
    let id = sessionStorage.getItem(SESSION_KEY);
    if (!id) {
      id = crypto.randomUUID();
      sessionStorage.setItem(SESSION_KEY, id);
    }
    return id;
  } catch {
    return crypto.randomUUID();
  }
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
  private readonly session = sessionId();
  private knifePred: KnifePrediction | null = null;
  private clientTick = 0;
  private acc = 0;
  private last = -1;
  private lastFrameAt = -1;
  /** Estimated `localTime - serverTick * TICK_MS`, smoothed. */
  private tickOffset: number | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private lastPingAt = 0;
  private closed = false;
  private readonly netStats: NetStats = { rttMs: 0, deltaMisses: 0, extrapolated: 0, unacked: 0, lastCorrection: 0 };

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
      this.send({ t: 'hello', room: this.room, v: PROTOCOL_VERSION, session: this.session });
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
    ws.onclose = (ev) => {
      this.snapshots.length = 0;
      this.knifePred = null;
      if (ev.code === 4000) {
        // Another tab with the same session took over; do not fight it.
        this.status = 'this session is open in another tab';
        return;
      }
      this.status = 'disconnected, retrying…';
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
        if (this.local.has(msg.id)) break; // reconnect re-announcing an existing player
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
        this.send({ t: 'ack', tick: msg.state.tick });
        break;
      case 'delta':
        this.onDelta(msg);
        break;
      case 'pong':
        this.netStats.rttMs = performance.now() - msg.sent;
        break;
      case 'error':
        this.status = `server: ${msg.message}`;
        break;
    }
  }

  private onDelta(d: DeltaMsg): void {
    const base = this.snapshots.find((s) => s.tick === d.base);
    if (!base) {
      // We no longer have the baseline; keep acking what we have so the
      // server falls back to a full snapshot.
      const newest = this.snapshots[this.snapshots.length - 1];
      if (newest) this.send({ t: 'ack', tick: newest.tick });
      this.netStats.deltaMisses++;
      return;
    }
    const state = applyDelta(base.state, d);
    this.onSnapshot(state, d.acks);
    this.send({ t: 'ack', tick: state.tick });
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
    this.reconcileKnife(state);
  }

  /** Drop the knife prediction once the server has caught up with it (or clearly disagrees). */
  private reconcileKnife(state: GameState): void {
    const kp = this.knifePred;
    if (!kp) return;
    const k = state.knife;
    if (kp.kind === 'throw') {
      // Keep the predicted flight while the server still shows the knife in the
      // thrower's hand (not applied yet) or flying (same deterministic path);
      // switch to truth when it has landed or someone caught it.
      const stillOurs = k.mode === 'held' && k.holder === kp.by;
      const flying = k.mode === 'flying' && k.thrower === kp.by;
      if (!stillOurs && !flying) this.knifePred = null;
      else if (flying && kp.knife.mode === 'ground') this.knifePred = null;
    } else {
      // Pickup confirmed, or the knife went somewhere else entirely.
      if (k.mode === 'held' || k.mode === 'flying') this.knifePred = null;
    }
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
        if (lp.predicted && latest) {
          const chargeBefore = lp.predicted.charge;
          const intent = predictLocalPlayer(latest, lp.predicted, input);
          this.predictKnife(latest, lp.predicted, intent.kind === 'none' ? null : { intent, charge: chargeBefore });
        }
      }
      this.send({ t: 'input', seq: this.clientTick, view: Math.floor(this.renderTick()), inputs: batch });
      this.stepKnifePrediction(latest);
    }
    if (nowMs - this.lastPingAt > 2000) {
      this.lastPingAt = nowMs;
      this.send({ t: 'ping', sent: performance.now() });
    }
  }

  /** Start a knife prediction for a local player's throw or pickup. */
  private predictKnife(
    latest: GameState,
    p: PlayerState,
    release: { intent: ReturnType<typeof predictLocalPlayer>; charge: number } | null,
  ): void {
    if (this.knifePred) {
      if (this.clientTick - this.knifePred.sinceTick > KNIFE_PREDICTION_TIMEOUT_TICKS) this.knifePred = null;
      else return;
    }
    const serverKnife = latest.knife;
    const arena = getArena(latest.seed);
    if (release && serverKnife.mode === 'held' && serverKnife.holder === p.id) {
      const it = release.intent;
      let angle = p.heading;
      let target = -1;
      if (it.kind === 'pass') {
        angle = Math.atan2(it.target.y - p.y, it.target.x - p.x);
        target = it.target.id;
      }
      const knife = createThrow(arena, p, angle, release.charge, target);
      if (knife) this.knifePred = { knife, kind: 'throw', by: p.id, sinceTick: this.clientTick };
      return;
    }
    if (p.role === 'puukottaja' && latest.phase === 'playing' && touchesGroundKnife(this.presentKnife(latest) ?? serverKnife, p)) {
      this.knifePred = { knife: { mode: 'held', holder: p.id }, kind: 'pickup', by: p.id, sinceTick: this.clientTick };
    }
  }

  private stepKnifePrediction(latest: GameState | null): void {
    const kp = this.knifePred;
    if (!kp || !latest || kp.knife.mode !== 'flying') return;
    const result = flyKnife(getArena(latest.seed), { ...kp.knife }, null);
    kp.knife = result;
  }

  /**
   * The newest server knife advanced to "now" when a local player threw it,
   * so it lines up with that player's predicted position. Remote throws are
   * left to the interpolated view (which matches the remote players).
   */
  private presentKnife(latest: GameState): KnifeState | null {
    const k = latest.knife;
    if (k.mode !== 'flying' || !this.local.has(k.thrower)) return null;
    const newest = this.snapshots[this.snapshots.length - 1];
    if (!newest) return null;
    const ahead = Math.max(0, Math.min(10, Math.round((performance.now() - newest.at) / TICK_MS)));
    const arena = getArena(latest.seed);
    let cur: KnifeState = { ...k };
    for (let i = 0; i < ahead && cur.mode === 'flying'; i++) cur = flyKnife(arena, cur as FlyingKnife, null);
    return cur;
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
    const latest = this.snapshots[this.snapshots.length - 1]?.state ?? base;
    const knife = this.knifePred?.knife ?? this.presentKnife(latest) ?? base.knife;
    return { state: { ...base, players, knife }, events };
  }

  /** Server tick the remote view is rendered at (fractional). */
  private renderTick(): number {
    if (this.tickOffset === null) return 0;
    return (performance.now() - this.tickOffset) / TICK_MS - INTERP_DELAY_TICKS;
  }

  /** Remote view of the world at the render tick, interpolated by server tick. */
  private interpolated(): GameState | null {
    const n = this.snapshots.length;
    if (n === 0 || this.tickOffset === null) return null;
    const newest = this.snapshots[n - 1]!;
    const renderTick = this.renderTick();
    if (renderTick >= newest.tick) {
      // Snapshots are late: dead-reckon remote players for a few ticks.
      const ahead = renderTick - newest.tick;
      this.netStats.extrapolated = Math.min(6, Math.floor(ahead));
      return extrapolateState(newest.state, ahead, new Set(this.local.keys()));
    }
    this.netStats.extrapolated = 0;
    if (n === 1) return newest.state;
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
