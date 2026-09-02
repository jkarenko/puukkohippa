import type { GameState, PlayerInput } from '../sim/types.js';

export const DEFAULT_PORT = 8787;
export const PROTOCOL_VERSION = 2;

export type ClientMsg =
  | { t: 'hello'; room: string; v: number }
  | { t: 'join'; slot: string; name: string; color: number }
  | { t: 'leave'; id: number }
  /** One client tick worth of inputs. `seq` is the client's tick counter. */
  | { t: 'input'; seq: number; inputs: Array<{ id: number; input: PlayerInput }> }
  | { t: 'ping'; sent: number };

export type ServerMsg =
  | { t: 'welcome'; room: string; v: number }
  | { t: 'joined'; slot: string; id: number }
  /** Full state plus, per player id, the last input seq applied before this tick. */
  | { t: 'snapshot'; state: GameState; acks: Record<string, number> }
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
