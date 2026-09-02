import Phaser from 'phaser';
import { EMPTY_INPUT, copyInput, type PlayerInput } from '../sim/types.js';

export interface SlotSample {
  slot: string;
  label: string;
  input: PlayerInput;
  /** Throw button went down this frame; used to join. */
  throwPressed: boolean;
}

interface KeySlotDef {
  id: string;
  label: string;
  keys: Record<keyof PlayerInput, string>;
}

const KEY_SLOTS: KeySlotDef[] = [
  { id: 'kb1', label: 'Arrows + Space', keys: { fwd: 'UP', back: 'DOWN', left: 'LEFT', right: 'RIGHT', throw: 'SPACE' } },
  { id: 'kb2', label: 'WASD + E', keys: { fwd: 'W', back: 'S', left: 'A', right: 'D', throw: 'E' } },
  { id: 'kb3', label: 'IJKL + O', keys: { fwd: 'I', back: 'K', left: 'J', right: 'L', throw: 'O' } },
];

export const MAX_GAMEPADS = 4;
const STICK_DEAD = 0.45;

/**
 * Samples every local control slot (three keyboard layouts and up to four
 * gamepads) into tank-control inputs. Slots are stable ids that the scene
 * maps to player ids once the slot has joined.
 */
export class LocalControls {
  private readonly keySlots: Array<{ def: KeySlotDef; keys: Record<keyof PlayerInput, Phaser.Input.Keyboard.Key> }> = [];
  private readonly prevThrow = new Map<string, boolean>();

  constructor(private readonly scene: Phaser.Scene) {
    const kb = scene.input.keyboard;
    if (!kb) return;
    for (const def of KEY_SLOTS) {
      const keys = {} as Record<keyof PlayerInput, Phaser.Input.Keyboard.Key>;
      for (const k of Object.keys(def.keys) as Array<keyof PlayerInput>) {
        keys[k] = kb.addKey(def.keys[k]);
      }
      this.keySlots.push({ def, keys });
    }
  }

  poll(): SlotSample[] {
    const out: SlotSample[] = [];
    for (const { def, keys } of this.keySlots) {
      const input: PlayerInput = {
        fwd: keys.fwd.isDown,
        back: keys.back.isDown,
        left: keys.left.isDown,
        right: keys.right.isDown,
        throw: keys.throw.isDown,
      };
      out.push(this.sample(def.id, def.label, input));
    }
    const gp = this.scene.input.gamepad;
    if (gp) {
      for (let i = 0; i < Math.min(MAX_GAMEPADS, gp.total); i++) {
        const pad = gp.getPad(i);
        if (!pad || !pad.connected) continue;
        const stick = pad.leftStick;
        const input: PlayerInput = {
          fwd: pad.up || stick.y < -STICK_DEAD,
          back: pad.down || stick.y > STICK_DEAD,
          left: pad.left || stick.x < -STICK_DEAD,
          right: pad.right || stick.x > STICK_DEAD,
          throw: pad.A || pad.R2 > 0.5,
        };
        out.push(this.sample(`gp${pad.index}`, `Gamepad ${pad.index + 1}`, input));
      }
    }
    return out;
  }

  private sample(slot: string, label: string, input: PlayerInput): SlotSample {
    const prev = this.prevThrow.get(slot) ?? false;
    this.prevThrow.set(slot, input.throw);
    return { slot, label, input: copyInput(input), throwPressed: input.throw && !prev };
  }

  static joinHint(): string {
    return 'Join: Space (arrows) · E (WASD) · O (IJKL) · A on a gamepad';
  }

  static emptyInput(): PlayerInput {
    return copyInput(EMPTY_INPUT);
  }
}
