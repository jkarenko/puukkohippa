import Phaser from 'phaser';
import {
  CHARGE_TIME,
  COLOR_PUUKOTTAJA,
  COLOR_RUNNER,
  KNIFE_LENGTH,
  KNIFE_WIDTH,
  PLAYER_RADIUS,
  TICK_RATE,
} from '../sim/constants.js';
import { knifeWorldPosition } from '../sim/sim.js';
import type { Arena, GameState, PlayerState } from '../sim/types.js';

const WALL_FILL = 0x3b4c60;
const WALL_EDGE = 0x7d99b8;
const FLOOR_GRID = 0x10161c;

/** Draws the world with Phaser Graphics. Arena geometry is cached per seed. */
export class Renderer {
  private readonly arenaGfx: Phaser.GameObjects.Graphics;
  private readonly gfx: Phaser.GameObjects.Graphics;
  private readonly labels = new Map<number, Phaser.GameObjects.Text>();
  private arenaSeed = -1;

  constructor(private readonly scene: Phaser.Scene) {
    this.arenaGfx = scene.add.graphics().setDepth(0);
    this.gfx = scene.add.graphics().setDepth(10);
  }

  draw(state: GameState, arena: Arena, localLabels: Map<number, string>): void {
    if (arena.seed !== this.arenaSeed) {
      this.arenaSeed = arena.seed;
      this.drawArena(arena);
    }
    const g = this.gfx;
    g.clear();

    const knifePos = knifeWorldPosition(state);
    const k = state.knife;

    // Knife trail while flying.
    if (k.mode === 'flying') {
      const speed = Math.hypot(k.vx, k.vy);
      const len = Math.min(70, speed * 0.06);
      g.lineStyle(3, 0xffffff, 0.25);
      g.lineBetween(k.x, k.y, k.x - Math.cos(k.heading) * len, k.y - Math.sin(k.heading) * len);
    }
    // Ground knife gets a shadow so its blocking footprint is readable.
    if (k.mode === 'ground') {
      g.fillStyle(0xffffff, 0.06);
      g.fillCircle(k.x, k.y, KNIFE_LENGTH * 0.6);
    }

    const seen = new Set<number>();
    for (const p of state.players) {
      seen.add(p.id);
      this.drawPlayer(p, state);
      this.updateLabel(p, localLabels.get(p.id));
    }
    for (const [id, label] of this.labels) {
      if (!seen.has(id)) {
        label.destroy();
        this.labels.delete(id);
      }
    }

    if (knifePos) this.drawKnife(knifePos.x, knifePos.y, knifePos.heading, k.mode === 'held');
  }

  private drawArena(arena: Arena): void {
    const g = this.arenaGfx;
    g.clear();
    // Faint floor grid for a sense of speed on the black background.
    g.lineStyle(1, FLOOR_GRID, 1);
    for (let x = 0; x <= arena.width; x += 50) g.lineBetween(x, 0, x, arena.height);
    for (let y = 0; y <= arena.height; y += 50) g.lineBetween(0, y, arena.width, y);
    g.fillStyle(WALL_FILL, 1);
    for (const o of arena.obstacles) g.fillRect(o.x, o.y, o.w, o.h);
    g.lineStyle(2, WALL_EDGE, 0.9);
    for (const o of arena.obstacles) g.strokeRect(o.x + 1, o.y + 1, o.w - 2, o.h - 2);
  }

  private drawPlayer(p: PlayerState, state: GameState): void {
    const g = this.gfx;
    const cos = Math.cos(p.heading);
    const sin = Math.sin(p.heading);
    const hat = p.role === 'puukottaja' ? COLOR_PUUKOTTAJA : COLOR_RUNNER;
    const r = PLAYER_RADIUS;

    // Conversion flash.
    if (p.caughtTick >= 0) {
      const age = (state.tick - p.caughtTick) / TICK_RATE;
      if (age < 0.7) {
        const t = age / 0.7;
        g.lineStyle(4 * (1 - t), COLOR_PUUKOTTAJA, 1 - t);
        g.strokeCircle(p.x, p.y, r + 6 + t * 40);
      }
    }

    // Shoulders / body (the bright player colour), slightly oval across the heading.
    g.fillStyle(p.color, 1);
    g.fillEllipse(p.x, p.y, r * 2.2, r * 2.0);
    g.lineStyle(2, 0x000000, 0.6);
    g.strokeEllipse(p.x, p.y, r * 2.2, r * 2.0);
    // Arms as two stubs to the sides.
    g.fillStyle(p.color, 1);
    g.fillCircle(p.x - sin * r * 1.05, p.y + cos * r * 1.05, 5);
    g.fillCircle(p.x + sin * r * 1.05, p.y - cos * r * 1.05, 5);

    // Hat: brim ring, then crown.
    g.fillStyle(hat, 1);
    g.fillCircle(p.x, p.y, r * 0.66);
    g.lineStyle(3, darken(hat, 0.55), 1);
    g.strokeCircle(p.x, p.y, r * 0.66);
    g.fillStyle(lighten(hat, 0.25), 1);
    g.fillCircle(p.x - cos * 2, p.y - sin * 2, r * 0.36);
    // Visor / nose pointing along the heading.
    const nx = p.x + cos * (r * 0.66);
    const ny = p.y + sin * (r * 0.66);
    g.fillStyle(darken(hat, 0.5), 1);
    g.fillTriangle(
      nx + cos * 6,
      ny + sin * 6,
      nx - sin * 5,
      ny + cos * 5,
      nx + sin * 5,
      ny - cos * 5,
    );

    // Charge bar.
    if (p.charge >= 0) {
      const w = 36;
      const x0 = p.x - w / 2;
      const y0 = p.y - r - 14;
      g.fillStyle(0x000000, 0.6);
      g.fillRect(x0 - 1, y0 - 1, w + 2, 7);
      const c = Phaser.Display.Color.Interpolate.ColorWithColor(
        Phaser.Display.Color.ValueToColor(0xfdd835),
        Phaser.Display.Color.ValueToColor(0xff1744),
        100,
        Math.round(p.charge * 100),
      );
      g.fillStyle(Phaser.Display.Color.GetColor(c.r, c.g, c.b), 1);
      g.fillRect(x0, y0, w * p.charge, 5);
      void CHARGE_TIME;
    }
  }

  private drawKnife(x: number, y: number, heading: number, held: boolean): void {
    const g = this.gfx;
    const cos = Math.cos(heading);
    const sin = Math.sin(heading);
    const L = KNIFE_LENGTH;
    const W = KNIFE_WIDTH;
    const pt = (lx: number, ly: number) => new Phaser.Math.Vector2(x + lx * cos - ly * sin, y + lx * sin + ly * cos);
    // Handle from -L/2 to -L/8.
    const h0 = pt(-L / 2, -W / 2);
    const h1 = pt(-L / 8, -W / 2);
    const h2 = pt(-L / 8, W / 2);
    const h3 = pt(-L / 2, W / 2);
    g.fillStyle(0x8d5524, 1);
    g.fillPoints([h0, h1, h2, h3], true);
    // Guard.
    const g0 = pt(-L / 8 - 2, -W / 2 - 3);
    const g1 = pt(-L / 8 + 2, -W / 2 - 3);
    const g2 = pt(-L / 8 + 2, W / 2 + 3);
    const g3 = pt(-L / 8 - 2, W / 2 + 3);
    g.fillStyle(0xb0bec5, 1);
    g.fillPoints([g0, g1, g2, g3], true);
    // Blade: tapering to the tip at +L/2.
    const b0 = pt(-L / 8, -W / 2 + 1);
    const b1 = pt(L / 2, 0);
    const b2 = pt(-L / 8, W / 2 - 1);
    g.fillStyle(held ? 0xe0e6ea : 0xf5f7f9, 1);
    g.fillPoints([b0, b1, b2], true);
    g.lineStyle(1, 0x546e7a, 1);
    g.strokePoints([b0, b1, b2], true);
  }

  private updateLabel(p: PlayerState, localLabel: string | undefined): void {
    let t = this.labels.get(p.id);
    const text = localLabel ? `${p.name} · ${localLabel}` : p.name;
    if (!t) {
      t = this.scene.add
        .text(0, 0, text, {
          fontFamily: 'system-ui, sans-serif',
          fontSize: '13px',
          color: localLabel ? '#ffffff' : '#b0bec5',
          stroke: '#000000',
          strokeThickness: 3,
        })
        .setOrigin(0.5, 0)
        .setDepth(20);
      this.labels.set(p.id, t);
    } else if (t.text !== text) {
      t.setText(text);
      t.setColor(localLabel ? '#ffffff' : '#b0bec5');
    }
    t.setPosition(p.x, p.y + PLAYER_RADIUS + 4);
    t.setAlpha(0.9);
  }
}

function darken(c: number, f: number): number {
  const col = Phaser.Display.Color.ValueToColor(c);
  return Phaser.Display.Color.GetColor(col.red * f, col.green * f, col.blue * f);
}

function lighten(c: number, f: number): number {
  const col = Phaser.Display.Color.ValueToColor(c);
  return Phaser.Display.Color.GetColor(
    col.red + (255 - col.red) * f,
    col.green + (255 - col.green) * f,
    col.blue + (255 - col.blue) * f,
  );
}
