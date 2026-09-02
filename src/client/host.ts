import { decode, encode, type ClientMsg, type ServerMsg } from '../net/protocol.js';
import { Room } from '../net/room.js';
import { TICK_RATE } from '../sim/constants.js';
import { lerp, lerpAngle } from '../sim/geom.js';
import {
  EMPTY_INPUT,
  copyInput,
  inputsEqual,
  type GameEvent,
  type GameState,
  type PlayerInput,
} from '../sim/types.js';

export interface Frame {
  state: GameState | null;
  events: GameEvent[];
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
  destroy(): void;
}

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
    const tickMs = 1000 / TICK_RATE;
    while (this.acc >= tickMs) {
      this.acc -= tickMs;
      this.room.tick();
    }
  }

  frame(): Frame {
    return { state: this.room.state, events: this.room.flushEvents() };
  }

  destroy(): void {}
}

// ------------------------------------------------------------------ net

interface Snapshot {
  state: GameState;
  /** Local receipt time in ms. */
  at: number;
}

/** Render this far behind the newest snapshot so there is always a pair to interpolate. */
const INTERP_DELAY_MS = 110;
const INPUT_SEND_INTERVAL_MS = 1000 / 30;
const INPUT_KEEPALIVE_MS = 250;

export class NetHost implements Host {
  readonly kind = 'net' as const;
  status = 'connecting';
  onJoined: Host['onJoined'] = null;

  private ws: WebSocket | null = null;
  private readonly snapshots: Snapshot[] = [];
  private pendingEvents: GameEvent[] = [];
  private readonly slots = new Map<string, { name: string; color: number; id: number | null }>();
  private readonly inputs = new Map<number, { cur: PlayerInput; sent: PlayerInput; sentAt: number }>();
  private lastSendAt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  rttMs = 0;

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
      this.send({ t: 'hello', room: this.room });
      // Re-register every slot we already had (reconnect case).
      for (const [slot, s] of this.slots) {
        s.id = null;
        this.send({ t: 'join', slot, name: s.name, color: s.color });
      }
      this.inputs.clear();
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
        this.inputs.set(msg.id, { cur: copyInput(EMPTY_INPUT), sent: copyInput(EMPTY_INPUT), sentAt: 0 });
        this.onJoined?.(msg.slot, msg.id);
        break;
      }
      case 'snapshot': {
        const at = performance.now();
        this.pendingEvents.push(...msg.state.events);
        msg.state.events = [];
        this.snapshots.push({ state: msg.state, at });
        // Keep a short history only.
        while (this.snapshots.length > 12) this.snapshots.shift();
        break;
      }
      case 'pong':
        this.rttMs = performance.now() - msg.sent;
        break;
      case 'error':
        this.status = `server: ${msg.message}`;
        break;
    }
  }

  join(slot: string, name: string, color: number): void {
    if (this.slots.has(slot)) return;
    this.slots.set(slot, { name, color, id: null });
    this.send({ t: 'join', slot, name, color });
  }

  leave(id: number): void {
    for (const [slot, s] of this.slots) if (s.id === id) this.slots.delete(slot);
    this.inputs.delete(id);
    this.send({ t: 'leave', id });
  }

  setInput(id: number, input: PlayerInput): void {
    const e = this.inputs.get(id);
    if (e) e.cur = copyInput(input);
  }

  update(nowMs: number): void {
    if (nowMs - this.lastSendAt < INPUT_SEND_INTERVAL_MS) return;
    this.lastSendAt = nowMs;
    const batch: Array<{ id: number; input: PlayerInput }> = [];
    for (const [id, e] of this.inputs) {
      if (!inputsEqual(e.cur, e.sent) || nowMs - e.sentAt > INPUT_KEEPALIVE_MS) {
        batch.push({ id, input: e.cur });
        e.sent = copyInput(e.cur);
        e.sentAt = nowMs;
      }
    }
    if (batch.length) this.send({ t: 'input', inputs: batch });
    if (Math.floor(nowMs / 2000) !== Math.floor((nowMs - INPUT_SEND_INTERVAL_MS) / 2000)) {
      this.send({ t: 'ping', sent: performance.now() });
    }
  }

  frame(): Frame {
    const events = this.pendingEvents;
    this.pendingEvents = [];
    const n = this.snapshots.length;
    if (n === 0) return { state: null, events };
    const renderAt = performance.now() - INTERP_DELAY_MS;
    let a: Snapshot | null = null;
    let b: Snapshot | null = null;
    for (let i = 0; i < n - 1; i++) {
      const s0 = this.snapshots[i]!;
      const s1 = this.snapshots[i + 1]!;
      if (s0.at <= renderAt && renderAt <= s1.at) {
        a = s0;
        b = s1;
        break;
      }
    }
    if (!a || !b) {
      // Either too far behind (show newest) or too far ahead (show oldest usable).
      const newest = this.snapshots[n - 1]!;
      return { state: newest.state, events };
    }
    const t = b.at === a.at ? 1 : (renderAt - a.at) / (b.at - a.at);
    return { state: interpolate(a.state, b.state, t), events };
  }

  destroy(): void {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
  }
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
