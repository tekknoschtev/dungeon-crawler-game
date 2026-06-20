import Phaser from "phaser";
import { Room, getStateCallbacks } from "@colyseus/sdk";
import { VIEW_W, VIEW_H, TILE } from "../config";
import { MoveIntent, MOVE_INTENT_KEY } from "./UIScene";

// Tiny Dungeon art (Kenney, CC0). The packed sheet is 16x16 tiles, 12 columns,
// no spacing, so a tile's frame index = row * 12 + column. See ATTRIBUTION.md.
const TILES_KEY = "tiles";
const TILE_SRC = 16; // source tile size in px (we scale up to the world TILE)
const FRAME_FLOOR = 48; // plain stone floor (the common case)
const FRAME_FLOOR_SPECKLE = 49; // subtle pebble/sand debris — same tan base as #48
const FRAME_FLOOR_PAVED = 42; // stone-slab accent (rarer, breaks up large floors)
// Floor tiles that sit directly below a wall use Kenney's own baked top-edge
// shadow gradient (#50, speckled sibling #51) instead of a flat overlay strip —
// the soft gradient grounds the wall more organically. (Corner tile #52 adds a
// right-edge shadow too; unused until we also shade side edges.)
const FRAME_FLOOR_SHADOW = 50; // top-edge shadow (wall to the north)
const FRAME_FLOOR_SHADOW_SPECKLE = 51; // same shadow, with speckle for variety
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

// --- Decorative floor variation ----------------------------------------
// Purely client-side render: each floor tile's texture is chosen by a
// deterministic hash of its (x, y), so every co-op client renders the identical
// floor with nothing added to the synced map. (Solid props are server-owned and
// collidable — they arrive in the "map" message; see buildMap.)
const SPECKLE_CHANCE = 0.12; // floor tiles that get the subtle speckle variant
const PAVED_CHANCE = 0.03; // rarer stone-slab accent tiles
const DECOR_DEPTH = 3; // markers: above floor (mapLayer=0), below loot (5)
// Two gravestone shapes for death markers — a rounded headstone (#64) and a
// rectangular slab (#65). Picked deterministically per marker so every client
// renders the same stone for a given fallen hero.
const FRAME_TOMBSTONES = [64, 65];

/**
 * Deterministic [0, 1) hash of a tile coord plus a salt (so we can make several
 * independent rolls per tile). Stable across clients and reloads — same input,
 * same output — which is what keeps every player's decoration identical.
 */
function tileHash(x: number, y: number, salt: number): number {
  let h = (x * 374761393 + y * 668265263 + salt * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

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
const EXIT_DEPTH = 4; // descent beacon: above the floor, below loot/mobs
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
// Loot icons all come from the Tiny Dungeon sheet (red potion / weapon / shield).
const CATEGORY_FRAME: Record<string, number> = {
  heal: 115, // red potion
  attack: 103, // fallback weapon (shortsword) if a variant is unknown
  defense: 102, // shield
};
// Attack drops are specific weapons — map the synced weapon name (see WEAPONS in
// server tuning.ts) to its Tiny Dungeon sheet frame. Keep names in sync with the
// server table; heavier weapons (broadsword/battleaxe/warhammer) knock mobs back.
const WEAPON_FRAMES: Record<string, number> = {
  shortsword: 103,
  longsword: 104,
  handaxe: 119,
  falchion: 105,
  broadsword: 106,
  battleaxe: 118,
  warhammer: 117,
};
const HEAL_COOLDOWN_MS = 250; // light throttle on the heal action

/** Shapes decoded on the client (mirror the server schema). */
interface PlayerView {
  x: number;
  y: number;
  name: string;
  color: string;
  sprite: number; // Tiny Dungeon frame for this hero's body (tinted by color)
  hp: number;
  maxHp: number;
  healCharges: number; // stacked heal potions on hand
  attackBuff: number; // seconds remaining (> 0 = active)
  defenseBuff: number;
  weapon: string; // equipped weapon name backing the attack buff (HUD icon); "" when none
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
  variant: string; // weapon name for an "attack" drop (see WEAPON_FRAMES); empty otherwise
}

interface MarkerView {
  x: number;
  y: number;
  color: string; // the fallen hero's color
}

interface MapMessage {
  tile: number;
  width: number;
  height: number;
  grid: number[][];
  props: { x: number; y: number; frame: number }[]; // solid furniture (server-placed)
  exit: { x: number; y: number }; // descent point in TILE coords
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
  private markers = new Map<string, Phaser.GameObjects.Image>(); // server-owned tombstones
  private localId = "";

  private mapLayer!: Phaser.GameObjects.Container;
  private statusText!: Phaser.GameObjects.Text;

  // Descent exit: world-space beacon + an off-screen edge arrow pointing to it.
  private exitX = 0;
  private exitY = 0;
  private exitMarker?: Phaser.GameObjects.Container;
  private edgeArrow?: Phaser.GameObjects.Triangle;
  // Throttle the depth/heat HUD so we only touch the DOM when a value changes.
  private lastDepthShown = -1;
  private lastHeatShown = -1;
  // True between the server's "descend" signal and the next floor's map arriving,
  // so buildMap knows to fade back in (the descent swaps floors under black).
  private descending = false;

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

    // Descent: the server signals just before swapping floors, so we fade to black
    // here and fade back in once the next floor's map arrives (see buildMap).
    this.room.onMessage("descend", () => {
      this.descending = true;
      this.cameras.main.fadeOut(250, 0, 0, 0);
    });

    this.localId = this.room.sessionId;
    const $ = getStateCallbacks(this.room);
    const state = this.room.state as {
      players: Map<string, PlayerView>;
      mobs: Map<string, MobView>;
      loot: Map<string, LootView>;
      markers: Map<string, MarkerView>;
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

    // Death markers fire onAdd for ones laid before we joined, so late-joiners see
    // the party's history; the server caps the count and culls oldest-first.
    $(state).markers.onAdd((m: MarkerView, id: string) => this.addMarker(m, id));
    $(state).markers.onRemove((_m: MarkerView, id: string) => this.removeMarker(id));

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
      .image(player.x, player.y, TILES_KEY, player.sprite || FRAME_HERO)
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

  /** Sheet frame for a drop: the weapon's icon for attack, the shield for defense, else the potion. */
  private lootFrame(l: LootView): number {
    if (l.category === "attack") return WEAPON_FRAMES[l.variant] ?? CATEGORY_FRAME.attack;
    return CATEGORY_FRAME[l.category] ?? CATEGORY_FRAME.heal;
  }

  private addLoot(l: LootView, id: string) {
    const color = RARITY_COLORS[l.rarity] ?? RARITY_COLORS.common;
    const glow = this.add
      .circle(l.x, l.y, 9, color, 0.5)
      .setBlendMode(Phaser.BlendModes.ADD)
      .setDepth(LOOT_GLOW_DEPTH);
    const sprite = this.add
      .image(l.x, l.y, TILES_KEY, this.lootFrame(l))
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

  /**
   * Render a death marker (server-owned tombstone) tinted to the fallen hero's
   * color, with a brief settle-in pop. onAdd also replays markers laid before we
   * joined, so late-joiners see the party's history.
   */
  private addMarker(m: MarkerView, id: string) {
    const colorNum = Phaser.Display.Color.HexStringToColor(m.color).color;
    const frame = FRAME_TOMBSTONES[tileHash(m.x, m.y, 2) < 0.5 ? 0 : 1];
    const stone = this.add
      .image(m.x, m.y, TILES_KEY, frame)
      .setDisplaySize(TILE, TILE)
      .setTint(colorNum)
      .setDepth(DECOR_DEPTH);

    const baseScale = stone.scaleX;
    stone.setScale(baseScale * 0.3);
    this.tweens.add({
      targets: stone,
      scaleX: baseScale,
      scaleY: baseScale,
      duration: 220,
      ease: "Back.easeOut",
    });

    this.markers.set(id, stone);
  }

  private removeMarker(id: string) {
    const stone = this.markers.get(id);
    if (!stone) return;
    this.tweens.killTweensOf(stone);
    stone.destroy();
    this.markers.delete(id);
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

    this.setBuffChip("hud-atk", p.attackBuff, p.weapon);
    this.setBuffChip("hud-def", p.defenseBuff);
  }

  /**
   * Show/hide a buff chip and refresh its countdown. `weapon` (attack chip only)
   * swaps in the equipped weapon's sheet icon. The depleting bar measures against
   * the buff's *own* full length — remembered as the peak seconds seen this span
   * (data-full) — so weapons of any duration drain accurately without the client
   * having to mirror each one's length.
   */
  private setBuffChip(id: string, secs: number, weapon?: string) {
    const el = document.getElementById(id);
    if (!el) return;
    if (secs <= 0) {
      el.hidden = true;
      delete el.dataset.full; // reset peak so the next buff measures itself afresh
      return;
    }
    el.hidden = false;

    let full = Number(el.dataset.full ?? 0);
    if (secs > full) {
      full = secs;
      el.dataset.full = String(full);
    }
    const bar = el.querySelector("i") as HTMLElement | null;
    if (bar) bar.style.width = `${Math.max(0, Math.min(100, (secs / full) * 100))}%`;
    const label = el.querySelector("b") as HTMLElement | null;
    if (label) label.textContent = `${Math.ceil(secs)}`;

    if (weapon !== undefined) {
      const icon = el.querySelector(".wpn") as HTMLElement | null;
      if (icon) {
        const frame = WEAPON_FRAMES[weapon] ?? CATEGORY_FRAME.attack;
        icon.style.backgroundPosition = `-${(frame % 12) * 20}px -${Math.floor(frame / 12) * 20}px`;
        el.title = weapon ? `${weapon} — ${Math.ceil(secs)}s` : "";
      }
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
          // Floor — deterministic texture variation so large floors don't read flat.
          // A tile directly below a wall uses the baked top-edge shadow tile so the
          // wall reads as having height; the gradient replaces the old flat strip.
          let floorFrame: number;
          if (isWall(x, y - 1)) {
            floorFrame =
              tileHash(x, y, 1) < SPECKLE_CHANCE ? FRAME_FLOOR_SHADOW_SPECKLE : FRAME_FLOOR_SHADOW;
          } else {
            const v = tileHash(x, y, 0);
            floorFrame =
              v < PAVED_CHANCE
                ? FRAME_FLOOR_PAVED
                : v < PAVED_CHANCE + SPECKLE_CHANCE
                  ? FRAME_FLOOR_SPECKLE
                  : FRAME_FLOOR;
          }
          const cell = this.addCell(x * t, y * t, t, floorFrame);
          // The speckle tile is non-directional debris, so mirror/rotate it for
          // extra variety — turns one frame into 8 orientations with no seams.
          if (floorFrame === FRAME_FLOOR_SPECKLE) this.orientDecor(cell, x, y, t);
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

    // Solid props (server-placed, collidable). Drawn last so they sit on top of
    // the floor; they share the floor's depth (mapLayer) so heroes pass in front
    // — but the server blocks the tile, so heroes never actually overlap them.
    for (const p of data.props) {
      this.addCell(p.x * t, p.y * t, t, p.frame);
    }

    // Descent beacon. buildMap re-runs on every floor (the server re-sends "map"
    // on descend), so rebuild the marker each time at the new exit.
    this.exitX = data.exit.x * t + t / 2;
    this.exitY = data.exit.y * t + t / 2;
    this.buildExitMarker(t);

    // If this map arrived from a descent, the swap happened under black. Snap the
    // heroes + camera onto their new spawns so the reveal doesn't show them sliding
    // in from their old-floor spots, hold black briefly to let the position patch
    // settle, then fade the new floor in. (No-op on floor 1, where descending=false.)
    if (this.descending) {
      this.descending = false;
      this.snapHeroesToTargets();
      this.time.delayedCall(180, () => {
        this.snapHeroesToTargets(); // catch the spawn patch if it landed just after
        this.cameras.main.fadeIn(600, 0, 0, 0);
      });
    }
  }

  /**
   * Place every hero sprite (and the camera) exactly on its target. Used on a
   * floor swap so the fade-in reveals everyone already in place rather than the
   * normal update() lerp sliding them across the new floor.
   */
  private snapHeroesToTargets() {
    this.entities.forEach((e) => {
      e.sprite.x = e.target.x;
      e.sprite.y = e.target.y;
      e.label.x = e.sprite.x;
      e.label.y = e.sprite.y - LABEL_OFFSET;
    });
    const me = this.entities.get(this.localId);
    if (me) this.cameras.main.centerOn(me.sprite.x, me.sprite.y);
  }

  /**
   * The descent point: a trapdoor opening into a ladder shaft, composed from
   * shapes (Tiny Dungeon has no stairs tile). Rebuilt per floor; a soft torch-lit
   * glow pulses so it's findable without reading like a UI arrow.
   */
  private buildExitMarker(t: number) {
    this.exitMarker?.destroy();
    const glow = this.add.circle(0, 0, t * 0.72, 0xffb24d, 0.14);
    const g = this.add.graphics();
    const r = t * 0.42;
    const lw = Math.max(1, t * 0.07);
    // Dark shaft opening with a wooden lip (the open trapdoor).
    g.fillStyle(0x0d0b09, 1).fillRoundedRect(-r, -r, r * 2, r * 2, 3);
    g.lineStyle(Math.max(1, t * 0.09), 0x6b4a2b, 1).strokeRoundedRect(-r, -r, r * 2, r * 2, 3);
    // Ladder rails + rungs descending into the dark (lower rungs dimmer = depth).
    const railX = t * 0.16;
    g.lineStyle(lw, 0xc79a5b, 1);
    g.lineBetween(-railX, -r * 0.7, -railX, r * 0.85);
    g.lineBetween(railX, -r * 0.7, railX, r * 0.85);
    for (const rung of [
      { y: -r * 0.35, color: 0xd9b072 },
      { y: r * 0.05, color: 0xb07a45 },
      { y: r * 0.45, color: 0x7a5230 },
    ]) {
      g.lineStyle(lw, rung.color, 1).lineBetween(-railX, rung.y, railX, rung.y);
    }
    const cont = this.add.container(this.exitX, this.exitY, [glow, g]).setDepth(EXIT_DEPTH);
    this.exitMarker = cont;
    this.tweens.add({
      targets: glow,
      alpha: { from: 0.22, to: 0.07 },
      duration: 1100,
      yoyo: true,
      repeat: -1,
      ease: "Sine.inOut",
    });

    // The off-screen wayfinder arrow (created once, reused across floors).
    if (!this.edgeArrow) {
      this.edgeArrow = this.add
        .triangle(0, 0, 0, -11, 9, 9, -9, 9, 0xffb24d, 0.95)
        .setScrollFactor(0)
        .setDepth(HUD_DEPTH)
        .setVisible(false);
    }
  }

  /** Update the Floor/heat readout (throttled to actual changes). */
  private updateRunHud() {
    const st = this.room?.state as { depth?: number; heat?: number } | undefined;
    if (!st) return;
    const depth = st.depth ?? 1;
    if (depth !== this.lastDepthShown) {
      this.lastDepthShown = depth;
      const el = document.getElementById("run-depth");
      if (el) el.textContent = `Floor ${depth}`;
      const hud = document.getElementById("run-hud");
      if (hud) hud.hidden = false;
    }
    const pct = Math.round((st.heat ?? 0) * 100);
    if (pct !== this.lastHeatShown) {
      this.lastHeatShown = pct;
      const fill = document.getElementById("run-heat-fill");
      if (fill) fill.style.width = `${pct}%`;
    }
  }

  /**
   * Point the player toward the exit: a "hold to descend" hint when standing on
   * it, and a screen-edge arrow toward it while it's off-camera.
   */
  private updateExitNudge() {
    const me = this.entities.get(this.localId);
    const hint = document.getElementById("descend-hint");
    if (!me || !this.edgeArrow) {
      this.edgeArrow?.setVisible(false);
      if (hint) hint.hidden = true;
      return;
    }

    const onExit = Phaser.Math.Distance.Between(me.sprite.x, me.sprite.y, this.exitX, this.exitY) <= 16;
    if (hint) hint.hidden = !onExit;

    const cam = this.cameras.main;
    const view = cam.worldView;
    if (view.contains(this.exitX, this.exitY)) {
      this.edgeArrow.setVisible(false);
      return;
    }
    // Exit is off-camera → pin an arrow to the screen edge, aimed at it.
    const cx = cam.width / 2;
    const cy = cam.height / 2;
    const sx = ((this.exitX - view.x) / view.width) * cam.width;
    const sy = ((this.exitY - view.y) / view.height) * cam.height;
    const ang = Math.atan2(sy - cy, sx - cx);
    const px = cx + Math.cos(ang) * (cx - 46);
    const py = cy + Math.sin(ang) * (cy - 46);
    this.edgeArrow.setVisible(true).setPosition(px, py).setRotation(ang + Math.PI / 2);
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

  /**
   * Give a non-directional decor tile (the speckle floor) a random orientation,
   * stable per (x, y) so every client matches. A square tile rotates cleanly
   * about its centre; combined with a flip that's 8 distinct looks from one frame.
   */
  private orientDecor(cell: Phaser.GameObjects.Image, gx: number, gy: number, t: number) {
    const turns = Math.floor(tileHash(gx, gy, 3) * 4); // 0..3 quarter-turns
    cell
      .setOrigin(0.5)
      .setPosition(gx * t + t / 2, gy * t + t / 2)
      .setAngle(turns * 90);
    if (tileHash(gx, gy, 4) < 0.5) cell.setFlipX(true);
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

    this.updateRunHud();
    this.updateExitNudge();
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
