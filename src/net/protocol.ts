import type { GameState, PlayerInput } from '../sim/types.js';
import type { DeltaMsg } from './delta.js';

export const DEFAULT_PORT = 8787;
export const PROTOCOL_VERSION = 3;

export type ClientMsg =
  /** `session` identifies this browser tab across reconnects. */
  | { t: 'hello'; room: string; v: number; session: string }
  | { t: 'join'; slot: string; name: string; color: number }
  | { t: 'leave'; id: number }
  /**
   * One client tick worth of inputs. `seq` is the client's tick counter,
   * `view` the server tick its remote view was rendered at (lag compensation).
   */
  | { t: 'input'; seq: number; view: number; inputs: Array<{ id: number; input: PlayerInput }> }
  /** Last snapshot tick the client applied; the server sends deltas against it. */
  | { t: 'ack'; tick: number }
  | { t: 'ping'; sent: number };

export type ServerMsg =
  | { t: 'welcome'; room: string; v: number }
  | { t: 'joined'; slot: string; id: number }
  /** Full state plus, per player id, the last input seq applied before this tick. */
  /** `bufs`: inputs still queued on the server per player, for the client's clock control. */
  | { t: 'snapshot'; state: GameState; acks: Record<string, number>; bufs: Record<string, number> }
  | DeltaMsg
  | { t: 'pong'; sent: number }
  | { t: 'error'; message: string };

export function encode(msg: ClientMsg | ServerMsg): string {
  return JSON.stringify(msg, wireReplacer);
}

/** Server-only fields never go on the wire. */
function wireReplacer(key: string, value: unknown): unknown {
  return key === 'prevInput' ? undefined : value;
}

export function decode<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/**
 * Canonical room name: Unicode letters and digits, `-` and `_`, lower-cased,
 * at most 32 characters. Case-insensitive so a phone keyboard capitalising
 * "Sauna" lands in the same room as "sauna". Empty input means "default".
 */
export function normalizeRoomName(raw: string | null | undefined): string {
  const cleaned = String(raw ?? '')
    .normalize('NFC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_-]/gu, '')
    .slice(0, 32);
  return cleaned || 'default';
}

/**
 * Room named by a page URL: `?room=sauna` wins, otherwise the first path
 * segment (`/sauna`), so a link survives redirects that drop the query
 * string. Null means couch mode (no room at all).
 */
export function roomFromLocation(search: string, pathname: string): string | null {
  const q = new URLSearchParams(search);
  if (q.has('room')) return normalizeRoomName(q.get('room'));
  const segment = pathname.split('/').find((s) => s.length > 0) ?? '';
  let decoded = segment;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    /* keep the raw segment */
  }
  if (!decoded || decoded === 'index.html') return null;
  return normalizeRoomName(decoded);
}
