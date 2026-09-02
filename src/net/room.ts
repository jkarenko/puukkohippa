import { addPlayer, createState, removePlayer, step } from '../sim/sim.js';
import { EMPTY_INPUT, copyInput, type GameEvent, type GameState, type PlayerInput } from '../sim/types.js';

/**
 * A room owns one authoritative simulation and the latest input of every
 * player in it. The server keeps one per room name; the browser keeps one
 * for offline couch play. Both drive it with `tick()` at the fixed tick rate.
 */
export class Room {
  readonly state: GameState;
  private readonly inputs = new Map<number, PlayerInput>();

  constructor(seed: number) {
    this.state = createState(seed);
  }

  addPlayer(name: string, color: number): number {
    const p = addPlayer(this.state, name, color);
    this.inputs.set(p.id, copyInput(EMPTY_INPUT));
    return p.id;
  }

  removePlayer(id: number): void {
    removePlayer(this.state, id);
    this.inputs.delete(id);
  }

  setInput(id: number, input: PlayerInput): void {
    if (!this.inputs.has(id)) return;
    this.inputs.set(id, copyInput(input));
  }

  tick(): void {
    step(this.state, this.inputs);
  }

  /** Returns and clears the events accumulated since the last flush. */
  flushEvents(): GameEvent[] {
    const ev = this.state.events;
    this.state.events = [];
    return ev;
  }

  get playerCount(): number {
    return this.state.players.length;
  }
}
