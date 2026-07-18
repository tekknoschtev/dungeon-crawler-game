import Phaser from "phaser";
import { Room, getStateCallbacks } from "@colyseus/sdk";
import { VIEW_W, VIEW_H, TILE, RECONNECT_KEY } from "../config";
import { MoveIntent, MOVE_INTENT_KEY, BOMB_COUNT_KEY } from "./UIScene";
// Local codex + personal bests (M14): the browser's memory of every run, and
// what makes a "NEW" badge / best-flash on the score screen mean something.
import { recordRunEnd, RunRecordResult } from "../codex";

// Tiny Dungeon art (Kenney, CC0). The packed sheet is 16x16 tiles, 12 columns,
// no spacing, so a tile's frame index = row * 12 + column. See ATTRIBUTION.md.
const TILES_KEY = "tiles";
// Tiny Town art (Kenney, CC0) — used only for the vault-key sprite that pops out
// of a smashed key crate. Same 16x16 grid but 12 columns; key is frame #117.
const TOWN_KEY = "town";
const FRAME_KEY = 117;
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

// --- Depth biomes (M15) -------------------------------------------------
// The server names a biome per floor ("map" message); geometry renders from
// that biome's sheet — a full clone of the packed sheet with the wall/floor
// kit re-derived, so every frame index matches. Sprites (heroes/mobs/loot/
// props) keep TILES_KEY: their frames are identical across clones.
const BIOME_TEXTURES: Record<string, string> = {
  overgrown: "tiles-overgrown",
  crypt: "tiles-crypt",
};
// Anti-tiling wall variants (extension row, fixed contract with
// assets-src/biomes/build_biomes.py): alternate detail rolls of the brick
// face (#40) and back edge (#26), hash-picked per map tile so long wall runs
// don't wallpaper. Only biome sheets carry the extension row.
const WALL_VARIANTS: Record<number, number[]> = {
  40: [40, 132, 133, 134],
  26: [26, 135, 136],
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

// --- Dark-floor lighting (see updateDarkness) ---------------------------
// A hero's light: full brightness within INNER, fading linearly to black at OUTER.
// Sized against CAMERA_ZOOM=2 (visible world ≈400px wide) so the bubble fills a
// good chunk of the view while leaving dark margins to creep into.
const LIGHT_INNER = 2 * 16; // px fully lit around a hero (small core → most of the bubble is a gradient)
const LIGHT_OUTER = 6.5 * 16; // px where the light fades to nothing
const EXPLORED_DIM = 0.075; // alpha of remembered geometry once out of the light: a faint ghost
// of the layout — just enough to keep your bearings without lifting the oppressive dark.
const LIGHT_VISIBLE_AT = 0.04; // min light for a mob/loot/crate to show (the ambush edge)
const BACKDROP_DEPTH = -10; // black void behind the map on dark floors
// Static wall torches (torchlit floors): always-on light pools, smaller than a
// hero's mobile bubble — a fixed sconce lights a room corner, not a whole room.
// The gaps between them stay dark on purpose (that's where secrets hide).
const FRAME_TORCH = 125; // Tiny Dungeon item that reads as a torch on a front-facing wall
const TORCH_LIGHT_INNER = 1 * 16; // px fully lit at the flame
const TORCH_LIGHT_OUTER = 4.5 * 16; // px the pool reaches (vs a hero's 6.5)
const TORCH_SPRITE_DEPTH = 2; // the torch sits above the wall it's mounted on
// Each light source tints the tiles it dominates toward its own color, blended
// per-tile (blocky, matching the alpha steps — no smooth glow overlay), capped at a
// per-source strength so geometry stays readable. Torches tint warm amber; heroes
// tint subtly toward their player color (you read teammates by their glow); a downed
// hero's distress beacon tints danger-red.
const TORCH_TINT_COLOR = 0xffb060; // warm amber
const TORCH_TINT_MAX = 0.55;
// A hero's own light stays neutral (your view is true-color); teammates' light picks
// up a *subtle* hint of their player color so you can tell whose bubble is whose.
const HERO_LIGHT_TINT_MAX = 0.16;
// Downed-teammate distress beacon: a small, faint pool of danger-red light at a
// downed hero (vs their full light going out), so a pitch-black revive run reveals
// the swarm on them — "spot the glow, fight to it." Smaller even than a torch.
const DISTRESS_LIGHT_INNER = 0.5 * 16;
const DISTRESS_LIGHT_OUTER = 2.6 * 16;
const DISTRESS_TINT_COLOR = 0xff5a3c; // hot red-orange
const DISTRESS_TINT_MAX = 0.5;
const DISTRESS_GLOW_RADIUS = 13; // px; the pulsing ember drawn on the prone hero
const DISTRESS_GLOW_DEPTH = 9; // under the hero (depth 10), like the buff aura
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
const FRAME_SLIME = 108; // Tiny Dungeon green slime (fallback for unknown kinds)
// Mob kind → Tiny Dungeon sheet frame (M5). Mirrors the server MOBS table in
// tuning.ts — keep the names in sync. The server picks the kind (depth-gated
// spawn mix); the client only renders the matching sprite for the synced kind.
const MOB_FRAMES: Record<string, number> = {
  slime: 108,
  rat: 124,
  bat: 120,
  crab: 110,
  imp: 109,
  spider: 122,
  ghost: 121,
};
const MOB_DEPTH = 8; // mobs render just under heroes (depth 10)
const LOOT_DEPTH = 5;
const EXIT_DEPTH = 4; // descent beacon: above the floor, below loot/mobs
const EXIT_TEXTURE = "descent-ladder"; // custom 16×16 ladder/hatch sprite (client/public/assets/custom)
const EXIT_PULSE_RADIUS = 40; // px — mirrors server EXIT_PULSE_RADIUS (ward ring size)
const EXIT_PULSE_COLOR = 0x9ffff0; // teal, matching the descent hint
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
// Mirrors the server's REVIVE_RANGE (tuning.ts) — used only to surface the
// contextual "revive" hint; the server is authoritative on the actual revive.
const REVIVE_RANGE = 18; // px

// --- Vault chest (M4) --------------------------------------------------
const FRAME_CHEST = 89; // Tiny Dungeon closed chest (gold-trimmed)
// Door open sequence (Tiny Dungeon): closed → ajar → open, played on unlock.
const FRAME_DOOR_CLOSED = 45;
const FRAME_DOOR_HALF = 33;
const FRAME_DOOR_OPEN = 21;
const CHEST_DEPTH = 5; // chest sits at loot level
const DOOR_DEPTH = 6; // gate just above the chest
const CHEST_GLOW_DEPTH = 4;
const CHEST_COLOR = 0xffd65c; // gold — the chest glow, beacon, and nudge arrow
const CHEST_LOCKED_TINT = 0x70707a; // dimmed while sealed; clears on unlock
// Mirrors the server's SCORE_MULT_MAX (tuning.ts) — drives the displayed score
// multiplier (×1 calm → ×max at full heat); the server owns the actual scoring.
const SCORE_MULT_MAX = 3;

// --- Collectible bomb (M10) --------------------------------------------
// The bomb art is the Tiny Town sheet (TOWN_KEY), frame 105. The server owns the
// fuse, blast, and stun; these mirror its tuning only to drive client feedback
// (the warning flash, the explosion ring size, the stun tint on mobs).
const FRAME_BOMB = 105; // Tiny Town bomb tile
const BOMB_DEPTH = 5; // sits at loot level
const BOMB_FUSE = 1.2; // s — mirrors server BOMB_FUSE (warning-flash timing)
const BOMB_BLAST_RADIUS = 45; // px — mirrors server BOMB_BLAST_RADIUS (explosion ring)
const BOMB_STUN_TINT = 0x6fb7ff; // cyan wash on stunned mobs

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
  bombs: number; // carried bombs (M10)
  attackBuff: number; // seconds remaining (> 0 = active)
  defenseBuff: number;
  weapon: string; // equipped weapon name backing the attack buff (HUD icon); "" when none
  downed: boolean; // hp<=0, awaiting self-respawn or a revive (rendered greyed/prone)
  respawnsLeft: number; // lives remaining (0 = revive-only)
  respawnIn: number; // seconds until the self-respawn button unlocks (0 = ready / N/A)
  score: number; // live run score (banked floors + current floor's un-banked gain)
  relics: string[]; // procedurally-named vault trophies (score-screen flavor)
}

interface MobView {
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  kind: string;
  attackTick: number; // bumps each time the mob lands a hit (strike animation cue)
  stunned: boolean; // frozen by a bomb blast (M10) — rendered with a cyan wash
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

interface ChestView {
  x: number;
  y: number;
  doorX: number; // sealing door TILE coords, or (-1,-1) for the magic-seal fallback
  doorY: number;
  locked: boolean;
  unlockIn: number; // seconds until the door opens (drives the countdown)
  hp: number;
  maxHp: number;
}

interface CrateView {
  x: number;
  y: number;
  frame: number;
  hp: number;
  maxHp: number;
}

interface BombView {
  x: number;
  y: number;
  fuse: number; // seconds left until detonation (drives the warning flash)
}

/** A hero's run discoveries (M13), shipped once in the "gameover" payload —
 *  mirrors the server's RunTally (DungeonRoom.ts). */
interface RunTally {
  kills: Record<string, number>; // mob kind → kills this run
  weapons: string[]; // distinct weapons wielded, in first-held order
  loot: Record<string, number>; // scored pickups by rarity (bombs excluded)
  crates: number; // crates smashed
  chests: number; // vault chests cracked open
}

interface MapMessage {
  tile: number;
  width: number;
  height: number;
  grid: number[][];
  props: { x: number; y: number; frame: number }[]; // static furniture (server-placed)
  exit: { x: number; y: number }; // descent point in TILE coords
  lighting?: "bright" | "dark" | "torchlit"; // "dark"/"torchlit" → render the vision bubble
  biome?: string; // depth biome (M15) — picks the geometry tile sheet
  torches?: { x: number; y: number }[]; // wall-torch tiles (torchlit floors); static light pools
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
  color: number; // the hero's tint, restored when they're revived
  downed: boolean; // greyed/prone while awaiting respawn or revive
  distress?: Phaser.GameObjects.Arc; // pulsing distress beacon while downed on a dark floor
}

interface MobEntity {
  sprite: Phaser.GameObjects.Image;
  hpBar: Phaser.GameObjects.Graphics;
  target: { x: number; y: number };
  hp: number;
  maxHp: number;
  baseScale: number; // sprite scale at rest, so the strike pop can return to it
  attackTick: number; // last-seen server strike counter
  stunned: boolean; // last-seen stun state, so we only re-tint on the transition
}

interface LootEntity {
  sprite: Phaser.GameObjects.Image;
  glow: Phaser.GameObjects.Arc;
}

interface ChestEntity {
  sprite: Phaser.GameObjects.Image; // the chest
  glow: Phaser.GameObjects.Arc; // gold beacon under it (also the on-screen findability)
  door?: Phaser.GameObjects.Image; // closed gate while locked (real-door case)
  seal?: Phaser.GameObjects.Arc; // shimmer ring for the magic-seal fallback (no door)
  countdown: Phaser.GameObjects.Text; // "0:43" while locked
  hpBar: Phaser.GameObjects.Graphics; // break progress once unlocked
  worldX: number; // chest world position (for the off-screen nudge arrow)
  worldY: number;
  locked: boolean;
  unlockIn: number;
  hp: number;
  maxHp: number;
}

interface BombEntity {
  sprite: Phaser.GameObjects.Image;
  glow: Phaser.GameObjects.Arc; // pulsing warning aura, accelerated by the fuse
}

interface InputState {
  up: boolean;
  down: boolean;
  left: boolean;
  right: boolean;
}

/** Any display object the dark-floor pass can show/hide (images, arcs, text, graphics). */
type Dimmable = Phaser.GameObjects.GameObject & { setVisible(v: boolean): unknown };

export class GameScene extends Phaser.Scene {
  private room?: Room;
  private entities = new Map<string, Entity>();
  private mobs = new Map<string, MobEntity>();
  private loot = new Map<string, LootEntity>();
  private chests = new Map<string, ChestEntity>(); // per-floor vault (one entry)
  private crates = new Map<string, Phaser.GameObjects.Image>(); // breakable props
  private bombs = new Map<string, BombEntity>(); // placed, ticking bombs (M10)
  private markers = new Map<string, Phaser.GameObjects.Image>(); // server-owned tombstones
  private localId = "";

  private mapLayer!: Phaser.GameObjects.Container;
  private statusText!: Phaser.GameObjects.Text;

  // Descent exit: world-space beacon + an off-screen edge arrow pointing to it.
  private exitX = 0;
  private exitY = 0;
  private exitMarker?: Phaser.GameObjects.Container;
  private edgeArrow?: Phaser.GameObjects.Triangle;
  // Off-screen wayfinder to the vault (gold), with a countdown chip while sealed.
  private chestArrow?: Phaser.GameObjects.Triangle;
  private chestArrowLabel?: Phaser.GameObjects.Text;
  // Throttle the depth/heat HUD so we only touch the DOM when a value changes.
  private lastDepthShown = -1;
  private lastHeatShown = -1;
  private lastScoreShown = -1;
  private lastPartyShown = -1;
  private lastMultShown = -1;
  // True between the server's "descend" signal and the next floor's map arriving,
  // so buildMap knows to fade back in (the descent swaps floors under black).
  private descending = false;
  // Per-player run discoveries from the last "gameover" message (M13), keyed by
  // sessionId; null outside the wipe score screen (a voluntary exit has none).
  private runTallies: Record<string, RunTally> | null = null;
  // Texture key map geometry draws from — the current floor's biome sheet
  // (M15); TILES_KEY (stone) until a "map" message says otherwise.
  private mapTilesKey: string = TILES_KEY;
  // The codex fold-in for the run that just ended (M14): prev snapshot (drives
  // the NEW badges) + which personal bests broke. Set once per run end — it
  // doubles as the "already recorded" guard — and cleared with runTallies.
  private codexResult: RunRecordResult | null = null;

  // --- Dark-floor vision (server-rolled "dark" lighting) ------------------
  // When true, the floor renders only what a hero's light reaches: geometry you've
  // walked past lingers dim (explored memory), but mobs/loot/crates stay hidden
  // until lit. All per-frame, client-only — the server still sends everything.
  private darkFloor = false;
  // Every geometry tile (floor/wall/void/prop) with its world-space center, so
  // updateDarkness can alpha each by distance to the nearest light. Rebuilt per floor.
  private darkCells: { obj: Phaser.GameObjects.Image; cx: number; cy: number; key: string }[] = [];
  // Tile keys ("cx,cy") a light has touched this floor — they stay dimly visible after.
  private explored = new Set<string>();
  // The ladder is hidden until a hero's light first reaches it, then stays shown.
  private exitDiscovered = false;
  // Solid black world backdrop so unlit (alpha-0) tiles read as void, not canvas bg.
  private darkBackdrop?: Phaser.GameObjects.Rectangle;
  // Light origins for the current frame: hero positions (rebuilt each pass) plus the
  // floor's static torches. Each carries its own inner/outer radius (a torch pool is
  // smaller than a hero's bubble) and a tint+strength — the color the tiles it
  // dominates blend toward (white/strength-0 = neutral).
  private lightSources: { x: number; y: number; inner: number; outer: number; tint: number; strength: number }[] = [];
  // Torchlit floors: always-on torch light pools (world coords, offset into the room),
  // rebuilt per floor. Appended to lightSources every frame so the pools never move.
  private torchLights: { x: number; y: number; inner: number; outer: number; tint: number; strength: number }[] = [];
  // Torch sprites and their flicker tweens, torn down per floor.
  private torchObjs: Phaser.GameObjects.GameObject[] = [];
  private torchTweens: Phaser.Tweens.Tween[] = [];

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
    e: Phaser.Input.Keyboard.Key;
  };
  private lastSent: InputState = { up: false, down: false, left: false, right: false };
  private lastAttackAt = 0; // client-side attack throttle (ms)
  private attackRequested = false; // set by the touch attack button (UIScene)
  private lastHealAt = 0; // client-side heal throttle (ms)
  private healRequested = false; // set by the touch heal button (UIScene)
  private localHealCharges = 0; // mirror of the local hero's heal stack (revive-hint gate)
  private bombRequested = false; // set by the touch bomb button (UIScene)

  constructor() {
    super("game");
  }

  preload() {
    this.load.spritesheet(TILES_KEY, "/assets/tiny-dungeon/tilemap_packed.png", {
      frameWidth: TILE_SRC,
      frameHeight: TILE_SRC,
    });
    // Biome sheets (M15): full clones of the packed sheet with the wall/floor
    // kit re-derived per biome (see docs/biome-art-plan.md) plus an extension
    // row of anti-tiling wall variants. Same grid, so frame indices line up.
    this.load.spritesheet(BIOME_TEXTURES.overgrown, "/assets/tiny-dungeon/tilemap_overgrown.png", {
      frameWidth: TILE_SRC,
      frameHeight: TILE_SRC,
    });
    this.load.spritesheet(BIOME_TEXTURES.crypt, "/assets/tiny-dungeon/tilemap_crypt.png", {
      frameWidth: TILE_SRC,
      frameHeight: TILE_SRC,
    });
    this.load.spritesheet(TOWN_KEY, "/assets/tiny-town/tilemap_packed.png", {
      frameWidth: TILE_SRC,
      frameHeight: TILE_SRC,
    });
    this.load.image(EXIT_TEXTURE, "/assets/custom/descent-ladder.png");
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
      e: kb.addKey(Phaser.Input.Keyboard.KeyCodes.E),
    };
    kb.addCapture("SPACE"); // don't let Space scroll/trigger page defaults

    // Parallel scene that feeds touch movement into the registry (mobile).
    this.scene.launch("ui");

    // Attack/heal: keyboard (Space / Q) on desktop, or the UIScene touch buttons,
    // which fire game-level events so UIScene stays Colyseus-free.
    this.game.events.on("attack", this.onAttackRequest, this);
    this.game.events.on("useHeal", this.onHealRequest, this);
    this.game.events.on("useBomb", this.onBombRequest, this);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.game.events.off("attack", this.onAttackRequest, this);
      this.game.events.off("useHeal", this.onHealRequest, this);
      this.game.events.off("useBomb", this.onBombRequest, this);
    });

    // Run-stakes buttons (plain DOM, outside the canvas). The server validates
    // both — respawn only fires when down + unlocked, restart only at game-over.
    document
      .getElementById("respawn-btn")
      ?.addEventListener("click", () => this.room?.send("respawn"));
    document
      .getElementById("restart-btn")
      ?.addEventListener("click", () => this.room?.send("restart"));

    // Voluntary exit: X button (mobile/desktop) or Esc → confirm → leave the run.
    document.getElementById("exit-btn")?.addEventListener("click", () => this.requestExit());
    document
      .getElementById("exit-cancel-btn")
      ?.addEventListener("click", () => this.dismissExitConfirm());
    document.getElementById("exit-leave-btn")?.addEventListener("click", () => this.confirmExit());
    document.getElementById("backmenu-btn")?.addEventListener("click", () => this.backToMenu());
    // Esc toggles the confirm (open if hidden, dismiss if already up).
    kb.on("keydown-ESC", () => {
      const confirm = document.getElementById("exit-confirm");
      if (confirm && !confirm.hidden) this.dismissExitConfirm();
      else this.requestExit();
    });

    this.setupRoom();
  }

  private onAttackRequest() {
    this.attackRequested = true;
  }

  private onHealRequest() {
    this.healRequested = true;
  }

  private onBombRequest() {
    this.bombRequested = true;
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
    this.setExitButtonVisible(true); // in-game now — offer the leave button

    this.room.onMessage<MapMessage>("map", (data) => this.buildMap(data));

    // Descent: the server signals just before swapping floors, so we fade to black
    // here and fade back in once the next floor's map arrives (see buildMap).
    this.room.onMessage("descend", () => {
      this.descending = true;
      this.cameras.main.fadeOut(250, 0, 0, 0);
    });

    // The party wiped — show the game-over score screen with the floor reached
    // and each hero's run discoveries (M13). Restart (wired in create) sends "restart".
    this.room.onMessage<{ floor: number; tallies?: Record<string, RunTally> }>(
      "gameover",
      ({ floor, tallies }) => {
        this.runTallies = tallies ?? null;
        this.recordLocalRunEnd(floor); // fold into the local codex BEFORE rendering
        this.setGameOverOverlay(true, floor);
      }
    );

    // A teammate (or you) cracked the vault — gold toast naming the relic.
    this.room.onMessage<{ name: string; who: string }>("relic", ({ name, who }) => {
      this.showRelicToast(who, name);
    });

    // Someone smashed the key crate — vault door opened. Pop the key out of the
    // crate's spot, then announce it in a toast.
    this.room.onMessage<{ name: string; x: number; y: number }>("key_found", ({ name, x, y }) => {
      this.playKeyPop(x, y);
      this.showKeyFoundToast(name);
    });

    // The descent stairs warded a hero who's channeling (M11) — ring the ladder.
    // The mobs' stagger rides their synced `stunned` tint, so no extra work here.
    this.room.onMessage<{ x: number; y: number }>("exit_pulse", ({ x, y }) => {
      this.playExitPulse(x, y);
    });

    this.localId = this.room.sessionId;
    const $ = getStateCallbacks(this.room);
    const state = this.room.state as {
      players: Map<string, PlayerView>;
      mobs: Map<string, MobView>;
      loot: Map<string, LootView>;
      chests: Map<string, ChestView>;
      crates: Map<string, CrateView>;
      bombs: Map<string, BombView>;
      markers: Map<string, MarkerView>;
      phase: string;
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
          // Standing -> down transition: announce the fall in the feed (our own
          // fall also raises the center overlay below).
          if (!e.downed && player.downed) this.showToast(player.name, "death");
          const downedChanged = e.downed !== player.downed;
          e.target.x = player.x;
          e.target.y = player.y;
          e.hp = player.hp;
          e.maxHp = player.maxHp;
          e.atkBuff = player.attackBuff;
          e.defBuff = player.defenseBuff;
          e.downed = player.downed;
          if (downedChanged) this.applyDownedLook(e);
        }
        if (isLocal) {
          this.updateHud(player);
          this.updateDownedOverlay(player);
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
        if (e.distress) this.tweens.killTweensOf(e.distress);
        e.distress?.destroy();
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
          // Bomb stun (M10): wash the mob cyan while frozen, clear it when it wears
          // off. Only on the transition so the strike-flash tween isn't fought.
          if (mob.stunned !== m.stunned) {
            m.stunned = mob.stunned;
            if (mob.stunned) m.sprite.setTint(BOMB_STUN_TINT);
            else m.sprite.clearTint();
          }
        }
      });
    });
    $(state).mobs.onRemove((_mob: MobView, id: string) => this.removeMob(id));

    $(state).loot.onAdd((l: LootView, id: string) => this.addLoot(l, id));
    $(state).loot.onRemove((_l: LootView, id: string) => this.removeLoot(id));

    // The per-floor vault: one entry, re-armed each descent. onChange drives the
    // unlock countdown, the locked→open door reveal, and the break HP bar.
    $(state).chests.onAdd((ch: ChestView, id: string) => {
      this.addChest(ch, id);
      $(ch).onChange(() => this.updateChest(ch, id));
    });
    $(state).chests.onRemove((_ch: ChestView, id: string) => this.removeChest(id));

    // Breakable crates: rendered like static props but tracked so they can
    // shatter when the server destroys them. onChange flashes on damage.
    $(state).crates.onAdd((c: CrateView, id: string) => {
      const img = this.add.image(c.x, c.y, TILES_KEY, c.frame).setDepth(DECOR_DEPTH);
      this.crates.set(id, img);
      $(c).onChange(() => {
        const sprite = this.crates.get(id);
        if (!sprite) return;
        sprite.setTint(0xff6644);
        this.time.delayedCall(120, () => { if (sprite.active) sprite.clearTint(); });
      });
    });
    $(state).crates.onRemove((_c: CrateView, id: string) => {
      const img = this.crates.get(id);
      if (!img) return;
      this.crates.delete(id);
      this.tweens.add({
        targets: img,
        scale: 1.6,
        alpha: 0,
        duration: 180,
        onComplete: () => img.destroy(),
      });
    });

    // Placed bombs (M10): a ticking sprite with a warning flash that quickens as
    // the fuse runs down. onRemove is the detonation — explosion burst + a kick.
    $(state).bombs.onAdd((b: BombView, id: string) => {
      this.addBomb(b, id);
      $(b).onChange(() => this.updateBomb(b, id));
    });
    $(state).bombs.onRemove((_b: BombView, id: string) => this.removeBomb(id));

    // Death markers fire onAdd for ones laid before we joined, so late-joiners see
    // the party's history; the server caps the count and culls oldest-first.
    $(state).markers.onAdd((m: MarkerView, id: string) => this.addMarker(m, id));
    $(state).markers.onRemove((_m: MarkerView, id: string) => this.removeMarker(id));

    // Phase drives the game-over overlay. The "gameover" message raises it (with
    // the floor reached); this just clears it when a restart returns to "playing".
    $(state).listen("phase", (phase: string) => {
      if (phase === "playing") this.setGameOverOverlay(false);
    });

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
      color: colorNum,
      downed: player.downed,
    });
    this.applyDownedLook(this.entities.get(sessionId)!);

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
    const frame = MOB_FRAMES[mob.kind] ?? FRAME_SLIME;
    const sprite = this.add
      .image(mob.x, mob.y, TILES_KEY, frame)
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
      stunned: mob.stunned, // seed so an already-stunned mob renders washed on spawn
    });
    if (mob.stunned) sprite.setTint(BOMB_STUN_TINT);
  }

  private removeMob(id: string) {
    const m = this.mobs.get(id);
    if (!m) return;
    this.tweens.killTweensOf(m.sprite); // cancel a mid-strike pop before freeing
    m.sprite.destroy();
    m.hpBar.destroy();
    this.mobs.delete(id);
  }

  /** Sheet + frame for a drop: bombs come off the Tiny Town sheet (matching the
   *  placed-bomb sprite); everything else is a Tiny Dungeon icon — the weapon for
   *  attack, the shield for defense, else the potion. */
  private lootSprite(l: LootView): { texture: string; frame: number } {
    if (l.category === "bomb") return { texture: TOWN_KEY, frame: FRAME_BOMB };
    if (l.category === "attack")
      return { texture: TILES_KEY, frame: WEAPON_FRAMES[l.variant] ?? CATEGORY_FRAME.attack };
    return { texture: TILES_KEY, frame: CATEGORY_FRAME[l.category] ?? CATEGORY_FRAME.heal };
  }

  private addLoot(l: LootView, id: string) {
    const color = RARITY_COLORS[l.rarity] ?? RARITY_COLORS.common;
    const glow = this.add
      .circle(l.x, l.y, 9, color, 0.5)
      .setBlendMode(Phaser.BlendModes.ADD)
      .setDepth(LOOT_GLOW_DEPTH);
    const art = this.lootSprite(l);
    const sprite = this.add
      .image(l.x, l.y, art.texture, art.frame)
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

  // --- Bomb rendering (M10) ----------------------------------------------

  /**
   * A placed bomb: the Tiny Town bomb sprite plus a warning glow sized to the
   * actual blast radius (so the danger footprint is telegraphed). updateBomb
   * quickens the flash as the fuse runs out; removeBomb plays the detonation.
   */
  private addBomb(b: BombView, id: string) {
    const glow = this.add
      .circle(b.x, b.y, BOMB_BLAST_RADIUS, 0xff5a3c, 0.18)
      .setBlendMode(Phaser.BlendModes.ADD)
      .setDepth(LOOT_GLOW_DEPTH);
    const sprite = this.add
      .image(b.x, b.y, TOWN_KEY, FRAME_BOMB)
      .setDisplaySize(TILE, TILE)
      .setDepth(BOMB_DEPTH);
    this.bombs.set(id, { sprite, glow });
  }

  /** Pulse the bomb's warning flash, faster the closer the fuse is to zero. */
  private updateBomb(b: BombView, id: string) {
    const e = this.bombs.get(id);
    if (!e) return;
    const frac = Phaser.Math.Clamp(b.fuse / BOMB_FUSE, 0, 1);
    const freq = 6 + (1 - frac) * 22; // blink accelerates toward detonation
    const on = Math.sin((BOMB_FUSE - b.fuse) * freq) > 0;
    e.glow.setScale(1 + (1 - frac) * 0.5).setAlpha(on ? 0.55 : 0.18);
    e.sprite.setTint(on ? 0xffffff : 0xff5a3c); // strobe to a hot red-orange
  }

  /** Detonation: tear down the bomb entity and play the blast at its spot. */
  private removeBomb(id: string) {
    const e = this.bombs.get(id);
    if (!e) return;
    this.bombs.delete(id);
    const x = e.sprite.x;
    const y = e.sprite.y;
    e.sprite.destroy();
    e.glow.destroy();
    this.playExplosion(x, y);
  }

  /** A one-shot blast: shockwave ring + white core + a short camera kick. */
  private playExplosion(x: number, y: number) {
    const ring = this.add
      .circle(x, y, BOMB_BLAST_RADIUS, 0xffb15a, 0.45)
      .setStrokeStyle(3, 0xffd089, 0.9)
      .setDepth(15);
    this.tweens.add({
      targets: ring,
      scale: 1.6,
      alpha: 0,
      duration: 280,
      ease: "Quad.easeOut",
      onComplete: () => ring.destroy(),
    });
    const core = this.add.circle(x, y, BOMB_BLAST_RADIUS * 0.5, 0xffffff, 0.85).setDepth(16);
    this.tweens.add({
      targets: core,
      scale: 1.8,
      alpha: 0,
      duration: 180,
      onComplete: () => core.destroy(),
    });
    this.cameras.main.shake(180, 0.006);
  }

  // --- Vault chest rendering ---------------------------------------------

  /**
   * Render the vault: a gold-glowing chest, sealed (while locked) behind either a
   * closed gate at its door tile or — when there's no real door — a shimmer ring,
   * with an unlock countdown floating above it. onChange (updateChest) handles the
   * unlock reveal and the break HP bar; onRemove plays the open burst.
   */
  private addChest(ch: ChestView, id: string) {
    const glow = this.add
      .circle(ch.x, ch.y, TILE * 0.7, CHEST_COLOR, ch.locked ? 0.18 : 0.32)
      .setBlendMode(Phaser.BlendModes.ADD)
      .setDepth(CHEST_GLOW_DEPTH);
    this.tweens.add({
      targets: glow,
      scale: 1.25,
      alpha: ch.locked ? 0.1 : 0.18,
      duration: 900,
      yoyo: true,
      repeat: -1,
      ease: "Sine.inOut",
    });

    const sprite = this.add
      .image(ch.x, ch.y, TILES_KEY, FRAME_CHEST)
      .setDisplaySize(TILE, TILE)
      .setDepth(CHEST_DEPTH);
    if (ch.locked) sprite.setTint(CHEST_LOCKED_TINT);

    let door: Phaser.GameObjects.Image | undefined;
    let seal: Phaser.GameObjects.Arc | undefined;
    if (ch.locked) {
      if (ch.doorX >= 0 && ch.doorY >= 0) {
        door = this.add
          .image(ch.doorX * TILE + TILE / 2, ch.doorY * TILE + TILE / 2, TILES_KEY, FRAME_DOOR_CLOSED)
          .setDisplaySize(TILE, TILE)
          .setDepth(DOOR_DEPTH);
      } else {
        // Magic-seal fallback: a pulsing ring stands in for the absent gate.
        seal = this.add
          .circle(ch.x, ch.y, TILE * 0.6, CHEST_COLOR, 0)
          .setStrokeStyle(2, CHEST_COLOR, 0.8)
          .setDepth(DOOR_DEPTH);
        this.tweens.add({
          targets: seal,
          scale: 1.3,
          alpha: { from: 0.9, to: 0.2 },
          duration: 1100,
          yoyo: true,
          repeat: -1,
          ease: "Sine.inOut",
        });
      }
    }

    const countdown = this.add
      .text(ch.x, ch.y - TILE, "", {
        fontFamily: "monospace",
        fontSize: "11px",
        color: "#ffe9a8",
      })
      .setOrigin(0.5, 1)
      .setScale(1 / CAMERA_ZOOM)
      .setDepth(20)
      .setVisible(ch.locked);

    const hpBar = this.add.graphics().setDepth(CHEST_DEPTH + 1);

    const e: ChestEntity = {
      sprite,
      glow,
      door,
      seal,
      countdown,
      hpBar,
      worldX: ch.x,
      worldY: ch.y,
      locked: ch.locked,
      unlockIn: ch.unlockIn,
      hp: ch.hp,
      maxHp: ch.maxHp,
    };
    this.chests.set(id, e);
    this.refreshChestCountdown(e);
  }

  /** React to a synced chest change: the unlock reveal, the countdown, the HP bar. */
  private updateChest(ch: ChestView, id: string) {
    const e = this.chests.get(id);
    if (!e) return;

    if (e.locked && !ch.locked) this.openDoorReveal(e); // sealed → open
    if (ch.hp < e.hp && !ch.locked) this.chestStrike(e); // took a hit

    e.locked = ch.locked;
    e.unlockIn = ch.unlockIn;
    e.hp = ch.hp;
    e.maxHp = ch.maxHp;

    e.countdown.setVisible(ch.locked);
    this.refreshChestCountdown(e);
    // HP bar only once unlocked + chipped (hidden full/sealed, like other bars).
    this.drawHpBar(e.hpBar, e.sprite.x, e.sprite.y, ch.locked ? e.maxHp : ch.hp, e.maxHp);
  }

  /** Rewrite the "m:ss" unlock countdown above a sealed chest. */
  private refreshChestCountdown(e: ChestEntity) {
    if (!e.locked) return;
    const s = Math.max(0, Math.ceil(e.unlockIn));
    e.countdown.setText(`${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`);
  }

  /**
   * Play the door's 3-frame open sequence (closed → ajar → open), then clear the
   * gate (or shimmer) and brighten the chest — the "come and get it" cue. The
   * tile is already passable server-side by now.
   */
  private openDoorReveal(e: ChestEntity) {
    e.sprite.clearTint(); // chest brightens
    this.tweens.add({ targets: e.glow, alpha: 0.32, duration: 200 });
    if (e.seal) {
      this.tweens.killTweensOf(e.seal);
      const seal = e.seal;
      this.tweens.add({
        targets: seal,
        scale: 1.8,
        alpha: 0,
        duration: 260,
        onComplete: () => seal.destroy(),
      });
      e.seal = undefined;
    }
    const door = e.door;
    if (door) {
      this.time.delayedCall(80, () => door.setFrame(FRAME_DOOR_HALF));
      this.time.delayedCall(200, () => door.setFrame(FRAME_DOOR_OPEN));
      this.time.delayedCall(360, () => {
        this.tweens.add({
          targets: door,
          alpha: 0,
          duration: 220,
          onComplete: () => door.destroy(),
        });
      });
      e.door = undefined;
    }
  }

  /** Quick shake + flash when the chest takes a swing (mirrors mobStrike). */
  private chestStrike(e: ChestEntity) {
    const s = e.sprite;
    this.tweens.killTweensOf(s);
    const baseScale = s.scaleX;
    s.setTint(0xffe9a8);
    this.tweens.add({
      targets: s,
      scaleX: baseScale * 1.18,
      scaleY: baseScale * 1.18,
      duration: 70,
      yoyo: true,
      ease: "Quad.easeOut",
      onComplete: () => s.setScale(baseScale).clearTint(),
    });
  }

  /** Open burst when the vault is cracked (state onRemove), then free everything. */
  private removeChest(id: string) {
    const e = this.chests.get(id);
    if (!e) return;
    this.chests.delete(id);
    this.tweens.killTweensOf(e.sprite);
    this.tweens.killTweensOf(e.glow);
    e.countdown.destroy();
    e.hpBar.destroy();
    e.door?.destroy();
    e.seal?.destroy();
    // A gold flare + pop, then clean up the chest + glow.
    this.tweens.add({
      targets: [e.sprite, e.glow],
      scale: 2,
      alpha: 0,
      duration: 280,
      ease: "Quad.easeOut",
      onComplete: () => {
        e.sprite.destroy();
        e.glow.destroy();
      },
    });
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

  /** Place a carried bomb (E key or the touch button). Inventory-gated server-side. */
  private handleBombInput() {
    const want = Phaser.Input.Keyboard.JustDown(this.keys.e) || this.bombRequested;
    this.bombRequested = false;
    if (!want || !this.room) return;
    const me = this.entities.get(this.localId);
    if (me && me.hp <= 0) return; // no placing while down
    this.room.send("useBomb"); // server no-ops if we hold no bombs
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

  /** The exit ward-pulse (M11): a teal ring expanding from the ladder. */
  private playExitPulse(x: number, y: number) {
    const ring = this.add
      .circle(x, y, EXIT_PULSE_RADIUS, EXIT_PULSE_COLOR, 0)
      .setStrokeStyle(2, EXIT_PULSE_COLOR, 0.8)
      .setDepth(15);
    this.tweens.add({
      targets: ring,
      scale: 1.5,
      alpha: 0,
      duration: 280,
      ease: "Quad.easeOut",
      onComplete: () => ring.destroy(),
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
    this.localHealCharges = p.healCharges;
    const heal = document.getElementById("hud-heal");
    const healN = document.getElementById("hud-heal-n");
    if (heal) heal.classList.toggle("empty", p.healCharges <= 0);
    if (heal) heal.title = p.healCharges > 0 ? `${p.healCharges} heal(s) — press Q` : "no heals";
    if (healN) healN.textContent = String(p.healCharges);

    // Carried bombs (M10): a chip with the stack count, shown only while holding
    // at least one. Also published to the registry so UIScene's contextual mobile
    // bomb button can show/hide without touching Colyseus.
    const bomb = document.getElementById("hud-bomb");
    const bombN = document.getElementById("hud-bomb-n");
    if (bomb) {
      bomb.hidden = p.bombs <= 0;
      bomb.title = `${p.bombs} bomb(s) — press E`;
    }
    if (bombN) bombN.textContent = String(p.bombs);
    this.registry.set(BOMB_COUNT_KEY, p.bombs);

    // Lives: ♥×N near the run HUD; greyed at 0 (revive-only).
    const lives = document.getElementById("run-lives");
    if (lives) {
      lives.textContent = `♥×${p.respawnsLeft}`;
      lives.classList.toggle("empty", p.respawnsLeft <= 0);
      lives.title =
        p.respawnsLeft > 0
          ? `${p.respawnsLeft} life/lives — each self-respawn spends one`
          : "no lives — revive-only";
    }

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

  /**
   * Gold toast when a hero unseals a vault relic ("✦ {who} unsealed the {name}").
   * Both the player name and the relic name go in via textContent — names are
   * user-supplied / server-built; keep them out of the HTML parser.
   */
  /**
   * The vault-key flourish: a key sprite pops out of the smashed crate, floats
   * up with a gold sparkle, then fades as the door swings open. Purely cosmetic —
   * the server already unlocked the vault; this just makes the moment visible.
   */
  private playKeyPop(x: number, y: number) {
    const key = this.add
      .image(x, y, TOWN_KEY, FRAME_KEY)
      .setDisplaySize(TILE, TILE)
      .setDepth(HUD_DEPTH - 1) // above heroes/mobs so it reads through a melee
      .setScale(0); // tween up from nothing so it "pops"

    const target = TILE / TILE_SRC; // displaySize scale that yields one TILE
    // Pop in with a little overshoot, then drift upward and fade.
    this.tweens.add({
      targets: key,
      scale: target,
      duration: 180,
      ease: "Back.Out",
      onComplete: () => {
        this.tweens.add({
          targets: key,
          y: y - TILE * 1.6,
          alpha: 0,
          duration: 650,
          delay: 250,
          ease: "Sine.In",
          onComplete: () => key.destroy(),
        });
      },
    });

    // A soft gold glow behind it for the sparkle.
    const glow = this.add
      .circle(x, y, TILE * 0.7, 0xffe066, 0.5)
      .setBlendMode(Phaser.BlendModes.ADD)
      .setDepth(HUD_DEPTH - 2);
    this.tweens.add({
      targets: glow,
      scale: 1.8,
      alpha: 0,
      duration: 700,
      ease: "Quad.Out",
      onComplete: () => glow.destroy(),
    });
  }

  private showKeyFoundToast(who: string) {
    const container = document.getElementById("toasts");
    if (!container) return;

    const el = document.createElement("div");
    el.className = "toast key";
    const img = document.createElement("img");
    img.src = "/assets/tiny-town/key.png";
    img.className = "key-icon";
    img.alt = "key";
    const whoEl = document.createElement("span");
    whoEl.className = "who";
    whoEl.textContent = who;
    el.append(img, whoEl, document.createTextNode(" found the vault key! Door opened."));
    container.appendChild(el);

    requestAnimationFrame(() => el.classList.add("show"));
    window.setTimeout(() => {
      el.classList.remove("show");
      el.addEventListener("transitionend", () => el.remove(), { once: true });
    }, 3500);
  }

  private showRelicToast(who: string, name: string) {
    const container = document.getElementById("toasts");
    if (!container) return;

    const el = document.createElement("div");
    el.className = "toast relic";
    const whoEl = document.createElement("span");
    whoEl.className = "who";
    whoEl.textContent = who;
    const nameEl = document.createElement("span");
    nameEl.className = "relic-name";
    nameEl.textContent = name;
    el.append(
      document.createTextNode("✦ "),
      whoEl,
      document.createTextNode(" unsealed the "),
      nameEl
    );
    container.appendChild(el);

    requestAnimationFrame(() => el.classList.add("show"));
    window.setTimeout(() => {
      el.classList.remove("show");
      el.addEventListener("transitionend", () => el.remove(), { once: true });
    }, 3200);
  }

  /** Grey + prone a downed hero so teammates can spot them; restore on revive. */
  private applyDownedLook(e: Entity) {
    if (e.downed) {
      e.sprite.setTint(0x6a6f7a).setAlpha(0.55).setAngle(90);
      e.aura.setVisible(false);
    } else {
      e.sprite.setTint(e.color).setAlpha(1).setAngle(0);
    }
    this.syncDistressGlow(e);
  }

  /**
   * Reconcile a downed teammate's distress beacon: a pulsing danger-red ember on the
   * prone hero, present only while they're downed on a dark/torchlit floor. The faint
   * light it casts (added in updateDarkness) is what reveals the swarm during a
   * pitch-black revive run; this ember is the eye-catcher that draws you to them.
   */
  private syncDistressGlow(e: Entity) {
    const want = e.downed && this.darkFloor;
    if (want && !e.distress) {
      e.distress = this.add
        .circle(e.sprite.x, e.sprite.y, DISTRESS_GLOW_RADIUS, DISTRESS_TINT_COLOR, 0.5)
        .setBlendMode(Phaser.BlendModes.ADD)
        .setDepth(DISTRESS_GLOW_DEPTH);
      this.tweens.add({
        targets: e.distress,
        scale: 1.7,
        alpha: 0.12,
        duration: 600,
        yoyo: true,
        repeat: -1,
        ease: "Sine.inOut",
      });
    } else if (!want && e.distress) {
      this.tweens.killTweensOf(e.distress);
      e.distress.destroy();
      e.distress = undefined;
    }
  }

  /**
   * The local "You're down" overlay: a countdown while the self-respawn cooldown
   * runs, then the Respawn button (lives left), or a "wait for a revive" prompt
   * (revive-only). Hidden when up. Driven by the per-tick respawnIn change.
   */
  private updateDownedOverlay(p: PlayerView) {
    const el = document.getElementById("downed");
    const sub = document.getElementById("downed-sub");
    const btn = document.getElementById("respawn-btn");
    if (!el || !sub || !btn) return;
    const phase = (this.room?.state as { phase?: string } | undefined)?.phase;
    if (!p.downed || phase === "gameover") {
      el.hidden = true;
      return;
    }
    el.hidden = false;
    if (p.respawnsLeft <= 0) {
      sub.textContent = "No lives left — wait for a teammate to revive you.";
      btn.hidden = true;
    } else if (p.respawnIn > 0) {
      sub.textContent = `Respawn in ${Math.ceil(p.respawnIn)}s — or wait for a free revive.`;
      btn.hidden = true;
    } else {
      const n = p.respawnsLeft;
      sub.textContent = `${n} ${n === 1 ? "life" : "lives"} left — or wait for a free revive.`;
      btn.hidden = false;
    }
  }

  /**
   * Show/hide the game-over score screen: floor reached + a per-player score
   * table (sorted, local hero highlighted) + the party total. Scores are read
   * from state (the server has already forfeited any un-banked floor by now).
   */
  private setGameOverOverlay(show: boolean, floor?: number) {
    const el = document.getElementById("gameover");
    if (!el) return;
    if (!show) {
      // Restart returned us to play — drop the overlay, offer the exit again.
      el.hidden = true;
      this.runTallies = null; // fresh run, fresh discoveries
      this.codexResult = null; // re-arms the codex record for the next run end
      this.setExitButtonVisible(true);
      return;
    }
    // Party-wipe framing (vs. the voluntary-exit framing in showExitScorecard).
    const title = document.getElementById("gameover-title");
    if (title) title.textContent = "Your party fell";
    const sub = document.getElementById("gameover-sub");
    if (sub && floor !== undefined) sub.textContent = `Reached Floor ${floor}`;
    const restart = document.getElementById("restart-btn");
    if (restart) restart.hidden = false;
    const back = document.getElementById("backmenu-btn");
    if (back) back.hidden = true;
    this.updateBestFlash();
    this.buildScoreTable();
    // The party is wiped — the per-player downed overlay gives way to this, and
    // there's nothing left to leave, so hide the exit button.
    const downed = document.getElementById("downed");
    if (downed) downed.hidden = true;
    this.setExitButtonVisible(false);
    el.hidden = false;
  }

  /** Show/hide the top-right "leave the run" button. */
  private setExitButtonVisible(show: boolean) {
    const btn = document.getElementById("exit-btn");
    if (btn) btn.hidden = !show;
  }

  /**
   * Open the leave-confirm overlay. Only meaningful during an active run — not
   * before connecting, and not once the party has already wiped (the game-over
   * screen owns the endgame there).
   */
  private requestExit() {
    if (!this.room) return;
    const phase = (this.room.state as { phase?: string }).phase;
    if (phase === "gameover") return;
    // Already showing the end-of-run scorecard (party wipe or our own exit) —
    // nothing left to leave.
    const over = document.getElementById("gameover");
    if (over && !over.hidden) return;
    const confirm = document.getElementById("exit-confirm");
    if (confirm) confirm.hidden = false;
  }

  private dismissExitConfirm() {
    const confirm = document.getElementById("exit-confirm");
    if (confirm) confirm.hidden = true;
  }

  /**
   * Commit to leaving: freeze the scorecard from current state, drop the
   * reconnect token (so a refresh won't rejoin the room we quit), then do a
   * consented `room.leave()` (close code 4000) — the server removes us right
   * away with no grace period and the rest of the party plays on.
   */
  private confirmExit() {
    this.dismissExitConfirm();
    const floor = (this.room?.state as { depth?: number } | undefined)?.depth;
    this.showExitScorecard(floor); // reads live state — must run before we leave
    try {
      sessionStorage.removeItem(RECONNECT_KEY);
    } catch {
      /* sessionStorage unavailable — nothing to clear */
    }
    this.room?.leave();
  }

  /** The voluntary-exit scorecard: same party board, exit framing + Back to menu. */
  private showExitScorecard(floor?: number) {
    const el = document.getElementById("gameover");
    if (!el) return;
    const title = document.getElementById("gameover-title");
    if (title) title.textContent = "You left the dungeon";
    const sub = document.getElementById("gameover-sub");
    if (sub) sub.textContent = floor !== undefined ? `Left on Floor ${floor}` : "";
    // A voluntary exit ends the run too — it counts toward the codex (no wipe
    // tallies were sent, so only score/floor/relics contribute).
    this.recordLocalRunEnd(floor ?? 1);
    this.updateBestFlash();
    this.buildScoreTable();
    // Restart is party-wide — wrong for a solo leaver; offer Back to menu instead.
    const restart = document.getElementById("restart-btn");
    if (restart) restart.hidden = true;
    const back = document.getElementById("backmenu-btn");
    if (back) back.hidden = false;
    const downed = document.getElementById("downed");
    if (downed) downed.hidden = true;
    this.setExitButtonVisible(false);
    el.hidden = false;
  }

  /** Leave the scorecard for a clean lobby (strip ?room=/?pubid= so we don't auto-rejoin). */
  private backToMenu() {
    window.location.href = window.location.origin + window.location.pathname;
  }

  /**
   * Fold the local hero's finished run into the browser codex (M14), once per
   * run end — both the wipe and the voluntary exit route here. Stashes the
   * result for the NEW badges + best-flash the score screen renders.
   */
  private recordLocalRunEnd(floor: number) {
    if (this.codexResult) return; // this run end is already recorded
    const players = (this.room?.state as { players?: Map<string, PlayerView> } | undefined)?.players;
    const p = players?.get(this.localId);
    if (!p) return;
    const tally = this.runTallies?.[this.localId];
    this.codexResult = recordRunEnd({
      score: p.score ?? 0,
      floor,
      weapons: tally?.weapons ?? [],
      kinds: tally ? Object.keys(tally.kills) : [],
      relics: Array.from(p.relics ?? []),
    });
  }

  /** The "★ new personal best" line under the scorecard subtitle (M14). */
  private updateBestFlash() {
    const el = document.getElementById("pb-line");
    if (!el) return;
    const r = this.codexResult;
    if (r?.newBestScore && r?.newDeepestFloor) {
      el.textContent = "★ New best score — and your deepest floor yet!";
    } else if (r?.newBestScore) {
      el.textContent = "★ New personal best score!";
    } else if (r?.newDeepestFloor) {
      el.textContent = "★ Your deepest floor yet!";
    } else {
      el.hidden = true;
      return;
    }
    el.hidden = false;
  }

  /** Render the score rows (name + score, sorted desc) and the party total. */
  private buildScoreTable() {
    const list = document.getElementById("score-list");
    const totalEl = document.getElementById("score-total");
    const players = (this.room?.state as { players?: Map<string, PlayerView> } | undefined)?.players;
    if (!list || !players) return;
    const rows = Array.from(players.entries())
      .map(([id, p]) => ({
        id,
        name: p.name,
        score: p.score ?? 0,
        relics: Array.from(p.relics ?? []),
      }))
      .sort((a, b) => b.score - a.score);
    list.replaceChildren();
    let total = 0;
    for (const r of rows) {
      total += r.score;
      const row = document.createElement("div");
      row.className = "score-row" + (r.id === this.localId ? " me" : "");
      const name = document.createElement("span");
      name.className = "score-name";
      name.textContent = r.name; // user-supplied — textContent, never innerHTML
      const val = document.createElement("span");
      val.className = "score-val";
      val.textContent = r.score.toLocaleString();
      row.append(name, val);
      list.appendChild(row);

      // First-ever discoveries get a NEW badge (M14) — but the codex is this
      // browser's memory, so only the local hero's row can be badged against it.
      const prev = r.id === this.localId ? this.codexResult?.prev : undefined;

      // The hero's vault relics, listed small + dimmed beneath their row.
      if (r.relics.length > 0) {
        const relics = document.createElement("div");
        relics.className = "score-relics";
        for (const name of r.relics) {
          const tag = document.createElement("span");
          tag.className = "relic-tag";
          if (prev && !prev.relics.includes(name)) tag.classList.add("disc-new");
          tag.textContent = `✦ ${name}`; // server-built name — still textContent
          relics.appendChild(tag);
        }
        list.appendChild(relics);
      }

      // The hero's run discoveries (M13) — only present after a wipe (the server
      // ships tallies with "gameover"); a voluntary exit shows the plain board.
      const tally = this.runTallies?.[r.id];
      if (tally) {
        const disc = this.buildDiscoveryLines(tally, prev);
        if (disc) list.appendChild(disc);
      }
    }
    if (totalEl) totalEl.textContent = total.toLocaleString();
  }

  /**
   * The run's museum for one hero (M13): compact "Wielded / Slain / Hauled" lines
   * under their score row. Items are built as spans so a first-ever discovery
   * (per `prev`, the local codex before this run — M14) can carry a NEW badge;
   * all values still land via textContent only. Null when the run logged nothing.
   */
  private buildDiscoveryLines(
    tally: RunTally,
    prev?: { weapons: string[]; kinds: string[] }
  ): HTMLElement | null {
    // One line = a label + items; an item marked new gets the .disc-new badge.
    const makeLine = (label: string, items: { text: string; isNew: boolean }[]): HTMLElement => {
      const line = document.createElement("div");
      line.className = "disc-line";
      line.append(`${label}: `);
      items.forEach(({ text, isNew }, i) => {
        if (i > 0) line.append(" · ");
        const item = document.createElement("span");
        if (isNew) item.className = "disc-new";
        item.textContent = text;
        line.appendChild(item);
      });
      return line;
    };
    const lines: HTMLElement[] = [];

    if (tally.weapons.length > 0) {
      lines.push(
        makeLine(
          "Wielded",
          tally.weapons.map((w) => ({ text: w, isNew: !!prev && !prev.weapons.includes(w) }))
        )
      );
    }

    const kills = Object.entries(tally.kills).sort((a, b) => b[1] - a[1]);
    if (kills.length > 0) {
      lines.push(
        makeLine(
          "Slain",
          kills.map(([kind, n]) => ({
            text: `${kind} ×${n}`,
            isNew: !!prev && !prev.kinds.includes(kind),
          }))
        )
      );
    }

    // Haul: total drops grabbed, calling out the rare+ finds; plus crates/vaults.
    // Counts aren't discoveries, so no badges here.
    const lootTotal = Object.values(tally.loot).reduce((sum, n) => sum + n, 0);
    const notable = ["legendary", "epic", "rare"]
      .filter((rar) => (tally.loot[rar] ?? 0) > 0)
      .map((rar) => `${tally.loot[rar]} ${rar}`);
    const haul: string[] = [];
    if (lootTotal > 0) {
      haul.push(`${lootTotal} loot${notable.length > 0 ? ` (${notable.join(", ")})` : ""}`);
    }
    if (tally.crates > 0) haul.push(`${tally.crates} ${tally.crates === 1 ? "crate" : "crates"}`);
    if (tally.chests > 0) haul.push(`${tally.chests} ${tally.chests === 1 ? "vault" : "vaults"}`);
    if (haul.length > 0) {
      lines.push(makeLine("Hauled", haul.map((text) => ({ text, isNew: false }))));
    }

    if (lines.length === 0) return null;
    const el = document.createElement("div");
    el.className = "score-discoveries";
    for (const line of lines) el.appendChild(line);
    return el;
  }

  /**
   * Contextual revive prompt: shown while a living, potion-carrying local hero is
   * standing over a downed ally. The heal action (Q) then revives instead of
   * self-healing — the server decides; this is only the nudge.
   */
  private updateReviveHint() {
    const hint = document.getElementById("revive-hint");
    if (!hint) return;
    const me = this.entities.get(this.localId);
    if (!me || me.downed || this.localHealCharges <= 0) {
      hint.hidden = true;
      return;
    }
    let nearest: Entity | undefined;
    let best = REVIVE_RANGE;
    this.entities.forEach((e, id) => {
      if (id === this.localId || !e.downed) return;
      const d = Phaser.Math.Distance.Between(me.sprite.x, me.sprite.y, e.sprite.x, e.sprite.y);
      if (d <= best) {
        best = d;
        nearest = e;
      }
    });
    if (nearest) {
      hint.textContent = `❤ Revive ${nearest.label.text} — press Q`;
      hint.hidden = false;
    } else {
      hint.hidden = true;
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

    // Depth biome (M15): geometry renders from the biome's sheet clone; an
    // unknown/absent biome (older server, un-built kit) falls back to stone.
    const biomeKey = BIOME_TEXTURES[data.biome ?? ""];
    this.mapTilesKey = biomeKey && this.textures.exists(biomeKey) ? biomeKey : TILES_KEY;

    const worldW = data.width * t;
    const worldH = data.height * t;

    // The world is bigger than the viewport now; bound the camera to it so it
    // never scrolls past the dungeon edges.
    this.cameras.main.setBounds(0, 0, worldW, worldH);

    // Reset per-floor dark-vision state. On a dark floor we lay a black backdrop
    // behind the map (so unlit tiles read as void) and collect every geometry cell
    // for the per-frame light pass; on a bright floor we tear all that down.
    // Both "dark" and "torchlit" render through the vision path (black backdrop,
    // hidden-until-lit entities, explored ghosting). Torchlit just adds static
    // torch pools on top — so the floor is dark *except* where torches reach.
    this.darkFloor = data.lighting === "dark" || data.lighting === "torchlit";
    this.darkCells = [];
    this.explored.clear();
    this.exitDiscovered = !this.darkFloor; // bright floors: ladder always shown
    this.darkBackdrop?.destroy();
    this.darkBackdrop = undefined;
    if (this.darkFloor) {
      this.darkBackdrop = this.add
        .rectangle(0, 0, worldW, worldH, 0x000000)
        .setOrigin(0)
        .setDepth(BACKDROP_DEPTH);
    }

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
          this.trackDarkCell(cell, x, y, t);
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
          // Anti-tiling (M15): biome sheets carry alternate rolls of the face/
          // back tiles in their extension row — hash-pick per tile (stable
          // across clients) so long wall runs don't wallpaper one texture.
          const variants = this.mapTilesKey !== TILES_KEY ? WALL_VARIANTS[frame] : undefined;
          if (variants) frame = variants[Math.floor(tileHash(x, y, 5) * variants.length)];
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
        this.trackDarkCell(this.addCell(x * t, y * t, t, frame), x, y, t);
      }
    }

    // Solid props (server-placed, collidable). Drawn last so they sit on top of
    // the floor; they share the floor's depth (mapLayer) so heroes pass in front
    // — but the server blocks the tile, so heroes never actually overlap them.
    for (const p of data.props) {
      this.trackDarkCell(this.addCell(p.x * t, p.y * t, t, p.frame), p.x, p.y, t);
    }

    // Static wall torches (torchlit floors). The server only places them on
    // front-facing walls (floor directly to the south), so the sprite always mounts
    // on a visible brick face and the pool spills down into the room. Each is an
    // always-on warm light source (added in updateDarkness so it never moves); the
    // sprites aren't tracked as darkCells, so they never dim. Rebuilt per floor.
    this.clearTorches();
    this.torchLights = [];
    for (const tr of data.torches ?? []) {
      const wx = tr.x * t + t / 2;
      const wy = tr.y * t + t / 2;
      const lx = wx; // pool centered below the torch (front wall faces south)
      const ly = wy + t * 0.5;
      this.torchLights.push({
        x: lx,
        y: ly,
        inner: TORCH_LIGHT_INNER,
        outer: TORCH_LIGHT_OUTER,
        tint: TORCH_TINT_COLOR,
        strength: TORCH_TINT_MAX,
      });
      this.buildTorch(wx, wy);
    }

    // Floor changed (darkFloor may have flipped) — reconcile any downed hero's
    // distress beacon: it only exists while downed on a dark/torchlit floor.
    this.entities.forEach((e) => this.syncDistressGlow(e));

    // Descent beacon. buildMap re-runs on every floor (the server re-sends "map"
    // on descend), so rebuild the marker each time at the new exit.
    this.exitX = data.exit.x * t + t / 2;
    this.exitY = data.exit.y * t + t / 2;
    this.buildExitMarker(t);
    this.exitMarker?.setVisible(this.exitDiscovered); // hidden on dark floors until found

    // Seed the vision so the very first frame (and the descent fade-in) reveals the
    // hero's surroundings instead of flashing the whole floor before going dark.
    if (this.darkFloor) this.updateDarkness();

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
   * The descent point: a custom 16×16 ladder/hatch sprite (Tiny Dungeon has no
   * stairs tile). Rebuilt per floor; a soft torch-lit glow pulses behind it so
   * it's findable without reading like a UI arrow.
   */
  private buildExitMarker(t: number) {
    this.exitMarker?.destroy();
    const glow = this.add.circle(0, 0, t * 0.72, 0xffb24d, 0.14);
    const ladder = this.add.image(0, 0, EXIT_TEXTURE).setDisplaySize(t, t);
    const cont = this.add.container(this.exitX, this.exitY, [glow, ladder]).setDepth(EXIT_DEPTH);
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

  /** Update the Floor / heat / score / multiplier readouts (throttled to changes). */
  private updateRunHud() {
    const st = this.room?.state as
      | { depth?: number; heat?: number; players?: Map<string, PlayerView> }
      | undefined;
    if (!st) return;
    const depth = st.depth ?? 1;
    if (depth !== this.lastDepthShown) {
      this.lastDepthShown = depth;
      const el = document.getElementById("run-depth");
      if (el) el.textContent = `Floor ${depth}`;
      const hud = document.getElementById("run-hud");
      if (hud) hud.hidden = false;
    }
    const heat = st.heat ?? 0;
    const pct = Math.round(heat * 100);
    if (pct !== this.lastHeatShown) {
      this.lastHeatShown = pct;
      const fill = document.getElementById("run-heat-fill");
      if (fill) fill.style.width = `${pct}%`;
    }

    // Score multiplier (×1 calm → ×max at full heat), tinted from cool→hot so you
    // see heat becoming points. Throttled to a 2-decimal change.
    const mult = 1 + heat * (SCORE_MULT_MAX - 1);
    const multKey = Math.round(mult * 100);
    if (multKey !== this.lastMultShown) {
      this.lastMultShown = multKey;
      const el = document.getElementById("run-mult");
      if (el) {
        el.textContent = `×${mult.toFixed(1)}`;
        const c = Phaser.Display.Color.Interpolate.RGBWithRGB(78, 201, 255, 255, 93, 115, 100, Math.round(heat * 100));
        el.style.color = `rgb(${c.r},${c.g},${c.b})`;
      }
    }

    // Personal score + (in co-op) the party total, both live.
    const players = st.players;
    const me = players?.get(this.localId);
    const myScore = me?.score ?? 0;
    if (myScore !== this.lastScoreShown) {
      this.lastScoreShown = myScore;
      const el = document.getElementById("run-score");
      if (el) el.textContent = `★ ${myScore.toLocaleString()}`;
    }
    let party = 0;
    let count = 0;
    players?.forEach((p) => {
      party += p.score ?? 0;
      count++;
    });
    const partyEl = document.getElementById("run-party");
    if (partyEl) {
      // Only meaningful with teammates; hidden solo (it would just echo your score).
      partyEl.hidden = count < 2;
      if (count >= 2 && party !== this.lastPartyShown) {
        this.lastPartyShown = party;
        partyEl.textContent = `Party ${party.toLocaleString()}`;
      }
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

  /**
   * Point the player toward the vault while it's off-camera: a gold edge arrow
   * (distinct from the exit's amber), with the unlock countdown beside it while
   * the chest is still sealed. On-screen, the chest's own glow + floating
   * countdown do the job, so the arrow hides.
   */
  private updateChestNudge() {
    const me = this.entities.get(this.localId);
    const chest = this.chests.values().next().value as ChestEntity | undefined;
    if (!me || !chest) {
      this.chestArrow?.setVisible(false);
      this.chestArrowLabel?.setVisible(false);
      return;
    }

    // Lazily create the gold arrow + its countdown chip (reused across floors).
    if (!this.chestArrow) {
      this.chestArrow = this.add
        .triangle(0, 0, 0, -11, 9, 9, -9, 9, CHEST_COLOR, 0.95)
        .setScrollFactor(0)
        .setDepth(HUD_DEPTH)
        .setVisible(false);
      this.chestArrowLabel = this.add
        .text(0, 0, "", { fontFamily: "monospace", fontSize: "11px", color: "#ffe9a8" })
        .setOrigin(0.5)
        .setScrollFactor(0)
        .setDepth(HUD_DEPTH)
        .setVisible(false);
    }

    const cam = this.cameras.main;
    const view = cam.worldView;
    if (view.contains(chest.worldX, chest.worldY)) {
      this.chestArrow.setVisible(false);
      this.chestArrowLabel!.setVisible(false);
      return;
    }
    const cx = cam.width / 2;
    const cy = cam.height / 2;
    const sx = ((chest.worldX - view.x) / view.width) * cam.width;
    const sy = ((chest.worldY - view.y) / view.height) * cam.height;
    const ang = Math.atan2(sy - cy, sx - cx);
    const px = cx + Math.cos(ang) * (cx - 46);
    const py = cy + Math.sin(ang) * (cy - 46);
    this.chestArrow.setVisible(true).setPosition(px, py).setRotation(ang + Math.PI / 2);

    if (chest.locked) {
      const s = Math.max(0, Math.ceil(chest.unlockIn));
      this.chestArrowLabel!.setText(`${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`)
        .setVisible(true)
        // Nudge the label toward screen-center from the arrow so it stays on-screen.
        .setPosition(px - Math.cos(ang) * 16, py - Math.sin(ang) * 16);
    } else {
      this.chestArrowLabel!.setVisible(false);
    }
  }

  /** Add one map tile image to the map layer and return it. Geometry draws
   *  from the current floor's biome sheet (frame indices match the base). */
  private addCell(px: number, py: number, t: number, frame: number) {
    const cell = this.add
      .image(px, py, this.mapTilesKey, frame)
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

  /** Remember a geometry tile for the dark-floor light pass (no-op when bright). */
  private trackDarkCell(obj: Phaser.GameObjects.Image, x: number, y: number, t: number) {
    if (!this.darkFloor) return;
    this.darkCells.push({ obj, cx: x * t + t / 2, cy: y * t + t / 2, key: `${x},${y}` });
  }

  /**
   * Build one wall torch: just the mounted sprite (on the front-facing wall tile)
   * with a gentle alpha flicker. The light it casts is handled per-tile in
   * updateDarkness (blocky, like the hero bubble) — no smooth glow overlay. Not
   * tracked as a darkCell, so it stays lit. Registered for per-floor teardown.
   */
  private buildTorch(wx: number, wy: number) {
    const sprite = this.add.image(wx, wy, TILES_KEY, FRAME_TORCH).setDepth(TORCH_SPRITE_DEPTH);
    const flicker = this.tweens.add({
      targets: sprite,
      alpha: 0.78,
      duration: 620,
      yoyo: true,
      repeat: -1,
      ease: "Sine.inOut",
    });
    this.torchObjs.push(sprite);
    this.torchTweens.push(flicker);
  }

  /** Tear down the previous floor's torch sprites + their flicker tweens. */
  private clearTorches() {
    for (const tw of this.torchTweens) tw.remove();
    this.torchTweens = [];
    for (const o of this.torchObjs) o.destroy();
    this.torchObjs = [];
  }

  /**
   * Sample the light at a world point this frame: `total` brightness (1 inside a
   * source's INNER radius, fading to 0 at its OUTER, max-pooled over all sources so
   * hero bubbles + torches add up) and `tint` — the color this tile blends toward,
   * taken from whichever source lights it most (torch amber, a teammate's player
   * color, a downed hero's distress red, or neutral white for your own light).
   */
  private litSample(x: number, y: number): { total: number; tint: number } {
    let best = 0;
    let bestTint = 0xffffff;
    let bestStrength = 0;
    for (const s of this.lightSources) {
      const dx = x - s.x;
      const dy = y - s.y;
      const d2 = dx * dx + dy * dy;
      if (d2 >= s.outer * s.outer) continue;
      const d = Math.sqrt(d2);
      const a = d <= s.inner ? 1 : (s.outer - d) / (s.outer - s.inner);
      if (a > best) {
        best = a;
        bestTint = s.tint;
        bestStrength = s.strength;
      }
    }
    return { total: best, tint: bestStrength > 0 ? this.blendTint(bestTint, bestStrength) : 0xffffff };
  }

  /** Blend white → `color` by `strength` (0..1) for a multiply-tint that warms/cools. */
  private blendTint(color: number, strength: number): number {
    const s = Math.min(1, Math.max(0, strength));
    const cr = (color >> 16) & 0xff;
    const cg = (color >> 8) & 0xff;
    const cb = color & 0xff;
    const r = Math.round(255 - (255 - cr) * s);
    const g = Math.round(255 - (255 - cg) * s);
    const b = Math.round(255 - (255 - cb) * s);
    return (r << 16) | (g << 8) | b;
  }

  /** Total light at a point (visibility gating) — the brightness half of litSample. */
  private litAt(x: number, y: number): number {
    let best = 0;
    for (const s of this.lightSources) {
      const dx = x - s.x;
      const dy = y - s.y;
      const d2 = dx * dx + dy * dy;
      if (d2 >= s.outer * s.outer) continue;
      const d = Math.sqrt(d2);
      const a = d <= s.inner ? 1 : (s.outer - d) / (s.outer - s.inner);
      if (a > best) best = a;
      if (best >= 1) break;
    }
    return best;
  }

  /**
   * Show `primary` (+ any `aux` location-tells like a glow or HP bar) only where a
   * hero's light reaches. When lit we leave `aux` to its own per-frame logic (so we
   * don't, say, force a chest door back on); when dark we force everything off so
   * the thing vanishes completely — that's what makes a mob "appear" at the edge.
   */
  private gateByLight(x: number, y: number, primary: Dimmable, aux: Dimmable[] = []) {
    const visible = this.litAt(x, y) > LIGHT_VISIBLE_AT;
    primary.setVisible(visible);
    if (!visible) for (const a of aux) a.setVisible(false);
  }

  /**
   * Dark-floor render pass (called last in update()). Geometry fades by distance to
   * the nearest hero light and lingers dim once explored; mobs/loot/crates/bombs/
   * markers/the vault hide until lit; the ladder reveals once found and stays shown.
   * Heroes themselves are the light sources, so they're never gated.
   */
  private updateDarkness() {
    // Build this frame's lights from the heroes. A living hero is a full bubble that
    // tints its tiles toward their player color — except your OWN light, which stays
    // neutral so your immediate view is true-color (you read *teammates* by their
    // glow). A downed hero's full light goes out (raising the stakes of a wipe in the
    // dark); instead they emit a small, faint danger-red distress beacon so a
    // pitch-black revive run reveals the swarm on them. If EVERYONE is down (e.g. a
    // solo player who just fell), we fall back to full neutral light so they aren't
    // plunged into total black mid-respawn.
    const entries = [...this.entities.entries()];
    const anyLiving = entries.some(([, e]) => !e.downed);
    this.lightSources = entries.map(([id, e]) => {
      if (anyLiving && e.downed) {
        return {
          x: e.sprite.x,
          y: e.sprite.y,
          inner: DISTRESS_LIGHT_INNER,
          outer: DISTRESS_LIGHT_OUTER,
          tint: DISTRESS_TINT_COLOR,
          strength: DISTRESS_TINT_MAX,
        };
      }
      const isLocal = id === this.localId;
      return {
        x: e.sprite.x,
        y: e.sprite.y,
        inner: LIGHT_INNER,
        outer: LIGHT_OUTER,
        tint: e.color,
        strength: isLocal ? 0 : HERO_LIGHT_TINT_MAX,
      };
    });
    // Static torch pools never move — append them so torchlit rooms stay lit even
    // with no hero nearby (the dark gaps between are where secrets hide). Empty on
    // a plain dark floor.
    for (const t of this.torchLights) this.lightSources.push(t);

    // Geometry: explored tiles stay >= EXPLORED_DIM; unexplored fade in with the
    // light. Each tile also tints toward its dominant source's color (per-tile, so
    // the tint is as blocky as the brightness) — neutral white where your own light
    // wins, so it's a no-op cost on a plain solo dark floor.
    for (const c of this.darkCells) {
      const { total, tint } = this.litSample(c.cx, c.cy);
      if (total > LIGHT_VISIBLE_AT) this.explored.add(c.key);
      c.obj.setAlpha(this.explored.has(c.key) ? Math.max(EXPLORED_DIM, total) : total);
      c.obj.setTint(tint);
    }

    // Dynamic entities: hidden unless a light is on them.
    this.mobs.forEach((m) => this.gateByLight(m.sprite.x, m.sprite.y, m.sprite, [m.hpBar]));
    this.loot.forEach((l) => this.gateByLight(l.sprite.x, l.sprite.y, l.sprite, [l.glow]));
    this.crates.forEach((c) => this.gateByLight(c.x, c.y, c));
    this.markers.forEach((m) => this.gateByLight(m.x, m.y, m));
    this.bombs.forEach((b) => this.gateByLight(b.sprite.x, b.sprite.y, b.sprite, [b.glow]));
    this.chests.forEach((ch) => {
      const aux: Dimmable[] = [ch.glow, ch.countdown, ch.hpBar];
      if (ch.door) aux.push(ch.door);
      if (ch.seal) aux.push(ch.seal);
      this.gateByLight(ch.worldX, ch.worldY, ch.sprite, aux);
    });

    // The ladder: hidden until a hero's light first reaches it, then it stays.
    if (!this.exitDiscovered && this.litAt(this.exitX, this.exitY) > LIGHT_VISIBLE_AT) {
      this.exitDiscovered = true;
      this.exitMarker?.setVisible(true);
    }
  }

  update(time: number, delta: number) {
    this.sendInput();
    this.handleAttackInput(time);
    this.handleHealInput(time);
    this.handleBombInput();

    // Smoothly interpolate every entity toward its authoritative position.
    // Frame-rate independent lerp factor.
    const k = 1 - Math.pow(0.001, delta / 1000);
    this.entities.forEach((e) => {
      e.sprite.x = Phaser.Math.Linear(e.sprite.x, e.target.x, k);
      e.sprite.y = Phaser.Math.Linear(e.sprite.y, e.target.y, k);
      e.label.x = e.sprite.x;
      e.label.y = e.sprite.y - LABEL_OFFSET;
      if (e.distress) e.distress.setPosition(e.sprite.x, e.sprite.y);
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
    this.updateChestNudge();
    this.updateReviveHint();
    // Run last so it has final say over what's visible this frame (it overrides the
    // per-entity show/hide above for anything outside the light). No-op when bright.
    if (this.darkFloor) this.updateDarkness();
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
