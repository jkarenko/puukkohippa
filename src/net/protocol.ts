import type { GameState, PlayerInput } from '../sim/types.js';

export const DEFAULT_PORT = 8787;

export type ClientMsg =
  | { t: 'hello'; room: string }
  | { t: 'join'; slot: string; name: string; color: number }
  | { t: 'leave'; id: number }
  | { t: 'input'; inputs: Array<{ id: number; input: PlayerInput }> }
  | { t: 'ping'; sent: number };

export type ServerMsg =
  | { t: 'welcome'; room: string }
  | { t: 'joined'; slot: string; id: number }
  | { t: 'snapshot'; state: GameState; serverTime: number }
  | { t: 'pong'; sent: number; serverTime: number }
  | { t: 'error'; message: string };

export function encode(msg: ClientMsg | ServerMsg): string {
  return JSON.stringify(msg);
}

export function decode<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}
