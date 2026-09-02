import Phaser from 'phaser';
import { DEFAULT_PORT } from '../../net/protocol.js';
import { getArena } from '../../sim/arena.js';
import { ARENA_H, ARENA_W, MAX_PLAYERS, TICK_RATE } from '../../sim/constants.js';
import { hashString } from '../../sim/rng.js';
import { findPlayer, runnerSpeedMultiplier } from '../../sim/sim.js';
import type { GameEvent, GameState } from '../../sim/types.js';
import { LocalHost, NetHost, type Host } from '../host.js';
import { LocalControls } from '../input.js';
import { Renderer } from '../render.js';

const NAMES = [
  'Aatu', 'Eetu', 'Kerttu', 'Vilho', 'Aino', 'Onni', 'Hilla', 'Väinö', 'Lumi', 'Eino',
  'Siiri', 'Toivo', 'Elli', 'Oiva', 'Helmi', 'Arvo', 'Saimi', 'Urho', 'Tyyne', 'Kalle',
  'Maija', 'Sulo', 'Lyyli', 'Reino', 'Impi', 'Veikko', 'Rauha', 'Antero', 'Sisko', 'Tauno',
];

const COLORS = [
  0x00e5ff, 0x76ff03, 0xff4081, 0xffab00, 0x7c4dff, 0x1de9b6, 0xff6e40, 0xc6ff00,
  0x40c4ff, 0xea80fc, 0xffd740, 0x64ffda, 0xff5252, 0x69f0ae, 0x448aff, 0xffff00,
];

interface Options {
  room: string | null;
  server: string;
  seed: number;
}

function readOptions(): Options {
  const q = new URLSearchParams(location.search);
  const room = q.get('room');
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const defaultServer =
    location.port === '5173' || location.port === '' && location.hostname === 'localhost'
      ? `${proto}://${location.hostname}:${DEFAULT_PORT}`
      : `${proto}://${location.host}`;
  const seedStr = q.get('seed');
  return {
    room,
    server: q.get('server') ?? defaultServer,
    seed: seedStr ? hashString(seedStr) : (Date.now() >>> 0),
  };
}

export class GameScene extends Phaser.Scene {
  private host!: Host;
  private controls!: LocalControls;
  private world!: Renderer;
  private readonly slotToId = new Map<string, number>();
  private readonly slotLabels = new Map<string, string>();
  private readonly pendingSlots = new Set<string>();
  private hud!: Phaser.GameObjects.Text;
  private centre!: Phaser.GameObjects.Text;
  private help!: Phaser.GameObjects.Text;
  private lastState: GameState | null = null;

  constructor() {
    super('game');
  }

  create(): void {
    const opts = readOptions();
    this.host = opts.room ? new NetHost(opts.server, opts.room) : new LocalHost(opts.seed);
    this.host.onJoined = (slot, id) => {
      this.slotToId.set(slot, id);
      this.pendingSlots.delete(slot);
    };
    this.controls = new LocalControls(this);
    this.world = new Renderer(this);

    const style = { fontFamily: 'system-ui, sans-serif', stroke: '#000', strokeThickness: 4 };
    this.hud = this.add.text(12, 8, '', { ...style, fontSize: '16px', color: '#cfd8dc' }).setDepth(50);
    this.help = this.add
      .text(ARENA_W / 2, ARENA_H - 10, '', { ...style, fontSize: '15px', color: '#90a4ae' })
      .setOrigin(0.5, 1)
      .setDepth(50);
    this.centre = this.add
      .text(ARENA_W / 2, ARENA_H / 2 - 40, '', { ...style, fontSize: '56px', color: '#ffffff', align: 'center' })
      .setOrigin(0.5)
      .setDepth(60);

    this.events.once('shutdown', () => this.host.destroy());
    window.addEventListener('beforeunload', () => this.host.destroy());
  }

  override update(time: number): void {
    // 1. Inputs from every local slot.
    for (const s of this.controls.poll()) {
      const id = this.slotToId.get(s.slot);
      if (id !== undefined) {
        this.host.setInput(id, s.input);
      } else if (s.throwPressed && !this.pendingSlots.has(s.slot)) {
        const count = this.lastState?.players.length ?? 0;
        if (count >= MAX_PLAYERS) continue;
        this.pendingSlots.add(s.slot);
        this.slotLabels.set(s.slot, s.label);
        const idx = this.slotToId.size + this.pendingSlots.size + hashString(s.slot) % 7;
        const name = NAMES[(hashString(s.slot + time.toFixed(0)) + idx) % NAMES.length]!;
        const color = COLORS[(idx * 5 + Math.floor(time / 100)) % COLORS.length]!;
        this.host.join(s.slot, name, color);
      }
    }

    // 2. Advance / sync.
    this.host.update(time);
    const { state, events } = this.host.frame(time);
    this.lastState = state;
    if (!state) {
      this.centre.setText(this.host.status);
      this.hud.setText('');
      return;
    }

    // 3. Draw.
    const localLabels = new Map<number, string>();
    for (const [slot, id] of this.slotToId) localLabels.set(id, this.slotLabels.get(slot) ?? slot);
    this.world.draw(state, getArena(state.seed), localLabels);
    this.drawHud(state);
    for (const e of events) this.handleEvent(e, state);
  }

  private drawHud(state: GameState): void {
    const runners = state.players.filter((p) => p.role === 'runner').length;
    const puukottajat = state.players.length - runners;
    const secs = Math.max(0, Math.floor((state.tick - state.roundStartTick) / TICK_RATE));
    const mul = runnerSpeedMultiplier(state);
    const rtt = this.host instanceof NetHost && this.host.rttMs ? ` · ${Math.round(this.host.rttMs)} ms` : '';
    this.hud.setText(
      `Round ${state.round} · ${secs}s · Runners ${runners} · Puukottajat ${puukottajat} · runner speed ×${mul.toFixed(2)}\n` +
        `${this.host.status}${rtt}`,
    );

    const holder = state.knife.mode === 'held' ? findPlayer(state, state.knife.holder) : undefined;
    switch (state.phase) {
      case 'lobby':
        this.centre.setText(
          state.players.length === 0
            ? 'PUUKKOHIPPA\n\npress a throw button to join'
            : `waiting for players (${state.players.length}/2)`,
        );
        break;
      case 'countdown': {
        const left = Math.ceil((state.phaseEndsTick - state.tick) / TICK_RATE);
        this.centre.setText(`${holder?.name ?? '?'} is the puukottaja\n${left}`);
        break;
      }
      case 'playing':
        this.centre.setText('');
        break;
      case 'roundover': {
        const w = findPlayer(state, state.lastCaught);
        this.centre.setText(`Everyone got puukotettu!\n${w ? `${w.name} survived longest` : ''}`);
        break;
      }
    }

    const local = this.slotToId.size;
    const holderHint = holder && this.isLocal(holder.id) ? 'hold throw to charge, release to throw, tap a direction while charging to pass' : '';
    this.help.setText(
      `${LocalControls.joinHint()}${local ? `   ·   ${local} local player${local > 1 ? 's' : ''}` : ''}` +
        (holderHint ? `\n${holderHint}` : ''),
    );
  }

  private isLocal(id: number): boolean {
    for (const v of this.slotToId.values()) if (v === id) return true;
    return false;
  }

  private handleEvent(e: GameEvent, state: GameState): void {
    switch (e.type) {
      case 'convert': {
        const who = findPlayer(state, e.who);
        if (who) this.popText(who.x, who.y - 30, e.viaKnife ? 'PUUKOTETTU!' : 'HIPPA!', '#ff5252');
        this.cameras.main.shake(120, 0.004);
        break;
      }
      case 'throw': {
        const by = findPlayer(state, e.by);
        if (by && e.target !== -1) this.popText(by.x, by.y - 30, 'pass', '#eceff1');
        break;
      }
      case 'roundOver':
        this.cameras.main.flash(300, 255, 60, 60);
        break;
      default:
        break;
    }
  }

  private popText(x: number, y: number, text: string, color: string): void {
    const t = this.add
      .text(x, y, text, { fontFamily: 'system-ui, sans-serif', fontSize: '22px', color, stroke: '#000', strokeThickness: 4 })
      .setOrigin(0.5)
      .setDepth(70);
    this.tweens.add({ targets: t, y: y - 40, alpha: 0, duration: 900, ease: 'Cubic.Out', onComplete: () => t.destroy() });
  }
}
