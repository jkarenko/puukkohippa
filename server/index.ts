import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import { DEFAULT_PORT, decode, encode, type ClientMsg, type ServerMsg } from '../src/net/protocol.js';
import { Room } from '../src/net/room.js';
import { MAX_PLAYERS, SNAPSHOT_EVERY_TICKS, TICK_RATE } from '../src/sim/constants.js';
import { hashString } from '../src/sim/rng.js';

const PORT = Number(process.env['PORT'] ?? DEFAULT_PORT);
const DIST = resolve(process.cwd(), 'dist');

interface Client {
  ws: WebSocket;
  room: string | null;
  /** Player ids owned by this connection, keyed by local slot. */
  players: Map<string, number>;
}

interface RoomEntry {
  room: Room;
  clients: Set<Client>;
  timer: NodeJS.Timeout;
  accumulator: number;
  last: number;
  snapshotEvents: ReturnType<Room['flushEvents']>;
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
    accumulator: 0,
    last: performance.now(),
    snapshotEvents: [],
    timer: setInterval(() => {
      const now = performance.now();
      created.accumulator += now - created.last;
      created.last = now;
      // Never spiral: cap catch-up at a quarter second.
      if (created.accumulator > 250) created.accumulator = 250;
      while (created.accumulator >= tickMs) {
        created.accumulator -= tickMs;
        room.tick();
        if (room.state.tick % SNAPSHOT_EVERY_TICKS === 0) {
          // Events from all ticks since the last snapshot ride along.
          broadcast(created, { t: 'snapshot', state: room.state, serverTime: Date.now() });
          room.flushEvents();
        }
      }
    }, tickMs / 2),
  };
  rooms.set(name, created);
  console.log(`[room ${name}] created`);
  return created;
}

function leaveRoom(c: Client): void {
  if (!c.room) return;
  const entry = rooms.get(c.room);
  if (!entry) return;
  for (const id of c.players.values()) entry.room.removePlayer(id);
  c.players.clear();
  entry.clients.delete(c);
  if (entry.clients.size === 0) {
    clearInterval(entry.timer);
    rooms.delete(c.room);
    console.log(`[room ${c.room}] closed`);
  }
  c.room = null;
}

function handle(c: Client, msg: ClientMsg): void {
  switch (msg.t) {
    case 'hello': {
      leaveRoom(c);
      const name = String(msg.room || 'default').slice(0, 32);
      const entry = getRoom(name);
      entry.clients.add(c);
      c.room = name;
      send(c, { t: 'welcome', room: name });
      send(c, { t: 'snapshot', state: entry.room.state, serverTime: Date.now() });
      break;
    }
    case 'join': {
      if (!c.room) return send(c, { t: 'error', message: 'hello first' });
      const entry = rooms.get(c.room);
      if (!entry) return;
      if (entry.room.playerCount >= MAX_PLAYERS) return send(c, { t: 'error', message: 'room full' });
      if (c.players.has(msg.slot)) return;
      const id = entry.room.addPlayer(String(msg.name).slice(0, 16), Number(msg.color) & 0xffffff);
      c.players.set(msg.slot, id);
      send(c, { t: 'joined', slot: msg.slot, id });
      console.log(`[room ${c.room}] player ${id} (${msg.name}) joined, ${entry.room.playerCount} total`);
      break;
    }
    case 'leave': {
      const entry = c.room ? rooms.get(c.room) : undefined;
      if (!entry) return;
      for (const [slot, id] of c.players) {
        if (id === msg.id) {
          entry.room.removePlayer(id);
          c.players.delete(slot);
        }
      }
      break;
    }
    case 'input': {
      const entry = c.room ? rooms.get(c.room) : undefined;
      if (!entry) return;
      const owned = new Set(c.players.values());
      for (const { id, input } of msg.inputs) {
        if (!owned.has(id)) continue;
        entry.room.setInput(id, {
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
      send(c, { t: 'pong', sent: msg.sent, serverTime: Date.now() });
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

wss.on('connection', (ws) => {
  const c: Client = { ws, room: null, players: new Map() };
  ws.on('message', (data) => {
    const msg = decode<ClientMsg>(data.toString());
    if (msg && typeof msg === 'object' && 't' in msg) handle(c, msg);
  });
  ws.on('close', () => leaveRoom(c));
  ws.on('error', () => leaveRoom(c));
});

http.listen(PORT, () => {
  console.log(`Puukkohippa server listening on http://0.0.0.0:${PORT} (ws on the same port)`);
});
