import Phaser from "phaser";

/** Movement intent shared with GameScene through the global registry. */
export interface MoveIntent {
  up: boolean;
  down: boolean;
  left: boolean;
  right: boolean;
}

export const MOVE_INTENT_KEY = "moveIntent";
// Registry key: the local hero's carried bomb count, published by GameScene so the
// contextual bomb button can show/hide here without this scene touching Colyseus.
export const BOMB_COUNT_KEY = "bombCount";
const NO_MOVE: MoveIntent = { up: false, down: false, left: false, right: false };

// Floating virtual joystick, tuned for thumb-sized touch on small screens.
const STICK_MAX = 56; // px the thumb can travel from the base before clamping
const STICK_DEADZONE = 10; // px of slack before any direction registers
const DIR_THRESHOLD = 0.4; // normalized axis cutoff → clean 8-way movement
const BASE_RADIUS = 60;
const THUMB_RADIUS = 28;
const UI_DEPTH = 1000;

// Action buttons, anchored to the bottom-right (mirror of the joystick thumb).
const ATTACK_RADIUS = 38;
const ATTACK_MARGIN = 18;
const HEAL_RADIUS = 30; // heal button, to the left of attack
const HEAL_GAP = 14; // gap between the two buttons
const BOMB_RADIUS = 30; // bomb button (M10), left of heal; contextual (only while held)
// Use the actual pack art for the button icons (must match GameScene's
// TILES_KEY + CATEGORY_FRAME: sword for attack, potion for heal).
const TILES_KEY = "tiles";
const FRAME_SWORD = 103;
const FRAME_POTION = 115;
// Bomb icon comes from the Tiny Town sheet (loaded by GameScene as TOWN_KEY);
// frame 105 is the bomb tile (mirrors GameScene's FRAME_BOMB).
const TOWN_KEY = "town";
const FRAME_BOMB = 105;

/**
 * Parallel, screen-space scene that turns touch drags into the same movement
 * intent the keyboard produces. Kept separate from GameScene so it renders at
 * native scale, unaffected by the world camera's zoom/scroll. On non-touch
 * input it stays invisible and idle, so desktop keyboard play is untouched.
 */
export class UIScene extends Phaser.Scene {
  private base!: Phaser.GameObjects.Arc;
  private thumb!: Phaser.GameObjects.Arc;
  private attackBtn!: Phaser.GameObjects.Arc;
  private attackIcon!: Phaser.GameObjects.Image;
  private healBtn!: Phaser.GameObjects.Arc;
  private healIcon!: Phaser.GameObjects.Image;
  private bombBtn!: Phaser.GameObjects.Arc; // M10 — contextual (only while holding a bomb)
  private bombIcon!: Phaser.GameObjects.Image;
  private originX = 0;
  private originY = 0;
  private activeId: number | null = null; // pointer id currently driving the stick

  constructor() {
    super("ui");
  }

  create() {
    this.registry.set(MOVE_INTENT_KEY, { ...NO_MOVE });

    // Allow a couple of simultaneous touches (movement now; action buttons later).
    this.input.addPointer(2);

    this.base = this.add
      .circle(0, 0, BASE_RADIUS, 0xffffff, 0.1)
      .setStrokeStyle(2, 0xffffff, 0.35)
      .setScrollFactor(0)
      .setDepth(UI_DEPTH)
      .setVisible(false);
    this.thumb = this.add
      .circle(0, 0, THUMB_RADIUS, 0xffffff, 0.3)
      .setStrokeStyle(2, 0xffffff, 0.5)
      .setScrollFactor(0)
      .setDepth(UI_DEPTH + 1)
      .setVisible(false);

    // Attack button (bottom-right). Tapping it fires a game "attack" event that
    // GameScene turns into a network action — keeps this scene Colyseus-free.
    this.attackBtn = this.add
      .circle(0, 0, ATTACK_RADIUS, 0xff5d73, 0.22)
      .setStrokeStyle(2, 0xff5d73, 0.7)
      .setScrollFactor(0)
      .setDepth(UI_DEPTH);
    this.attackIcon = this.add
      .image(0, 0, TILES_KEY, FRAME_SWORD)
      .setDisplaySize(34, 34)
      .setScrollFactor(0)
      .setDepth(UI_DEPTH + 1);

    // Heal button (left of attack). Fires a game "useHeal" event; the server
    // no-ops if there's no charge, so it's safe to tap anytime.
    this.healBtn = this.add
      .circle(0, 0, HEAL_RADIUS, 0x7cf36b, 0.22)
      .setStrokeStyle(2, 0x7cf36b, 0.7)
      .setScrollFactor(0)
      .setDepth(UI_DEPTH);
    this.healIcon = this.add
      .image(0, 0, TILES_KEY, FRAME_POTION)
      .setDisplaySize(28, 28)
      .setScrollFactor(0)
      .setDepth(UI_DEPTH + 1);

    // Bomb button (M10) — contextual: hidden until the local hero carries a bomb
    // (count published to the registry by GameScene; see update). Fires "useBomb".
    this.bombBtn = this.add
      .circle(0, 0, BOMB_RADIUS, 0xffb86b, 0.22)
      .setStrokeStyle(2, 0xffb86b, 0.7)
      .setScrollFactor(0)
      .setDepth(UI_DEPTH)
      .setVisible(false);
    this.bombIcon = this.add
      .image(0, 0, TOWN_KEY, FRAME_BOMB)
      .setDisplaySize(26, 26)
      .setScrollFactor(0)
      .setDepth(UI_DEPTH + 1)
      .setVisible(false);

    this.layoutButtons();
    this.scale.on(Phaser.Scale.Events.RESIZE, this.layoutButtons, this);

    this.input.on(Phaser.Input.Events.POINTER_DOWN, this.onDown, this);
    this.input.on(Phaser.Input.Events.POINTER_MOVE, this.onMove, this);
    this.input.on(Phaser.Input.Events.POINTER_UP, this.onUp, this);
    this.input.on(Phaser.Input.Events.POINTER_UP_OUTSIDE, this.onUp, this);

    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.setIntent(NO_MOVE); // don't leave the hero walking if torn down mid-press
      this.scale.off(Phaser.Scale.Events.RESIZE, this.layoutButtons, this);
    });
  }

  /** Pin the action buttons to the bottom-right corner (RESIZE-safe). */
  private layoutButtons() {
    const cam = this.cameras.main;
    const ax = cam.width - ATTACK_MARGIN - ATTACK_RADIUS;
    const ay = cam.height - ATTACK_MARGIN - ATTACK_RADIUS;
    this.attackBtn.setPosition(ax, ay);
    this.attackIcon.setPosition(ax, ay);
    const hx = ax - ATTACK_RADIUS - HEAL_GAP - HEAL_RADIUS;
    this.healBtn.setPosition(hx, ay);
    this.healIcon.setPosition(hx, ay);
    const bx = hx - HEAL_RADIUS - HEAL_GAP - BOMB_RADIUS;
    this.bombBtn.setPosition(bx, ay);
    this.bombIcon.setPosition(bx, ay);
  }

  /** Show/hide the contextual bomb button from the registry-published carry count. */
  update() {
    const show = ((this.registry.get(BOMB_COUNT_KEY) as number) ?? 0) > 0;
    if (this.bombBtn.visible !== show) {
      this.bombBtn.setVisible(show);
      this.bombIcon.setVisible(show);
    }
  }

  private onDown(pointer: Phaser.Input.Pointer) {
    // Bomb button (M10) — only catches taps while visible (a bomb in hand).
    if (
      this.bombBtn.visible &&
      Math.hypot(pointer.x - this.bombBtn.x, pointer.y - this.bombBtn.y) <= BOMB_RADIUS
    ) {
      this.game.events.emit("useBomb");
      this.tweens.add({ targets: this.bombBtn, scale: 0.88, duration: 70, yoyo: true });
      return;
    }

    // Heal button takes priority over everything (touch or mouse).
    if (Math.hypot(pointer.x - this.healBtn.x, pointer.y - this.healBtn.y) <= HEAL_RADIUS) {
      this.game.events.emit("useHeal");
      this.tweens.add({ targets: this.healBtn, scale: 0.88, duration: 70, yoyo: true });
      return;
    }

    // Attack button next (works for touch or a mouse click → usable on desktop).
    if (Math.hypot(pointer.x - this.attackBtn.x, pointer.y - this.attackBtn.y) <= ATTACK_RADIUS) {
      this.game.events.emit("attack");
      this.tweens.add({ targets: this.attackBtn, scale: 0.88, duration: 70, yoyo: true });
      return;
    }

    // Touch only — a mouse pointer leaves the joystick dormant so desktop play
    // stays keyboard-driven.
    if (!pointer.wasTouch || this.activeId !== null) return;
    this.activeId = pointer.id;
    this.originX = pointer.x;
    this.originY = pointer.y;
    this.base.setPosition(pointer.x, pointer.y).setVisible(true);
    this.thumb.setPosition(pointer.x, pointer.y).setVisible(true);
  }

  private onMove(pointer: Phaser.Input.Pointer) {
    if (pointer.id !== this.activeId) return;
    const rawX = pointer.x - this.originX;
    const rawY = pointer.y - this.originY;
    const dist = Math.hypot(rawX, rawY);

    // Clamp the thumb to the base ring for visual feedback…
    const clamp = dist > STICK_MAX ? STICK_MAX / dist : 1;
    this.thumb.setPosition(this.originX + rawX * clamp, this.originY + rawY * clamp);

    // …but read direction from the true drag angle.
    if (dist < STICK_DEADZONE) {
      this.setIntent(NO_MOVE);
      return;
    }
    const nx = rawX / dist;
    const ny = rawY / dist;
    this.setIntent({
      up: ny < -DIR_THRESHOLD,
      down: ny > DIR_THRESHOLD,
      left: nx < -DIR_THRESHOLD,
      right: nx > DIR_THRESHOLD,
    });
  }

  private onUp(pointer: Phaser.Input.Pointer) {
    if (pointer.id !== this.activeId) return;
    this.activeId = null;
    this.base.setVisible(false);
    this.thumb.setVisible(false);
    this.setIntent(NO_MOVE);
  }

  private setIntent(intent: MoveIntent) {
    this.registry.set(MOVE_INTENT_KEY, { ...intent });
  }
}
