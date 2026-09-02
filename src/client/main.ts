import Phaser from 'phaser';
import { ARENA_H, ARENA_W } from '../sim/constants.js';
import { GameScene } from './scenes/GameScene.js';

new Phaser.Game({
  type: Phaser.AUTO,
  parent: 'game',
  width: ARENA_W,
  height: ARENA_H,
  backgroundColor: '#000000',
  scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH },
  input: { gamepad: true },
  scene: [GameScene],
});
