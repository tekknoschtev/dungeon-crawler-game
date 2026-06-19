import Phaser from "phaser";
import { Room, getStateCallbacks } from "@colyseus/sdk";
import { VIEW_W, VIEW_H, TILE } from "../config";
import { MoveIntent, MOVE_INTENT_KEY } from "./UIScene";

// Tiny Dungeon art (Kenney, CC0). The packed sheet is 16x16 tiles, 12 columns,
// no spacing, so a tile's frame index = row * 12 + column. See ATTRIBUTION.md.
const TILES_KEY = "tiles";
const TILE_SRC = 16; // source tile size in px (we scale up to the world TILE)
const FRAME_FLOOR = 48; // plain stone floor (flat; seeded variation comes later)
const FRAME_VOID = 0; // brown "rock/void" behind walls (deep interior)
const FRAME_HERO = 96; // armored knight; tinted per player to tell heroes apart

// Pseudo-2.5D wall autotiling. Lifted directly from Kenney's own Tiny Dungeon
// sample map (Tiled/sampleMap.tmx): for each wall tile we look at which of its
// 4 orthogonal neighbors are FLOOR and pick the brick face/edge/corner tile
// Kenney used for that situation — giving angled walls with brick fronts, dark
// framing, skinny side walls, and brown rock receding behind. No flips needed.
// Neighbor bitmask: North=8, East=4, South=2, West=1.
const N = 8, E = 4, S = 2, W = 1;
const WALL_AUTOTILE: Record<number, number> = {
  [W]: 15, //               floor west  → right-facing edge
  [S]: 40, //               floor south → full brick FACE (front)
  [S | W]: 57, //           floor S+W   → bottom-left corner
  [E]: 13, //               floor east  → left-facing edge
  [E | W]: 58, //           floor E+W   → skinny vertical wall
  [E | S]: 59, //           floor E+S   → bottom-right corner
  [E | S | W]: 30, //       floor on 3 sides (open north)
  [N]: 26, //               floor north → back/top edge
  [N | W]: 4, //            floor N+W   → top-left corner
  [N | E]: 5, //            floor N+E   → top-right corner
  // Thin walls and stubs (floor to the north): use the framed back-edge tile so
  // they get a dark top border instead of a bare, frameless brick face. (Kenney's
  // own flat-top #37 / notched pillar #41 read as stairs/crenellations here.)
  [N | S]: 26, //           floor N+S   → thin horizontal wall
  [N | S | W]: 26,
  [N | E | W]: 26,
  [N | E | S]: 26,
  [N | E | S | W]: 26,
};

// Inner (concave) corners: a wall with no orthogonal floor but floor on a
// diagonal still needs brick wrapping that corner, else it shows a void notch.
// Diagonal bitmask: NW=8, NE=4, SE=2, SW=1 (from Kenney's sample map).
const DNW = 8, DNE = 4, DSE = 2, DSW = 1;
const WALL_INNER_CORNER: Record<number, number> = {
  [DNW]: 27,
  [DNE]: 25,
  [DSE]: 13,
  [DSW]: 15,
  [DSE | DSW]: 18,
};

// A soft shadow strip grounds the floor directly south of a wall.
const WALL_SHADOW_COLOR = 0x000000;
const WALL_SHADOW_ALPHA = 0.32;
const WALL_SHADOW_H = 5; // px (in source/world tile space)

// Camera zoom so native 16px tiles render at a chunky-but-roomy size (≈32px
// on screen). The world is much larger than the viewport, so the camera
// follows the local hero.
const CAMERA_ZOOM = 2;
const CAMERA_LERP = 0.12; // how snappily the camera catches up to the hero

// Name labels live in world space but are counter-scaled by 1/zoom so they
// render at their native pixel size (crisp) instead of being magnified 3x.
const LABEL_OFFSET = 10; // world px above the hero's center

// World tiles/hero sit low; HUD (status text) sits on top.
const HUD_DEPTH = 1000;

// --- Combat + loot (M3 / M4) -------------------------------------------
const FRAME_SLIME = 108; // Tiny Dungeon green slime
const MOB_DEPTH = 8; // mobs render just under heroes (depth 10)
const LOOT_DEPTH = 5;
const LOOT_GLOW_DEPTH = 4;
const ATTACK_COOLDOWN_MS = 450; // client throttle; mirrors the server cooldown
const SWING_RADIUS = 26; // world px of the local swing ring (feedback only)

// Rarity → accent color (loot glow), as a Phaser int and a CSS string (HUD).
const RARITY_COLORS: Record<string, number> = {
  common: 0xb8c0cc,
  uncommon: 0x7cf36b,
  rare: 0x4ec9ff,
  epic: 0xc08bff,
  legendary: 0xffb028,
};
// Loot icons: heal/attack come from the Tiny Dungeon sheet (red potion / sword);
// defense uses our custom steel-shield sprite (Tiny Dungeon has no shield tile).
const CATEGORY_FRAME: Record<string, number> = {
  heal: 115, // red potion
  attack: 103, // sword
};
const SHIELD_KEY = "shield"; // custom 16px shield (see ATTRIBUTION.md)

const BUFF_SECONDS = 6; // mirrors server BUFF_DURATION (for HUD countdown bars)
const HEAL_COOLDOWN_MS = 250; // light throttle on the heal action

/** Shapes decoded on the client (mirror the server schema). */
interface PlayerView {
  x: number;
  y: number;
  name: string;
  color: string;
  hp: number;
  maxHp: number;
  healCharges: number; // stacked heal potions on hand
  attackBuff: number; // seconds remaining (> 0 = active)
  defenseBuff: number;
}

interface MobView {
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  kind: string;
  attackTick: number; // bumps each time the mob lands a hit (strike animation cue)
}

interface LootView {
  x: number;
  y: number;
  rarity: string;
  category: string; // "heal" | "attack" | "defense"
}

interface MapMessage {
  tile: number;
  width: number;
  height: number;
  grid: number[][];
}

/** Per-player visual entity on the client. */
interface Entity {
  sprite: Phaser.GameObjects.Image;
  label: Phaser.GameObjects.Text;
  hpBar: Phaser.GameObjects.Graphics;
  aura: Phaser.GameObjects.Arc; // buff glow under the hero
  target: { x: number; y: number };
  hp: number;
  maxHp: number;
  atkBuff: number; // seconds remaining (drives the aura)
  defBuff: number;
}

interface MobEntity {
  sprite: Phaser.GameObjects.Image;
  hpBar: Phaser.GameObjects.Graphics;
  target: { x: number; y: number };
  hp: number;
  maxHp: number;
  baseScale: number; // sprite scale at rest, so the strike pop can return to it
  attackTick: number; // last-seen server strike counter
}

interface LootEntity {
  sprite: Phaser.GameObjects.Image;
  glow: Phaser.GameObjects.Arc;
}

interface InputState {
  up: boolean;
  down: boolean;
  left: boolean;
  right: boolean;
}

export class GameScene extends Phaser.Scene {
  private room?: Room;
  private entities = new Map<string, Entity>();
  private mobs = new Map<string, MobEntity>();
  private loot = new Map<string, LootEntity>();
  private localId = "";

  private mapLayer!: Phaser.GameObjects.Container;
  private statusText!: Phaser.GameObjects.Text;

  private keys!: {
    up: Phaser.Input.Keyboard.Key;
    down: Phaser.Input.Keyboard.Key;
    left: Phaser.Input.Keyboard.Key;
    right: Phaser.Input.Keyboard.Key;
    w: Phaser.Input.Keyboard.Key;
    a: Phaser.Input.Keyboard.Key;
    s: Phaser.Input.Keyboard.Key;
    d: Phaser.Input.Keyboard.Key;
    space: Phaser.Input.Keyboard.Key;
    q: Phaser.Input.Keyboard.Key;
  };
  private lastSent: InputState = { up: false, down: false, left: false, right: false };
  private lastAttackAt = 0; // client-side attack throttle (ms)
  private attackRequested = false; // set by the touch attack button (UIScene)
  private lastHealAt = 0; // client-side heal throttle (ms)
  private healRequested = false; // set by the touch heal button (UIScene)

  constructor() {
    super("game");
  }

  preload() {
    this.load.spritesheet(TILES_KEY, "/assets/tiny-dungeon/tilemap_packed.png", {
      frameWidth: TILE_SRC,
      frameHeight: TILE_SRC,
    });
    this.load.image(SHIELD_KEY, "/assets/tiny-dungeon/shield.png");
  }

  create() {
    this.mapLayer = this.add.container(0, 0).setDepth(0);

    this.statusText = this.add
      .text(VIEW_W / 2, VIEW_H / 2, "Connecting…", {
        fontFamily: "monospace",
        fontSize: "16px",
        color: "#8a91a3",
      })
      .setOrigin(0.5)
      .setScrollFactor(0) // HUD: pinned to the screen, not the world
      .setDepth(HUD_DEPTH);
    this.centerStatus();

    // The canvas fills the window, so re-center the HUD on resize.
    this.scale.on(Phaser.Scale.Events.RESIZE, this.onResize, this);

    const kb = this.input.keyboard!;
    this.keys = {
      up: kb.addKey(Phaser.Input.Keyboard.KeyCodes.UP),
      down: kb.addKey(Phaser.Input.Keyboard.KeyCodes.DOWN),
      left: kb.addKey(Phaser.Input.Keyboard.KeyCodes.LEFT),
      right: kb.addKey(Phaser.Input.Keyboard.KeyCodes.RIGHT),
      w: kb.addKey(Phaser.Input.Keyboard.KeyCodes.W),
      a: kb.addKey(Phaser.Input.Keyboard.KeyCodes.A),
      s: kb.addKey(Phaser.Input.Keyboard.KeyCodes.S),
      d: kb.addKey(Phaser.Input.Keyboard.KeyCodes.D),
      space: kb.addKey(Phaser.Input.Keyboard.KeyCodes.SPACE),
      q: kb.addKey(Phaser.Input.Keyboard.KeyCodes.Q),
    };
    kb.addCapture("SPACE"); // don't let Space scroll/trigger page defaults

    // Parallel scene that feeds touch movement into the registry (mobile).
    this.scene.launch("ui");

    // Attack/heal: keyboard (Space / Q) on desktop, or the UIScene touch buttons,
    // which fire game-level events so UIScene stays Colyseus-free.
    this.game.events.on("attack", this.onAttackRequest, this);
    this.game.events.on("useHeal", this.onHealRequest, this);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.game.events.off("attack", this.onAttackRequest, this);
      this.game.events.off("useHeal", this.onHealRequest, this);
    });

    this.setupRoom();
  }

  private onAttackRequest() {
    this.attackRequested = true;
  }

  private onHealRequest() {
    this.healRequested = true;
  }

  /**
   * Render the room the lobby already connected (stashed in the registry). The
   * lobby owns matchmaking (create / join-by-code); this scene just renders the
   * resulting room's state.
   */
  private setupRoom() {
    const room = this.registry.get("room") as Room | undefined;
    if (!room) {
      this.statusText.setText("No room to join.\nReload to return to the menu.");
      this.statusText.setAlign("center");
      return;
    }
    this.room = room;
    this.statusText.setVisible(false);

    this.room.onMessage<MapMessage>("map", (data) => this.buildMap(data));

    this.localId = this.room.sessionId;
    const $ = getStateCallbacks(this.room);
    const state = this.room.state as {
      players: Map<string, PlayerView>;
      mobs: Map<string, MobView>;
      loot: Map<string, LootView>;
    };

    // onAdd fires synchronously for players already in the room (including us)
    // when these callbacks register; arm toasts only *after* that initial pass
    // so we don't announce the existing party — or ourselves — on join.
    let toastsArmed = false;

    $(state).players.onAdd((player: PlayerView, sessionId: string) => {
      const isLocal = sessionId === this.localId;
      this.addEntity(player, sessionId, isLocal);
      if (isLocal) this.updateHud(player);
      if (toastsArmed && !isLocal) this.showToast(player.name, "join");
      $(player).onChange(() => {
        const e = this.entities.get(sessionId);
        if (e) {
          // Alive -> dead transition: announce every hero's death in the feed,
          // including our own (which also still shows the center overlay below).
          if (e.hp > 0 && player.hp <= 0) this.showToast(player.name, "death");
          e.target.x = player.x;
          e.target.y = player.y;
          e.hp = player.hp;
          e.maxHp = player.maxHp;
          e.atkBuff = player.attackBuff;
          e.defBuff = player.defenseBuff;
        }
        if (isLocal) {
          this.updateHud(player);
          this.setDeathOverlay(player.hp <= 0);
        }
      });
    });

    // Existing players have now fired their initial onAdd synchronously; any
    // future onAdd is a genuine join worth announcing.
    toastsArmed = true;

    $(state).players.onRemove((player: PlayerView, sessionId: string) => {
      if (sessionId !== this.localId) this.showToast(player.name, "leave");
      const e = this.entities.get(sessionId);
      if (e) {
        e.sprite.destroy();
        e.label.destroy();
        e.hpBar.destroy();
        e.aura.destroy();
        this.entities.delete(sessionId);
      }
    });

    $(state).mobs.onAdd((mob: MobView, id: string) => {
      this.addMob(mob, id);
      $(mob).onChange(() => {
        const m = this.mobs.get(id);
        if (m) {
          m.target.x = mob.x;
          m.target.y = mob.y;
          m.hp = mob.hp;
          m.maxHp = mob.maxHp;
          if (mob.attackTick !== m.attackTick) {
            m.attackTick = mob.attackTick;
            this.mobStrike(m);
          }
        }
      });
    });
    $(state).mobs.onRemove((_mob: MobView, id: string) => this.removeMob(id));

    $(state).loot.onAdd((l: LootView, id: string) => this.addLoot(l, id));
    $(state).loot.onRemove((_l: LootView, id: string) => this.removeLoot(id));

    this.room.onError((code, message) => {
      console.error("Room error:", code, message);
    });

    this.room.onLeave(() => {
      this.statusText.setText("Disconnected.\nReload to rejoin.");
      this.statusText.setAlign("center").setVisible(true);
    });

    // Now that the map handler (and the rest) are wired, ask the server for the
    // map. Doing this here — after boot — avoids missing the one-time payload.
    this.room.send("ready");
  }

  private addEntity(player: PlayerView, sessionId: string, isLocal: boolean) {
    const colorNum = Phaser.Display.Color.HexStringToColor(player.color).color;

    const sprite = this.add
      .image(player.x, player.y, TILES_KEY, FRAME_HERO)
      .setDisplaySize(TILE, TILE)
      .setTint(colorNum)
      .setDepth(10);

    const label = this.add
      .text(player.x, player.y - LABEL_OFFSET, player.name, {
        fontFamily: "monospace",
        fontSize: "11px",
        color: isLocal ? "#ffe066" : "#d7dbe6",
      })
      .setOrigin(0.5, 1)
      .setScale(1 / CAMERA_ZOOM)
      .setDepth(20);

    const hpBar = this.add.graphics().setDepth(11);
    // Buff glow, drawn under the hero; shown/colored from active buffs in update.
    const aura = this.add
      .circle(player.x, player.y, 11, 0xffffff, 0.25)
      .setBlendMode(Phaser.BlendModes.ADD)
      .setDepth(9)
      .setVisible(false);

    this.entities.set(sessionId, {
      sprite,
      label,
      hpBar,
      aura,
      target: { x: player.x, y: player.y },
      hp: player.hp,
      maxHp: player.maxHp,
      atkBuff: player.attackBuff,
      defBuff: player.defenseBuff,
    });

    // The camera follows the local hero through the world.
    if (isLocal) {
      const cam = this.cameras.main;
      cam.setZoom(CAMERA_ZOOM);
      cam.startFollow(sprite, true, CAMERA_LERP, CAMERA_LERP);
      this.centerStatus(); // zoom changed; keep the HUD text crisp + centered
    }
  }

  // --- Mobs + loot rendering ---------------------------------------------

  private addMob(mob: MobView, id: string) {
    const sprite = this.add
      .image(mob.x, mob.y, TILES_KEY, FRAME_SLIME)
      .setDisplaySize(TILE, TILE)
      .setDepth(MOB_DEPTH);
    const hpBar = this.add.graphics().setDepth(MOB_DEPTH + 1);
    this.mobs.set(id, {
      sprite,
      hpBar,
      target: { x: mob.x, y: mob.y },
      hp: mob.hp,
      maxHp: mob.maxHp,
      baseScale: sprite.scaleX, // set by setDisplaySize above
      attackTick: mob.attackTick, // seed so we don't flash on spawn
    });
  }

  private removeMob(id: string) {
    const m = this.mobs.get(id);
    if (!m) return;
    this.tweens.killTweensOf(m.sprite); // cancel a mid-strike pop before freeing
    m.sprite.destroy();
    m.hpBar.destroy();
    this.mobs.delete(id);
  }

  private addLoot(l: LootView, id: string) {
    const color = RARITY_COLORS[l.rarity] ?? RARITY_COLORS.common;
    const glow = this.add
      .circle(l.x, l.y, 9, color, 0.5)
      .setBlendMode(Phaser.BlendModes.ADD)
      .setDepth(LOOT_GLOW_DEPTH);
    const sprite = (
      l.category === "defense"
        ? this.add.image(l.x, l.y, SHIELD_KEY)
        : this.add.image(l.x, l.y, TILES_KEY, CATEGORY_FRAME[l.category] ?? CATEGORY_FRAME.heal)
    )
      .setDisplaySize(TILE, TILE)
      .setDepth(LOOT_DEPTH);
    // Gentle pulse so drops read as "shiny", brighter the rarer they are.
    this.tweens.add({
      targets: glow,
      scale: 1.35,
      alpha: 0.25,
      duration: 700,
      yoyo: true,
      repeat: -1,
    });
    this.loot.set(id, { sprite, glow });
  }

  private removeLoot(id: string) {
    const l = this.loot.get(id);
    if (!l) return;
    // Small pop on pickup, then clean up.
    this.tweens.add({
      targets: [l.sprite, l.glow],
      scale: 1.7,
      alpha: 0,
      duration: 180,
      onComplete: () => {
        l.sprite.destroy();
        l.glow.destroy();
      },
    });
    this.loot.delete(id);
  }

  /** Redraw a small floating HP bar above an entity (hidden when full or dead). */
  private drawHpBar(g: Phaser.GameObjects.Graphics, x: number, y: number, hp: number, maxHp: number) {
    g.clear();
    if (hp >= maxHp || hp <= 0) return;
    const w = 12;
    const h = 2;
    const bx = x - w / 2;
    const by = y - TILE / 2 - 5;
    const frac = Math.max(0, Math.min(1, hp / maxHp));
    g.fillStyle(0x000000, 0.6);
    g.fillRect(bx - 1, by - 1, w + 2, h + 2);
    g.fillStyle(0x3a3f4b, 1);
    g.fillRect(bx, by, w, h);
    const col = frac > 0.5 ? 0x7cf36b : frac > 0.25 ? 0xffd65c : 0xff5d73;
    g.fillStyle(col, 1);
    g.fillRect(bx, by, w * frac, h);
  }

  // --- Combat input + feedback -------------------------------------------

  private handleAttackInput(time: number) {
    const want = this.keys.space.isDown || this.attackRequested;
    this.attackRequested = false;
    if (!want || !this.room) return;
    const me = this.entities.get(this.localId);
    if (me && me.hp <= 0) return; // no attacking while dead
    if (time - this.lastAttackAt < ATTACK_COOLDOWN_MS) return;
    this.lastAttackAt = time;
    this.room.send("attack");
    if (me) this.showSwing(me.sprite.x, me.sprite.y);
  }

  private handleHealInput(time: number) {
    const want = Phaser.Input.Keyboard.JustDown(this.keys.q) || this.healRequested;
    this.healRequested = false;
    if (!want || !this.room) return;
    if (time - this.lastHealAt < HEAL_COOLDOWN_MS) return;
    this.lastHealAt = time;
    this.room.send("useHeal"); // server no-ops if there's no charge / we're dead
  }

  /** Show/colour the buff aura under a hero from its active buffs. */
  private updateAura(e: Entity, time: number) {
    const atk = e.atkBuff > 0;
    const def = e.defBuff > 0;
    if (!atk && !def) {
      if (e.aura.visible) e.aura.setVisible(false);
      return;
    }
    const color = atk && def ? 0xc08bff : atk ? 0xff5d73 : 0x4ec9ff;
    e.aura
      .setVisible(true)
      .setFillStyle(color, 0.3)
      .setPosition(e.sprite.x, e.sprite.y)
      .setScale(1 + 0.12 * Math.sin(time / 110));
  }

  /**
   * One-shot strike feedback when a mob lands a hit: a quick scale "chomp" plus
   * a red flash. Position is interpolated each frame in update(), so we animate
   * scale/tint (not position) to avoid fighting that lerp.
   */
  private mobStrike(m: MobEntity) {
    const s = m.sprite;
    this.tweens.killTweensOf(s); // drop any in-flight pop so scale can't compound
    s.setScale(m.baseScale).setTint(0xff5d5d);
    this.tweens.add({
      targets: s,
      scaleX: m.baseScale * 1.3,
      scaleY: m.baseScale * 1.3,
      duration: 90,
      yoyo: true,
      ease: "Quad.easeOut",
      // Reset on the same callback (no stray timer touching a freed sprite if the
      // mob dies mid-animation; removeMob kills the tween before destroying it).
      onComplete: () => s.setScale(m.baseScale).clearTint(),
    });
  }

  /** A quick expanding ring at the hero for attack feedback. */
  private showSwing(x: number, y: number) {
    const ring = this.add
      .circle(x, y, SWING_RADIUS, 0xffffff, 0)
      .setStrokeStyle(2, 0xffffff, 0.85)
      .setDepth(15);
    this.tweens.add({
      targets: ring,
      scale: 1.5,
      alpha: 0,
      duration: 200,
      onComplete: () => ring.destroy(),
    });
  }

  // --- HUD (DOM) ---------------------------------------------------------

  private updateHud(p: PlayerView) {
    const hud = document.getElementById("hud");
    if (hud) hud.hidden = false;

    const fill = document.getElementById("hud-hp-fill");
    if (fill) fill.style.width = `${Math.max(0, Math.min(100, (p.hp / p.maxHp) * 100))}%`;

    // Carried heals: a heart with the stack count, greyed when empty.
    const heal = document.getElementById("hud-heal");
    const healN = document.getElementById("hud-heal-n");
    if (heal) heal.classList.toggle("empty", p.healCharges <= 0);
    if (heal) heal.title = p.healCharges > 0 ? `${p.healCharges} heal(s) — press Q` : "no heals";
    if (healN) healN.textContent = String(p.healCharges);

    this.setBuffChip("hud-atk", p.attackBuff);
    this.setBuffChip("hud-def", p.defenseBuff);
  }

  private setBuffChip(id: string, secs: number) {
    const el = document.getElementById(id);
    if (!el) return;
    if (secs > 0) {
      el.hidden = false;
      const bar = el.querySelector("i") as HTMLElement | null;
      if (bar) bar.style.width = `${Math.max(0, Math.min(100, (secs / BUFF_SECONDS) * 100))}%`;
    } else {
      el.hidden = true;
    }
  }

  /**
   * Pop a transient DOM toast when a hero joins, leaves, or dies. The name is set
   * via textContent (never innerHTML) since player names are user-supplied and
   * only length-trimmed server-side — keep them out of the HTML parser.
   */
  private showToast(name: string, kind: "join" | "leave" | "death") {
    const container = document.getElementById("toasts");
    if (!container) return;

    const suffix =
      kind === "join" ? " entered the dungeon" : kind === "leave" ? " left the dungeon" : " was slain";

    const el = document.createElement("div");
    el.className = `toast ${kind}`;
    const who = document.createElement("span");
    who.className = "who";
    who.textContent = name;
    el.append(who, document.createTextNode(suffix));
    container.appendChild(el);

    // Next frame so the initial (hidden) styles apply before transitioning in.
    requestAnimationFrame(() => el.classList.add("show"));
    window.setTimeout(() => {
      el.classList.remove("show");
      el.addEventListener("transitionend", () => el.remove(), { once: true });
    }, 2600);
  }

  private setDeathOverlay(dead: boolean) {
    if (dead) {
      this.statusText.setText("You died…\nrespawning").setAlign("center").setVisible(true);
    } else {
      this.statusText.setVisible(false);
    }
  }

  private onResize() {
    this.centerStatus();
  }

  /** Keep the status/HUD text centered and at native size despite camera zoom. */
  private centerStatus() {
    const cam = this.cameras.main;
    this.statusText.setPosition(cam.width / 2, cam.height / 2).setScale(1 / cam.zoom);
  }

  private buildMap(data: MapMessage) {
    this.mapLayer.removeAll(true);
    const t = data.tile;

    const worldW = data.width * t;
    const worldH = data.height * t;

    // The world is bigger than the viewport now; bound the camera to it so it
    // never scrolls past the dungeon edges.
    this.cameras.main.setBounds(0, 0, worldW, worldH);

    const grid = data.grid;
    const isWall = (gx: number, gy: number) =>
      gx < 0 || gy < 0 || gx >= data.width || gy >= data.height || grid[gy][gx] === 1;

    for (let y = 0; y < data.height; y++) {
      for (let x = 0; x < data.width; x++) {
        if (!isWall(x, y)) {
          // Floor.
          this.addCell(x * t, y * t, t, FRAME_FLOOR);
          // Shadow the floor just south of a wall, so walls feel like they have height.
          if (isWall(x, y - 1)) {
            const shadow = this.add
              .rectangle(x * t, y * t, t, WALL_SHADOW_H, WALL_SHADOW_COLOR, WALL_SHADOW_ALPHA)
              .setOrigin(0);
            this.mapLayer.add(shadow);
          }
          continue;
        }

        // Wall: pick the brick face/edge/corner tile from Kenney's autotile by
        // which orthogonal neighbors are floor.
        const mask =
          (isWall(x, y - 1) ? 0 : N) |
          (isWall(x + 1, y) ? 0 : E) |
          (isWall(x, y + 1) ? 0 : S) |
          (isWall(x - 1, y) ? 0 : W);
        let frame: number;
        if (mask !== 0) {
          frame = WALL_AUTOTILE[mask];
        } else {
          // No orthogonal floor: a concave corner (floor only on a diagonal)
          // gets a wrapped brick tile; otherwise it's deep rock = brown void.
          const diag =
            (isWall(x - 1, y - 1) ? 0 : DNW) |
            (isWall(x + 1, y - 1) ? 0 : DNE) |
            (isWall(x + 1, y + 1) ? 0 : DSE) |
            (isWall(x - 1, y + 1) ? 0 : DSW);
          frame = WALL_INNER_CORNER[diag] ?? FRAME_VOID;
        }
        this.addCell(x * t, y * t, t, frame);
      }
    }
  }

  /** Add one map tile image to the map layer and return it. */
  private addCell(px: number, py: number, t: number, frame: number) {
    const cell = this.add
      .image(px, py, TILES_KEY, frame)
      .setOrigin(0)
      .setDisplaySize(t, t);
    this.mapLayer.add(cell);
    return cell;
  }

  update(time: number, delta: number) {
    this.sendInput();
    this.handleAttackInput(time);
    this.handleHealInput(time);

    // Smoothly interpolate every entity toward its authoritative position.
    // Frame-rate independent lerp factor.
    const k = 1 - Math.pow(0.001, delta / 1000);
    this.entities.forEach((e) => {
      e.sprite.x = Phaser.Math.Linear(e.sprite.x, e.target.x, k);
      e.sprite.y = Phaser.Math.Linear(e.sprite.y, e.target.y, k);
      e.label.x = e.sprite.x;
      e.label.y = e.sprite.y - LABEL_OFFSET;
      this.drawHpBar(e.hpBar, e.sprite.x, e.sprite.y, e.hp, e.maxHp);
      this.updateAura(e, time);
    });
    this.mobs.forEach((m) => {
      m.sprite.x = Phaser.Math.Linear(m.sprite.x, m.target.x, k);
      m.sprite.y = Phaser.Math.Linear(m.sprite.y, m.target.y, k);
      this.drawHpBar(m.hpBar, m.sprite.x, m.sprite.y, m.hp, m.maxHp);
    });
  }

  private sendInput() {
    if (!this.room) return;
    // Touch joystick intent (from UIScene) is OR'd with the keyboard so either
    // input source can drive the hero.
    const move = this.registry.get(MOVE_INTENT_KEY) as MoveIntent | undefined;
    const state: InputState = {
      up: this.keys.up.isDown || this.keys.w.isDown || !!move?.up,
      down: this.keys.down.isDown || this.keys.s.isDown || !!move?.down,
      left: this.keys.left.isDown || this.keys.a.isDown || !!move?.left,
      right: this.keys.right.isDown || this.keys.d.isDown || !!move?.right,
    };
    const last = this.lastSent;
    if (
      state.up !== last.up ||
      state.down !== last.down ||
      state.left !== last.left ||
      state.right !== last.right
    ) {
      this.room.send("input", state);
      this.lastSent = state;
    }
  }
}
