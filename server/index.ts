import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import { encodeDelta } from '../src/net/delta.js';
import { DEFAULT_PORT, PROTOCOL_VERSION, decode, encode, normalizeRoomName, type ClientMsg, type ServerMsg } from '../src/net/protocol.js';
import { Room } from '../src/net/room.js';
import { MAX_PLAYERS, SNAPSHOT_EVERY_TICKS, TICK_RATE } from '../src/sim/constants.js';
import { hashString } from '../src/sim/rng.js';
import type { GameState } from '../src/sim/types.js';

const PORT = Number(process.env['PORT'] ?? DEFAULT_PORT);
const DIST = resolve(process.cwd(), 'dist');

/** How long a dropped connection keeps its players before they are removed. */
const RECONNECT_GRACE_MS = 10_000;
/** WebSocket heartbeat: ping interval; a socket that misses one is terminated. */
const HEARTBEAT_MS = 5_000;
/** Sessions that press nothing for this long are removed (lobby / in a round). */
const IDLE_KICK_LOBBY_MS = 60_000;
const IDLE_KICK_PLAYING_MS = 180_000;
/** Sent snapshots kept as delta baselines, in ticks (3 s). */
const SNAPSHOT_HISTORY_TICKS = 180;
/** Caps. A LAN party behind one NAT shares an IP, so keep that one generous. */
const MAX_PAYLOAD_BYTES = 4096;
const MAX_CONNECTIONS_PER_IP = 32;
const MAX_ROOMS = 64;
const MAX_MESSAGES_PER_SEC = 150; // ~60 inputs + acks + pings, with headroom
const STATS_LOG_MS = 10_000;

interface Client {
  ws: WebSocket;
  ip: string;
  room: string | null;
  session: Session | null;
  alive: boolean;
  /** Last snapshot tick this client acknowledged; deltas are encoded against it. */
  ackedTick: number;
  /** Token bucket for message rate limiting. */
  tokens: number;
  tokensAt: number;
}

/**
 * A session is one browser tab. It owns players (one per local control
 * slot) and survives a reconnect: the new socket picks up the same players.
 */
interface Session {
  id: string;
  /** Player ids owned by this session, keyed by local slot. */
  players: Map<string, number>;
  client: Client | null;
  disconnectedAt: number | null;
  /** Last time any button was pressed (idle kick). */
  lastActiveAt: number;
}

interface RoomStats {
  bytesOut: number;
  snapshots: number;
  deltas: number;
  overruns: number;
  loggedAt: number;
}

interface RoomEntry {
  room: Room;
  clients: Set<Client>;
  sessions: Map<string, Session>;
  timer: NodeJS.Timeout;
  accumulator: number;
  last: number;
  /** Wire copies of recent snapshots by tick, delta baselines. */
  sent: Map<number, GameState>;
  stats: RoomStats;
}

const rooms = new Map<string, RoomEntry>();

function send(c: Client, msg: ServerMsg): void {
  if (c.ws.readyState === WebSocket.OPEN) c.ws.send(encode(msg));
}

/** A copy of the state as it goes on the wire (server-only fields removed). */
function wireCopy(state: GameState): GameState {
  return JSON.parse(encode({ t: 'snapshot', state, acks: {} })).state as GameState;
}

/**
 * Send the current state to every client: a delta against the snapshot the
 * client last acknowledged when we still have it, a full snapshot otherwise.
 */
function broadcastState(entry: RoomEntry): void {
  const room = entry.room;
  const cur = wireCopy(room.state);
  const acks = room.ackRecord();
  const tick = room.state.tick;
  let full: string | null = null;
  for (const c of entry.clients) {
    if (c.ws.readyState !== WebSocket.OPEN) continue;
    const base = entry.sent.get(c.ackedTick);
    let raw: string;
    if (base) {
      raw = JSON.stringify(encodeDelta(base, cur, acks));
      entry.stats.deltas++;
    } else {
      full ??= encode({ t: 'snapshot', state: cur, acks });
      raw = full;
      entry.stats.snapshots++;
    }
    entry.stats.bytesOut += raw.length;
    c.ws.send(raw);
  }
  entry.sent.set(tick, cur);
  for (const t of entry.sent.keys()) if (t < tick - SNAPSHOT_HISTORY_TICKS) entry.sent.delete(t);
}

function logStats(name: string, entry: RoomEntry): void {
  const st = entry.stats;
  const now = Date.now();
  const secs = (now - st.loggedAt) / 1000;
  if (secs < STATS_LOG_MS / 1000) return;
  const queues = entry.room.state.players.map((p) => `${p.id}:${entry.room.queued(p.id)}`).join(' ');
  console.log(
    `[room ${name}] tick ${entry.room.state.tick} ${entry.room.state.phase} players ${entry.room.playerCount} ` +
      `sessions ${entry.sessions.size} sockets ${entry.clients.size} ` +
      `out ${(st.bytesOut / secs / 1024).toFixed(1)} kB/s (${st.deltas} delta, ${st.snapshots} full) ` +
      `overruns ${st.overruns} queues [${queues}]`,
  );
  entry.stats = { bytesOut: 0, snapshots: 0, deltas: 0, overruns: 0, loggedAt: now };
}

function getRoom(name: string): RoomEntry {
  let entry = rooms.get(name);
  if (entry) return entry;
  const room = new Room(hashString(name) ^ (Date.now() >>> 0));
  const tickMs = 1000 / TICK_RATE;
  const created: RoomEntry = {
    room,
    clients: new Set(),
    sessions: new Map(),
    accumulator: 0,
    last: performance.now(),
    sent: new Map(),
    stats: { bytesOut: 0, snapshots: 0, deltas: 0, overruns: 0, loggedAt: Date.now() },
    timer: setInterval(() => {
      const now = performance.now();
      created.accumulator += now - created.last;
      created.last = now;
      expireSessions(name, created);
      // Never spiral: cap catch-up at a quarter second.
      if (created.accumulator > 250) {
        created.accumulator = 250;
        created.stats.overruns++;
      }
      while (created.accumulator >= tickMs) {
        created.accumulator -= tickMs;
        room.tick();
        if (room.state.tick % SNAPSHOT_EVERY_TICKS === 0) {
          // Events from all ticks since the last snapshot ride along.
          broadcastState(created);
          room.flushEvents();
        }
      }
      logStats(name, created);
    }, tickMs / 2),
  };
  rooms.set(name, created);
  console.log(`[room ${name}] created`);
  return created;
}

/** Remove players of sessions whose grace period ran out or that went idle; close empty rooms. */
function expireSessions(name: string, entry: RoomEntry): void {
  const now = Date.now();
  const idleLimit = entry.room.state.phase === 'lobby' ? IDLE_KICK_LOBBY_MS : IDLE_KICK_PLAYING_MS;
  for (const [id, s] of entry.sessions) {
    const graceOver = !s.client && s.disconnectedAt !== null && now - s.disconnectedAt >= RECONNECT_GRACE_MS;
    const idle = s.client !== null && s.players.size > 0 && now - s.lastActiveAt >= idleLimit;
    if (!graceOver && !idle) continue;
    for (const pid of s.players.values()) entry.room.removePlayer(pid);
    s.players.clear();
    if (idle) {
      s.lastActiveAt = now;
      s.client && send(s.client, { t: 'error', message: 'removed for being idle, press a button to rejoin' });
      console.log(`[room ${name}] session ${id} idle-kicked`);
      continue;
    }
    entry.sessions.delete(id);
    console.log(`[room ${name}] session ${id} expired, ${entry.room.playerCount} players left`);
  }
  if (entry.clients.size === 0 && entry.sessions.size === 0) {
    clearInterval(entry.timer);
    rooms.delete(name);
    console.log(`[room ${name}] closed`);
  }
}

/** Socket gone: keep the session's players in a dimmed, idle state for the grace period. */
function detach(c: Client): void {
  const entry = c.room ? rooms.get(c.room) : undefined;
  entry?.clients.delete(c);
  const s = c.session;
  if (s && s.client === c) {
    s.client = null;
    s.disconnectedAt = Date.now();
    if (entry) for (const pid of s.players.values()) entry.room.setConnected(pid, false);
    console.log(`[room ${c.room}] session ${s.id} disconnected, grace ${RECONNECT_GRACE_MS / 1000}s`);
  }
  c.session = null;
  c.room = null;
  if (entry && c.room === null && entry.clients.size === 0 && entry.sessions.size === 0) expireSessions(c.room ?? '', entry);
}

function handle(c: Client, msg: ClientMsg): void {
  switch (msg.t) {
    case 'hello': {
      detach(c);
      if (msg.v !== PROTOCOL_VERSION) {
        send(c, { t: 'error', message: `protocol v${msg.v} not supported, reload the page` });
        return;
      }
      const name = normalizeRoomName(msg.room);
      const sessionId = String(msg.session || '').replace(/[^\w-]/g, '').slice(0, 64);
      if (!sessionId) return send(c, { t: 'error', message: 'missing session id' });
      if (!rooms.has(name) && rooms.size >= MAX_ROOMS) return send(c, { t: 'error', message: 'too many rooms' });
      const entry = getRoom(name);
      entry.clients.add(c);
      c.room = name;
      let session = entry.sessions.get(sessionId);
      if (session) {
        // Reconnect: hand the existing players back to the new socket.
        session.client?.ws.close(4000, 'replaced by a newer connection');
        session.client = c;
        session.disconnectedAt = null;
        for (const pid of session.players.values()) entry.room.setConnected(pid, true);
        console.log(`[room ${name}] session ${sessionId} reconnected with ${session.players.size} players`);
      } else {
        session = { id: sessionId, players: new Map(), client: c, disconnectedAt: null, lastActiveAt: Date.now() };
        entry.sessions.set(sessionId, session);
      }
      c.session = session;
      send(c, { t: 'welcome', room: name, v: PROTOCOL_VERSION });
      for (const [slot, id] of session.players) send(c, { t: 'joined', slot, id });
      send(c, { t: 'snapshot', state: entry.room.state, acks: entry.room.ackRecord() });
      break;
    }
    case 'join': {
      const entry = c.room ? rooms.get(c.room) : undefined;
      const session = c.session;
      if (!entry || !session) return send(c, { t: 'error', message: 'hello first' });
      const existing = session.players.get(msg.slot);
      if (existing !== undefined) return send(c, { t: 'joined', slot: msg.slot, id: existing });
      if (entry.room.playerCount >= MAX_PLAYERS) return send(c, { t: 'error', message: 'room full' });
      const name = String(msg.name).replace(/[^\p{L}\p{N} _.-]/gu, '').slice(0, 16) || 'Nimetön';
      const id = entry.room.addPlayer(name, Number(msg.color) & 0xffffff, session.id);
      session.players.set(String(msg.slot).slice(0, 16), id);
      session.lastActiveAt = Date.now();
      send(c, { t: 'joined', slot: msg.slot, id });
      console.log(`[room ${c.room}] player ${id} (${msg.name}) joined, ${entry.room.playerCount} total`);
      break;
    }
    case 'leave': {
      const entry = c.room ? rooms.get(c.room) : undefined;
      const session = c.session;
      if (!entry || !session) return;
      for (const [slot, id] of session.players) {
        if (id === msg.id) {
          entry.room.removePlayer(id);
          session.players.delete(slot);
        }
      }
      break;
    }
    case 'input': {
      const entry = c.room ? rooms.get(c.room) : undefined;
      if (!entry || !c.session) return;
      const owned = new Set(c.session.players.values());
      const seq = Number(msg.seq);
      if (!Number.isFinite(seq) || !Array.isArray(msg.inputs)) return;
      const view = Number.isFinite(Number(msg.view)) ? Math.floor(Number(msg.view)) : null;
      for (const { id, input } of msg.inputs.slice(0, 8)) {
        if (!owned.has(id) || !input) continue;
        const clean = { fwd: !!input.fwd, back: !!input.back, left: !!input.left, right: !!input.right, throw: !!input.throw };
        if (clean.fwd || clean.back || clean.left || clean.right || clean.throw) c.session.lastActiveAt = Date.now();
        entry.room.pushInput(id, seq, clean, view);
      }
      break;
    }
    case 'ack': {
      const tick = Number(msg.tick);
      if (Number.isFinite(tick) && tick > c.ackedTick) c.ackedTick = tick;
      break;
    }
    case 'ping':
      send(c, { t: 'pong', sent: msg.sent });
      break;
  }
}

// ---- static file serving for the built client ----
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function serveStatic(req: IncomingMessage, res: ServerResponse): void {
  if (req.url === '/stats') {
    const out = [...rooms.entries()].map(([name, e]) => ({
      room: name,
      tick: e.room.state.tick,
      phase: e.room.state.phase,
      players: e.room.playerCount,
      sessions: e.sessions.size,
      sockets: e.clients.size,
      queues: Object.fromEntries(e.room.state.players.map((p) => [p.id, e.room.queued(p.id)])),
    }));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ rooms: out, connections: clients.size, uptimeSec: Math.round(process.uptime()) }));
    return;
  }
  if (!existsSync(DIST)) {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('Puukkohippa server running. Build the client with `pnpm build` to serve it from here.\n');
    return;
  }
  const url = new URL(req.url ?? '/', 'http://localhost');
  let path = normalize(decodeURIComponent(url.pathname));
  if (path.endsWith('/')) path += 'index.html';
  const file = join(DIST, path);
  if (!file.startsWith(DIST) || !existsSync(file) || !statSync(file).isFile()) {
    // SPA fallback.
    const index = join(DIST, 'index.html');
    res.writeHead(200, { 'content-type': MIME['.html']! });
    createReadStream(index).pipe(res);
    return;
  }
  res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
  createReadStream(file).pipe(res);
}

const http = createServer(serveStatic);
const wss = new WebSocketServer({ server: http, maxPayload: MAX_PAYLOAD_BYTES });

const clients = new Set<Client>();
const perIp = new Map<string, number>();

function clientIp(req: IncomingMessage): string {
  const fwd = req.headers['x-forwarded-for'];
  const first = Array.isArray(fwd) ? fwd[0] : fwd?.split(',')[0];
  return (first ?? req.socket.remoteAddress ?? 'unknown').trim();
}

/** Token bucket: refills at MAX_MESSAGES_PER_SEC, bursts up to one second's worth. */
function allowMessage(c: Client): boolean {
  const now = performance.now();
  c.tokens = Math.min(MAX_MESSAGES_PER_SEC, c.tokens + ((now - c.tokensAt) / 1000) * MAX_MESSAGES_PER_SEC);
  c.tokensAt = now;
  if (c.tokens < 1) return false;
  c.tokens -= 1;
  return true;
}

wss.on('connection', (ws, req) => {
  const ip = clientIp(req);
  const count = perIp.get(ip) ?? 0;
  if (count >= MAX_CONNECTIONS_PER_IP) {
    ws.close(4001, 'too many connections from this address');
    return;
  }
  perIp.set(ip, count + 1);
  const c: Client = { ws, ip, room: null, session: null, alive: true, ackedTick: 0, tokens: MAX_MESSAGES_PER_SEC, tokensAt: performance.now() };
  clients.add(c);
  let strikes = 0;
  ws.on('pong', () => {
    c.alive = true;
  });
  ws.on('message', (data) => {
    if (!allowMessage(c)) {
      // A client flooding far beyond the budget is cut off.
      if (++strikes > MAX_MESSAGES_PER_SEC * 5) ws.close(4002, 'message rate limit');
      return;
    }
    const msg = decode<ClientMsg>(data.toString());
    if (msg && typeof msg === 'object' && 't' in msg) handle(c, msg);
  });
  const gone = () => {
    if (!clients.delete(c)) return;
    const n = (perIp.get(ip) ?? 1) - 1;
    if (n <= 0) perIp.delete(ip);
    else perIp.set(ip, n);
    detach(c);
  };
  ws.on('close', gone);
  ws.on('error', gone);
});

// Heartbeat: a client that stops answering pings (sleeping laptop, dead
// wifi) is terminated so its session enters the grace period promptly.
setInterval(() => {
  for (const c of clients) {
    if (!c.alive) {
      c.ws.terminate();
      continue;
    }
    c.alive = false;
    c.ws.ping();
  }
}, HEARTBEAT_MS);

http.listen(PORT, () => {
  console.log(`Puukkohippa server listening on http://0.0.0.0:${PORT} (ws on the same port)`);
});
