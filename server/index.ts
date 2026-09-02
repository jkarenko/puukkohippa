import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import { DEFAULT_PORT, PROTOCOL_VERSION, decode, encode, type ClientMsg, type ServerMsg } from '../src/net/protocol.js';
import { Room } from '../src/net/room.js';
import { MAX_PLAYERS, SNAPSHOT_EVERY_TICKS, TICK_RATE } from '../src/sim/constants.js';
import { hashString } from '../src/sim/rng.js';

const PORT = Number(process.env['PORT'] ?? DEFAULT_PORT);
const DIST = resolve(process.cwd(), 'dist');

/** How long a dropped connection keeps its players before they are removed. */
const RECONNECT_GRACE_MS = 10_000;
/** WebSocket heartbeat: ping interval; a socket that misses one is terminated. */
const HEARTBEAT_MS = 5_000;

interface Client {
  ws: WebSocket;
  room: string | null;
  session: Session | null;
  alive: boolean;
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
}

interface RoomEntry {
  room: Room;
  clients: Set<Client>;
  sessions: Map<string, Session>;
  timer: NodeJS.Timeout;
  accumulator: number;
  last: number;
}

const rooms = new Map<string, RoomEntry>();

function send(c: Client, msg: ServerMsg): void {
  if (c.ws.readyState === WebSocket.OPEN) c.ws.send(encode(msg));
}

function broadcast(entry: RoomEntry, msg: ServerMsg): void {
  const raw = encode(msg);
  for (const c of entry.clients) if (c.ws.readyState === WebSocket.OPEN) c.ws.send(raw);
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
    timer: setInterval(() => {
      const now = performance.now();
      created.accumulator += now - created.last;
      created.last = now;
      expireSessions(name, created);
      // Never spiral: cap catch-up at a quarter second.
      if (created.accumulator > 250) created.accumulator = 250;
      while (created.accumulator >= tickMs) {
        created.accumulator -= tickMs;
        room.tick();
        if (room.state.tick % SNAPSHOT_EVERY_TICKS === 0) {
          // Events from all ticks since the last snapshot ride along.
          broadcast(created, { t: 'snapshot', state: room.state, acks: room.ackRecord() });
          room.flushEvents();
        }
      }
    }, tickMs / 2),
  };
  rooms.set(name, created);
  console.log(`[room ${name}] created`);
  return created;
}

/** Remove players of sessions whose grace period ran out; close empty rooms. */
function expireSessions(name: string, entry: RoomEntry): void {
  const now = Date.now();
  for (const [id, s] of entry.sessions) {
    if (s.client || s.disconnectedAt === null || now - s.disconnectedAt < RECONNECT_GRACE_MS) continue;
    for (const pid of s.players.values()) entry.room.removePlayer(pid);
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
      const name = String(msg.room || 'default').slice(0, 32);
      const sessionId = String(msg.session || '').slice(0, 64);
      if (!sessionId) return send(c, { t: 'error', message: 'missing session id' });
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
        session = { id: sessionId, players: new Map(), client: c, disconnectedAt: null };
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
      const id = entry.room.addPlayer(String(msg.name).slice(0, 16), Number(msg.color) & 0xffffff);
      session.players.set(msg.slot, id);
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
      if (!Number.isFinite(seq)) return;
      for (const { id, input } of msg.inputs) {
        if (!owned.has(id)) continue;
        entry.room.pushInput(id, seq, {
          fwd: !!input.fwd,
          back: !!input.back,
          left: !!input.left,
          right: !!input.right,
          throw: !!input.throw,
        });
      }
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
const wss = new WebSocketServer({ server: http });

const clients = new Set<Client>();

wss.on('connection', (ws) => {
  const c: Client = { ws, room: null, session: null, alive: true };
  clients.add(c);
  ws.on('pong', () => {
    c.alive = true;
  });
  ws.on('message', (data) => {
    const msg = decode<ClientMsg>(data.toString());
    if (msg && typeof msg === 'object' && 't' in msg) handle(c, msg);
  });
  ws.on('close', () => {
    clients.delete(c);
    detach(c);
  });
  ws.on('error', () => {
    clients.delete(c);
    detach(c);
  });
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
