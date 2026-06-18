import Phaser from "phaser";

/** Movement intent shared with GameScene through the global registry. */
export interface MoveIntent {
  up: boolean;
  down: boolean;
  left: boolean;
  right: boolean;
}

export const MOVE_INTENT_KEY = "moveIntent";
const NO_MOVE: MoveIntent = { up: false, down: false, left: false, right: false };

// Floating virtual joystick, tuned for thumb-sized touch on small screens.
const STICK_MAX = 56; // px the thumb can travel from the base before clamping
const STICK_DEADZONE = 10; // px of slack before any direction registers
const DIR_THRESHOLD = 0.4; // normalized axis cutoff → clean 8-way movement
const BASE_RADIUS = 60;
const THUMB_RADIUS = 28;
const UI_DEPTH = 1000;

/**
 * Parallel, screen-space scene that turns touch drags into the same movement
 * intent the keyboard produces. Kept separate from GameScene so it renders at
 * native scale, unaffected by the world camera's zoom/scroll. On non-touch
 * input it stays invisible and idle, so desktop keyboard play is untouched.
 */
export class UIScene extends Phaser.Scene {
  private base!: Phaser.GameObjects.Arc;
  private thumb!: Phaser.GameObjects.Arc;
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

    this.input.on(Phaser.Input.Events.POINTER_DOWN, this.onDown, this);
    this.input.on(Phaser.Input.Events.POINTER_MOVE, this.onMove, this);
    this.input.on(Phaser.Input.Events.POINTER_UP, this.onUp, this);
    this.input.on(Phaser.Input.Events.POINTER_UP_OUTSIDE, this.onUp, this);

    // Don't leave the hero walking if this scene is torn down mid-press.
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => this.setIntent(NO_MOVE));
  }

  private onDown(pointer: Phaser.Input.Pointer) {
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
