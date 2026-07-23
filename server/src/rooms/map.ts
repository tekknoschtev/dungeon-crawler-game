/**
 * The dungeon map. The SERVER is the source of truth: on join it sends the
 * resolved grid to each client via a "map" message, so the client never
 * hard-codes or generates geometry — it just renders what it's told.
 *
 * Geometry is produced by a small SEEDED room-and-corridor generator: we place
 * a handful of non-overlapping rectangular rooms and join them with L-shaped
 * corridors. Because everything is driven by the numeric seed (stored in
 * DungeonState and generated here on room create) plus the depth biome — itself
 * a pure function of depth — every client in a room gets the exact same
 * dungeon, and we can reproduce any layout later.
 */
export const TILE = 16; // pixel size of one tile (native art size; the client zooms)
export const MAP_W = 60; // tiles (fixed — all presets share the same grid)
export const MAP_H = 40; // tiles

/**
 * Named floor archetypes. One is picked per floor from the seeded RNG, so every
 * client in a room sees exactly the same layout. Adding a new preset here is the
 * only thing needed to add a new floor type.
 */
interface FloorPreset {
  name: string;
  roomMin: number;    // min room side (tiles)
  roomMax: number;    // max room side (tiles)
  roomAttempts: number; // placement attempts before giving up
  maxRooms: number;   // cap on accepted rooms
  propChance: number; // per-tile probability of a prop on a room edge
}

/**
 * Per-floor lighting modifier — a GAMEPLAY axis, not cosmetics. "bright" is the
 * normal fully-lit floor; "dark" floors render only what a hero's light reaches,
 * so mobs/loot/crates/the ladder stay hidden until approached. "torchlit" floors
 * are dark too, but static wall torches throw permanent pools of light — and
 * secrets (bonus crates + a loose loot drop) hide in the deliberate gaps between
 * them, revealed only when a hero's light reaches the shadow. The client owns the
 * actual vision rendering; the server rolls the mode + owns torch/secret POSITIONS
 * (the light those torches cast is a client render concern). Sent in the "map"
 * message.
 */
export const LIGHTING = ["bright", "dark", "torchlit"] as const;
export type Lighting = (typeof LIGHTING)[number];
// Roughly one floor in three is dark — frequent enough to matter, rare enough to
// stay a "change of pace." Tunable; a dev override lives in DungeonRoom.
const DARK_CHANCE = 0.34;
// ...and a bit over one in five is torchlit (rolled from the same draw, after the
// dark slice). So past floor 1: ~34% dark, ~22% torchlit, the rest bright.
const TORCHLIT_CHANCE = 0.22;

/**
 * Depth biome (M15): every ~5 floors the dungeon becomes a different place.
 * Pure function of depth (no RNG draw). The client maps the name to a
 * tile-sheet texture; bands whose art isn't built yet fall back to stone so
 * the band table can lead the kits. Sent in the "map" message.
 *
 * Since the floorplans milestone (docs/biome-floorplans-plan.md) the biome is
 * also a GENERATION input, not just cosmetics: it weights the archetype roll
 * (see BIOME_PRESET_WEIGHTS) and salts the quirk RNG, so geometry is a pure
 * function of (seed, biome). Stone is the untouched baseline — floors 1-4 keep
 * the legacy seed-only layouts bit-for-bit (regression-pinned in map.test.ts).
 */
// The first four are the depth bands; frost/goldvault/flesh are SPECIAL-floor
// kits — shipped sheets + valid names (so the DUNGEON_BIOME override and any
// future special-floor roll can summon them) but never returned by
// biomeForDepth. Their trigger design is an open backlog item.
export const BIOMES = ["stone", "overgrown", "crypt", "ember", "frost", "goldvault", "flesh"] as const;
export type Biome = (typeof BIOMES)[number];
// Band kits that exist as shipped sheets (see docs/biome-art-plan.md).
const BUILT_BIOMES: ReadonlySet<Biome> = new Set(["stone", "overgrown", "crypt", "ember"]);

export function biomeForDepth(depth: number): Biome {
  const band: Biome =
    depth <= 4 ? "stone" : depth <= 9 ? "overgrown" : depth <= 14 ? "crypt" : "ember";
  return BUILT_BIOMES.has(band) ? band : "stone";
}

const PRESETS: readonly FloorPreset[] = [
  // Many small rooms connected by a tangle of corridors. Cramped fights,
  // lots of crates to smash, easy to get lost.
  { name: "warren", roomMin: 4, roomMax: 7,  roomAttempts: 200, maxRooms: 18, propChance: 0.10 },
  // Balanced mid-range — the original generator defaults.
  { name: "standard", roomMin: 5, roomMax: 11, roomAttempts: 120, maxRooms: 14, propChance: 0.05 },
  // A handful of big open rooms. Wide-open fights, few props, easier to navigate.
  { name: "hall",   roomMin: 7, roomMax: 15, roomAttempts: 80,  maxRooms: 7,  propChance: 0.02 },
];
const [WARREN, STANDARD, HALL] = PRESETS;

// Biome-only presets (floorplans milestone) — never rolled on stone floors.
// Tiny rooms, few of them, so the long L-corridors between them dominate — an
// ossuary of passages. PR B's burial-niche quirk decorates those corridors.
const CATACOMBS: FloorPreset =
  { name: "catacombs", roomMin: 4, roomMax: 6, roomAttempts: 140, maxRooms: 8, propChance: 0.08 };
// Frost's hall variant: glacial chambers — hall but bigger still, so the ice
// reads as wide-open sheets (and the art's ice slicks get room to scatter).
const GLACIAL: FloorPreset =
  { name: "glacial", roomMin: 9, roomMax: 17, roomAttempts: 80, maxRooms: 6, propChance: 0.02 };
// Goldvault's hall variant: hall geometry with propChance cranked — a treasury
// is FULL of crates to smash (feeds the key hunt + treasure mood). PR C layers
// the real interior fill + symmetry stretch on top.
const TREASURY: FloorPreset =
  { name: "treasury", roomMin: 7, roomMax: 15, roomAttempts: 80, maxRooms: 7, propChance: 0.30 };

/**
 * Per-biome archetype weights (floorplans milestone): each biome keeps drawing
 * exactly ONE number from the main RNG for its archetype, but maps that draw
 * through its own weight table, so each biome is SHAPED differently, not just
 * skinned. Stone deliberately bypasses this table — it keeps the legacy uniform
 * `PRESETS[floor(roll * 3)]` mapping bit-for-bit so pre-floorplans layouts
 * survive seed-for-seed (its entry here is documentation only).
 */
const BIOME_PRESET_WEIGHTS: Record<Biome, readonly (readonly [FloorPreset, number])[]> = {
  stone:     [[WARREN, 1], [STANDARD, 1], [HALL, 1]],
  overgrown: [[WARREN, 45], [STANDARD, 35], [HALL, 20]], // root-tangle warrens
  crypt:     [[WARREN, 10], [STANDARD, 25], [HALL, 15], [CATACOMBS, 50]],
  ember:     [[WARREN, 15], [STANDARD, 35], [HALL, 50]], // scorched-open halls
  frost:     [[WARREN, 10], [STANDARD, 25], [GLACIAL, 65]],
  goldvault: [[STANDARD, 20], [TREASURY, 80]], // never a warren — vaults are grand
  flesh:     [[WARREN, 70], [STANDARD, 20], [HALL, 10]], // a digestive tract
};

/** Map the single archetype roll to a preset through the biome's weight table. */
function pickPreset(biome: Biome, roll: number): FloorPreset {
  if (biome === "stone") return PRESETS[Math.floor(roll * PRESETS.length)]; // legacy mapping, untouched
  const weights = BIOME_PRESET_WEIGHTS[biome];
  const total = weights.reduce((sum, [, w]) => sum + w, 0);
  let r = roll * total;
  for (const [preset, w] of weights) {
    r -= w;
    if (r < 0) return preset;
  }
  return weights[weights.length - 1][0]; // roll ≈ 1.0 edge
}

/**
 * mulberry32 — a tiny, fast, seedable PRNG. Deterministic for a given seed and
 * good enough for level layout. Returns a float in [0, 1).
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

function roomCenter(r: Rect): { x: number; y: number } {
  return { x: Math.floor(r.x + r.w / 2), y: Math.floor(r.y + r.h / 2) };
}

/** Overlap test with a 1-tile margin so rooms never share a wall. */
function overlaps(a: Rect, b: Rect): boolean {
  return (
    a.x <= b.x + b.w &&
    a.x + a.w >= b.x &&
    a.y <= b.y + b.h &&
    a.y + a.h >= b.y
  );
}

/**
 * Erode thin wall fragments left behind by carving. A wall touching floor on 3+
 * orthogonal sides is a nub/speck/protrusion that renders as odd floating
 * debris; removing it repeatedly until stable peels whole protrusions away while
 * leaving structural walls (≤2 floor sides) and the solid 1-tile border intact
 * (border cells always keep wall neighbors above/below or left/right). Pruning
 * only opens floor, so the level stays fully connected.
 */
function pruneWallNubs(grid: number[][]): void {
  const floorNeighbors = (x: number, y: number): number => {
    let n = 0;
    if (y > 0 && grid[y - 1][x] === 0) n++;
    if (y < MAP_H - 1 && grid[y + 1][x] === 0) n++;
    if (x > 0 && grid[y][x - 1] === 0) n++;
    if (x < MAP_W - 1 && grid[y][x + 1] === 0) n++;
    return n;
  };

  for (let changed = true; changed; ) {
    changed = false;
    for (let y = 0; y < MAP_H; y++) {
      for (let x = 0; x < MAP_W; x++) {
        if (grid[y][x] === 1 && floorNeighbors(x, y) >= 3) {
          grid[y][x] = 0;
          changed = true;
        }
      }
    }
  }
}

/** FNV-1a hash of a string — salts the quirk RNG stream per biome. */
function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Biome quirk hook (floorplans milestone). Runs AFTER room/corridor carving and
 * BEFORE nub-pruning + vault/exit/spawn/prop placement, so the pruner smooths
 * whatever a quirk does and everything downstream (sealed vault, reachability
 * flood-fill, prop spawns) just works on the quirked grid. Quirks draw ONLY
 * from the quirk RNG — `mulberry32(seed ^ hashString(biome))`, a second stream —
 * never the main one, so a quirk can never shift room placement, corridor
 * flips, or the lighting roll of a given seed.
 *
 * Breaches, niches and bulges only ever turn wall INTO floor, so they cannot
 * disconnect anything — connectivity is safe by construction. Ember's
 * scorched chasms are the set's one wall-ADDING quirk and carry containment
 * guarantees instead (see scorchedChasms). Frost has no carve quirk on
 * purpose: its big glacial halls (the GLACIAL preset) ARE the quirk; and
 * goldvault's treasury fill is a prop pass in loadMap, not a carve.
 *
 * Exported for direct unit tests of each quirk's contract (map.test.ts).
 */
export function applyBiomeQuirks(
  grid: number[][],
  rooms: Rect[],
  biome: Biome,
  quirkRand: () => number
): void {
  switch (biome) {
    case "overgrown":
      rootBreaches(grid, quirkRand);
      break;
    case "crypt":
      burialNiches(grid, quirkRand);
      break;
    case "flesh":
      organicBulges(grid, quirkRand);
      break;
    case "ember":
      scorchedChasms(grid, rooms, quirkRand);
      break;
    // stone: untouched baseline. frost: no carve quirk on purpose (glacial IS
    // its quirk). goldvault: its treasury fill is a PROP pass, not a carve —
    // see treasuryFill, called from loadMap after normal prop placement.
  }
}

// Scorched chasms (ember): big rooms get a 2-3 tile wall blob re-added near
// the middle — rendered in ember's near-black rock, it reads as a collapse /
// lava pit. Arenas with an obstacle to fight around instead of empty halls.
// This is the set's one wall-ADDING quirk, so it carries containment
// guarantees instead of the carve-only safety argument:
//  - blobs are >=2 wide on both axes, so every blob tile keeps <=2 floor
//    neighbors and the nub-pruner can never eat the pit;
//  - a blob keeps a >=2-tile floor ring inside its room, so nothing that
//    crosses the room (corridors included) can be pinched off;
//  - a blob never covers the room's center tile — that tile is load-bearing
//    downstream (spawns, the exit pick, and the prop flood-fill start are all
//    room centers). A 7x7 room can't fit a blob that dodges its center with
//    the ring intact, so those stay open arenas.
const CHASM_MIN_SIDE = 7; // room must be at least this on both axes
const CHASM_CHANCE = 0.8; // per eligible room — a few big halls stay open
const CHASM_RING = 2; // guaranteed floor ring between blob and room walls

function scorchedChasms(grid: number[][], rooms: Rect[], rand: () => number): void {
  for (const room of rooms) {
    if (room.w < CHASM_MIN_SIDE || room.h < CHASM_MIN_SIDE) continue;
    if (rand() >= CHASM_CHANCE) continue;
    const bw = 2 + Math.floor(rand() * 2); // 2-3
    const bh = 2 + Math.floor(rand() * 2);
    const center = roomCenter(room);
    // Every placement that keeps the ring AND dodges the center tile.
    const options: { x: number; y: number }[] = [];
    for (let x0 = room.x + CHASM_RING; x0 + bw <= room.x + room.w - CHASM_RING; x0++) {
      for (let y0 = room.y + CHASM_RING; y0 + bh <= room.y + room.h - CHASM_RING; y0++) {
        const coversCenter =
          center.x >= x0 && center.x < x0 + bw && center.y >= y0 && center.y < y0 + bh;
        if (!coversCenter) options.push({ x: x0, y: y0 });
      }
    }
    if (options.length === 0) continue;
    const { x, y } = options[Math.floor(rand() * options.length)];
    for (let yy = y; yy < y + bh; yy++) {
      for (let xx = x; xx < x + bw; xx++) grid[yy][xx] = 1;
    }
  }
}

// Root breaches (overgrown): a handful of short straight tunnels burst through
// the rock between two nearby floor spaces, like roots forced a way. Loopier
// floors: more escape routes, kite-friendly for the bat/spider band. (Walls
// exactly 1 thick barely exist in these layouts — rooms never share walls — so
// a breach is allowed to punch through up to BREACH_MAX_LEN tiles of rock.)
const BREACH_MIN = 4;
const BREACH_MAX = 8;
const BREACH_MAX_LEN = 3; // a root can burst through rock up to this thick

function rootBreaches(grid: number[][], rand: () => number): void {
  const isFloor = (x: number, y: number) =>
    x >= 0 && y >= 0 && x < MAP_W && y < MAP_H && grid[y][x] === 0;
  const interior = (x: number, y: number) =>
    x >= 1 && y >= 1 && x <= MAP_W - 2 && y <= MAP_H - 2;

  // A candidate is a straight run of 1..BREACH_MAX_LEN interior wall tiles with
  // floor at both ends. Scanning east + south from every floor tile finds each
  // tunnel exactly once. Carving only ever opens floor → connectivity-safe.
  const runs: { x: number; y: number }[][] = [];
  for (let y = 1; y < MAP_H - 1; y++) {
    for (let x = 1; x < MAP_W - 1; x++) {
      if (grid[y][x] !== 0) continue; // tunnels start from floor
      for (const { dx, dy } of [{ dx: 1, dy: 0 }, { dx: 0, dy: 1 }]) {
        const cells: { x: number; y: number }[] = [];
        let cx = x + dx, cy = y + dy;
        while (cells.length < BREACH_MAX_LEN && interior(cx, cy) && grid[cy][cx] === 1) {
          cells.push({ x: cx, y: cy });
          cx += dx;
          cy += dy;
        }
        if (cells.length > 0 && isFloor(cx, cy)) runs.push(cells);
      }
    }
  }

  const target = BREACH_MIN + Math.floor(rand() * (BREACH_MAX - BREACH_MIN + 1));
  for (let i = 0; i < target && runs.length > 0; i++) {
    const pick = Math.floor(rand() * runs.length);
    // Earlier tunnels may have opened part of this one already — carving the
    // remaining wall cells is still pure floor-opening, so it stays safe.
    for (const c of runs.splice(pick, 1)[0]) grid[c.y][c.x] = 0;
  }
}

// Burial niches (crypt): 1-tile alcoves carved into the walls of straight
// corridors at intervals, alternating sides — ambush pockets and crate homes.
// Especially at home in the catacombs preset, whose long corridors dominate.
const NICHE_MIN_RUN = 5; // a corridor must run at least this straight to earn niches
const NICHE_INTERVAL = 3; // tiles between alcoves along the run

function burialNiches(grid: number[][], rand: () => number): void {
  // An alcove is only carved as a true POCKET: a wall tile whose ONLY floor
  // neighbor (in the live grid, so earlier alcoves count) is the corridor tile
  // it opens onto. That's what keeps a niche from ever joining two floor
  // spaces — breaching is overgrown's identity, not crypt's — including the
  // corner case of alcoves from perpendicular runs landing side by side. The
  // border stays untouched (interior-bounds check; the pocket floor keeps 3
  // wall sides, so the nub-pruner leaves it alone).
  const pocket = (x: number, y: number): boolean => {
    if (x < 1 || y < 1 || x > MAP_W - 2 || y > MAP_H - 2) return false;
    if (grid[y][x] !== 1) return false;
    const floorSides =
      (grid[y - 1][x] === 0 ? 1 : 0) +
      (grid[y + 1][x] === 0 ? 1 : 0) +
      (grid[y][x - 1] === 0 ? 1 : 0) +
      (grid[y][x + 1] === 0 ? 1 : 0);
    return floorSides === 1;
  };

  // One straight corridor run: floor tiles walled on both perpendicular sides.
  // `sx/sy` step along the run; alcoves alternate between the two walls.
  const carveRun = (
    startX: number, startY: number, len: number,
    sx: number, sy: number // unit step along the run (perp is (sy, sx))
  ) => {
    const phase = Math.floor(rand() * NICHE_INTERVAL); // vary where the first alcove sits
    let side = rand() < 0.5 ? 1 : -1;
    for (let i = phase; i < len; i += NICHE_INTERVAL) {
      const cx = startX + sx * i, cy = startY + sy * i;
      const dx = sy * side, dy = sx * side;
      if (pocket(cx + dx, cy + dy)) {
        grid[cy + dy][cx + dx] = 0;
        side = -side;
      }
    }
  };

  // Horizontal runs…
  for (let y = 1; y < MAP_H - 1; y++) {
    let run = 0;
    for (let x = 1; x < MAP_W; x++) {
      const corridor =
        x < MAP_W - 1 && grid[y][x] === 0 && grid[y - 1][x] === 1 && grid[y + 1][x] === 1;
      if (corridor) run++;
      else {
        if (run >= NICHE_MIN_RUN) carveRun(x - run, y, run, 1, 0);
        run = 0;
      }
    }
  }
  // …then vertical runs.
  for (let x = 1; x < MAP_W - 1; x++) {
    let run = 0;
    for (let y = 1; y < MAP_H; y++) {
      const corridor =
        y < MAP_H - 1 && grid[y][x] === 0 && grid[y][x - 1] === 1 && grid[y][x + 1] === 1;
      if (corridor) run++;
      else {
        if (run >= NICHE_MIN_RUN) carveRun(x, y - run, run, 0, 1);
        run = 0;
      }
    }
  }
}

// Organic bulges (flesh): every floor-adjacent wall gets a small chance to melt
// open. Bulge-only erosion — walls only become floor — then the nub-pruner
// smooths the mess. Rooms stop being rectangles; the warren reads as a
// digestive tract. Pairs with the client's wall-eating blotch art.
const BULGE_CHANCE = 0.14;

function organicBulges(grid: number[][], rand: () => number): void {
  // Candidates snapshot BEFORE melting so one pass can't cascade outward —
  // and one rand() draw per candidate keeps the stream aligned regardless of
  // which walls actually melt.
  const candidates: { x: number; y: number }[] = [];
  for (let y = 1; y < MAP_H - 1; y++) {
    for (let x = 1; x < MAP_W - 1; x++) {
      if (grid[y][x] !== 1) continue;
      if (
        grid[y - 1][x] === 0 || grid[y + 1][x] === 0 ||
        grid[y][x - 1] === 0 || grid[y][x + 1] === 0
      ) {
        candidates.push({ x, y });
      }
    }
  }
  for (const c of candidates) {
    if (rand() < BULGE_CHANCE) grid[c.y][c.x] = 0;
  }
}

/**
 * A piece of solid furniture (barrel, crate, anvil…) sitting on a floor tile.
 * It's a real obstacle: the server adds it to collision and keeps mobs/loot off
 * it, and the client renders the sprite. x/y are TILE coords; frame is the Tiny
 * Dungeon sheet index.
 */
export interface Prop {
  x: number;
  y: number;
  frame: number;
  // True for crates/barrels/kegs that can be destroyed mid-floor (synced via
  // state.crates). False for static furniture (anvil) that never changes.
  breakable: boolean;
}

/**
 * The vault chamber (M4): a small sealed room carved off the dungeon, reached
 * only through a single 1-tile doorway. `chest` is the chamber-center tile the
 * vault sits on; `door` is the lone connecting tile (the server seals it in its
 * collision grid while the vault is locked, so the chamber is impassable until
 * the timer opens it). Both in TILE coords. Null when no chamber could be placed
 * (dense layout) — the server falls back to a magic-seal on an open tile.
 */
export interface VaultPlacement {
  chest: { x: number; y: number };
  door: { x: number; y: number };
}

export interface LoadedMap {
  tile: number;
  width: number; // in tiles
  height: number; // in tiles
  /** grid[y][x] === 1 means wall, 0 means floor */
  grid: number[][];
  /** spawn points in pixel coordinates (tile centers), all on room floor */
  spawns: { x: number; y: number }[];
  /** solid decorative props (collidable furniture) on floor tiles */
  props: Prop[];
  /** the descent point in TILE coords; standing on it lets the party go deeper */
  exit: { x: number; y: number };
  /** the strange stairway's TILE coords (special floors): an uncommon second exit
   *  that detours a gathered party into a goldvault treasure floor, or null when
   *  this floor has none (the common case). Seeded; see placeStrangeStairway. */
  strangeStairway: { x: number; y: number } | null;
  /** the sealed vault chamber, or null when none could be placed (see VaultPlacement) */
  vault: VaultPlacement | null;
  /** which floor archetype was rolled for this seed (server-side info, not sent to clients) */
  preset: string;
  /** lighting mode for this floor; sent to clients so they render the vision bubble */
  lighting: Lighting;
  /** depth biome for this floor (M15, cosmetic); the client picks its tile sheet by this */
  biome: Biome;
  /** torchlit floors only: wall tiles (TILE coords) carrying a static torch. The
   *  client renders the sconce + a warm glow and adds each as an always-on light
   *  source. Empty on bright/dark floors. */
  torches: { x: number; y: number }[];
  /** torchlit floors only: floor tiles (TILE coords) seeding a loose bonus loot
   *  drop in the unlit gaps between torches — the server spawns a drop on each at
   *  floor-enter. Empty on bright/dark floors. */
  secretLoot: { x: number; y: number }[];
}

// Prop placement. Props go only on room-edge tiles (exactly one orthogonal wall
// neighbor) so they never sit in a 1-wide corridor, and any candidate that would
// wall off part of the dungeon is rejected (see placeProps). Density is preset-driven.
const PROP_FRAMES = [82, 63, 73, 74, 75]; // keg, crate stack, barrel, anvil, crates
// Frames that represent breakable containers (M6). Anvil (74) is immovable
// furniture; everything else can be smashed for loot + a possible vault key.
const BREAKABLE_FRAMES = new Set([82, 63, 73, 75]); // keg, crate stack, barrel, crates

/**
 * Deterministic [0, 1) hash of a tile coord + salt. Coordinate-only (no seed):
 * props are a pure function of the grid, which is itself seed-deterministic, so
 * the same seed still yields the same props — and the server sends the resolved
 * list to clients, so everyone renders exactly what the server collides against.
 */
function coordHash(x: number, y: number, salt: number): number {
  let h = (x * 374761393 + y * 668265263 + salt * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Count floor tiles reachable from `start`, treating `blocked` tiles as solid. */
function reachableCount(
  grid: number[][],
  start: { x: number; y: number },
  blocked: Set<string>
): number {
  const seen = new Set<string>();
  const stack = [start];
  while (stack.length) {
    const { x, y } = stack.pop()!;
    if (x < 0 || y < 0 || x >= MAP_W || y >= MAP_H) continue;
    const key = `${x},${y}`;
    if (grid[y][x] !== 0 || blocked.has(key) || seen.has(key)) continue;
    seen.add(key);
    stack.push({ x: x + 1, y }, { x: x - 1, y }, { x, y: y + 1 }, { x, y: y - 1 });
  }
  return seen.size;
}

/**
 * Scatter solid props on room-edge floor tiles. Each accepted prop is added one
 * at a time and kept only if the dungeon stays fully connected with it solid, so
 * props can never trap a player or seal off a room. Deterministic for a grid.
 * `exclude` holds tiles props must avoid (the vault chamber + its door) so a
 * barrel never spawns inside the treasure room.
 */
function placeProps(
  grid: number[][],
  spawn: { x: number; y: number },
  propChance: number,
  exclude: Set<string> = new Set()
): Prop[] {
  const isWall = (x: number, y: number) =>
    x < 0 || y < 0 || x >= MAP_W || y >= MAP_H || grid[y][x] === 1;

  let totalFloor = 0;
  for (let y = 0; y < MAP_H; y++) for (let x = 0; x < MAP_W; x++) if (grid[y][x] === 0) totalFloor++;

  const blocked = new Set<string>();
  const props: Prop[] = [];
  for (let y = 0; y < MAP_H; y++) {
    for (let x = 0; x < MAP_W; x++) {
      if (grid[y][x] !== 0) continue;
      if (exclude.has(`${x},${y}`)) continue; // keep props out of the vault
      const wallNeighbors =
        (isWall(x, y - 1) ? 1 : 0) +
        (isWall(x + 1, y) ? 1 : 0) +
        (isWall(x, y + 1) ? 1 : 0) +
        (isWall(x - 1, y) ? 1 : 0);
      if (wallNeighbors !== 1) continue;
      if (coordHash(x, y, 1) >= propChance) continue;

      // Tentatively block it; reject if it would disconnect the floor.
      const key = `${x},${y}`;
      blocked.add(key);
      if (reachableCount(grid, spawn, blocked) !== totalFloor - blocked.size) {
        blocked.delete(key);
        continue;
      }
      const frame = PROP_FRAMES[Math.floor(coordHash(x, y, 2) * PROP_FRAMES.length)];
      props.push({ x, y, frame, breakable: BREAKABLE_FRAMES.has(frame) });
    }
  }
  return props;
}

// Torch placement (torchlit floors). Torches mount only on FRONT-FACING walls — a
// wall tile with floor directly to the SOUTH (the visible brick face) and rock on
// the other three sides. That's the one wall orientation a flat torch sprite reads
// correctly on; side/back walls have no face to hang it on. Sparse on purpose: a
// low per-candidate probability leaves whole stretches unlit, and those gaps are
// where secrets hide. Deterministic for a grid (coordHash, no RNG draw).
const TORCH_CHANCE = 0.14; // per front-facing wall tile (a smaller pool than all walls)

function placeTorches(grid: number[][]): { x: number; y: number }[] {
  const isFloor = (x: number, y: number) =>
    x >= 0 && y >= 0 && x < MAP_W && y < MAP_H && grid[y][x] === 0;
  const torches: { x: number; y: number }[] = [];
  for (let y = 1; y < MAP_H - 1; y++) {
    for (let x = 1; x < MAP_W - 1; x++) {
      if (grid[y][x] !== 1) continue; // torches go on walls
      // Floor to the south, rock on the other three sides → a clean front face.
      if (!isFloor(x, y + 1)) continue;
      if (isFloor(x, y - 1) || isFloor(x + 1, y) || isFloor(x - 1, y)) continue;
      if (coordHash(x, y, 3) >= TORCH_CHANCE) continue;
      torches.push({ x, y });
    }
  }
  return torches;
}

// How far (in tiles) a floor tile must sit from EVERY torch to count as a
// deliberate shadow pocket where secrets hide. Must exceed the client torch
// light radius (≈ LIGHT_OUTER / TILE ≈ 4.5 tiles in GameScene) so a cache truly
// stays dark until a hero — not a torch — lights it.
const SECRET_DARK_THRESHOLD = 5;
const CACHE_CHANCE = 0.22; // per eligible dark room-edge tile → a small crate cluster

/**
 * Seed this torchlit floor's secrets in the unlit gaps between torches:
 *  - extra BREAKABLE crates (returned as props; the room turns them into synced
 *    crates exactly like furniture, so they render hidden-until-lit and drop loot
 *    on smash for free), and
 *  - one loose bonus-loot tile (the single darkest reachable floor tile), which
 *    the room spawns a drop on at floor-enter.
 * Crates are added one at a time with the same connectivity guard as placeProps,
 * so a cache can never wall off the dungeon. Deterministic for a grid + torches.
 */
function placeSecrets(
  grid: number[][],
  start: { x: number; y: number },
  torches: { x: number; y: number }[],
  existing: Prop[],
  exclude: Set<string>
): { crates: Prop[]; loot: { x: number; y: number }[] } {
  if (torches.length === 0) return { crates: [], loot: [] };

  const isWall = (x: number, y: number) =>
    x < 0 || y < 0 || x >= MAP_W || y >= MAP_H || grid[y][x] === 1;
  // Squared distance to the nearest torch (tile space) — cheap, no sqrt.
  const farFromTorches = (x: number, y: number): boolean => {
    let best = Infinity;
    for (const t of torches) {
      const d2 = (t.x - x) ** 2 + (t.y - y) ** 2;
      if (d2 < best) best = d2;
    }
    return best >= SECRET_DARK_THRESHOLD * SECRET_DARK_THRESHOLD;
  };
  const nearestTorchD2 = (x: number, y: number): number => {
    let best = Infinity;
    for (const t of torches) {
      const d2 = (t.x - x) ** 2 + (t.y - y) ** 2;
      if (d2 < best) best = d2;
    }
    return best;
  };

  let totalFloor = 0;
  for (let y = 0; y < MAP_H; y++) for (let x = 0; x < MAP_W; x++) if (grid[y][x] === 0) totalFloor++;

  // Seed the connectivity guard with every already-solid prop tile, so adding a
  // cache crate is checked against the real walkable space.
  const blocked = new Set<string>(existing.map((p) => `${p.x},${p.y}`));

  const crates: Prop[] = [];
  let bonus: { x: number; y: number } | null = null;
  let bonusD2 = SECRET_DARK_THRESHOLD * SECRET_DARK_THRESHOLD; // loot must also be in shadow

  for (let y = 0; y < MAP_H; y++) {
    for (let x = 0; x < MAP_W; x++) {
      if (grid[y][x] !== 0) continue;
      const key = `${x},${y}`;
      if (exclude.has(key) || blocked.has(key)) continue;
      if (!farFromTorches(x, y)) continue;

      // The loose bonus drop: the darkest reachable tile, lying in open floor.
      const d2 = nearestTorchD2(x, y);
      if (d2 > bonusD2) {
        bonusD2 = d2;
        bonus = { x, y };
      }

      // Cache crates: room-edge tiles only (one wall neighbor) so they sit against
      // a wall like furniture, sparse via coordHash, and never disconnecting.
      const wallNeighbors =
        (isWall(x, y - 1) ? 1 : 0) +
        (isWall(x + 1, y) ? 1 : 0) +
        (isWall(x, y + 1) ? 1 : 0) +
        (isWall(x - 1, y) ? 1 : 0);
      if (wallNeighbors !== 1) continue;
      if (coordHash(x, y, 4) >= CACHE_CHANCE) continue;

      blocked.add(key);
      if (reachableCount(grid, start, blocked) !== totalFloor - blocked.size) {
        blocked.delete(key);
        continue;
      }
      const frame = SECRET_CRATE_FRAMES[Math.floor(coordHash(x, y, 5) * SECRET_CRATE_FRAMES.length)];
      crates.push({ x, y, frame, breakable: true });
    }
  }

  // Don't let the bonus drop land on a cache crate tile (it would be hidden inside
  // a smashable). Fall back to no loose drop in the (rare) clash.
  if (bonus && crates.some((c) => c.x === bonus!.x && c.y === bonus!.y)) bonus = null;

  return { crates, loot: bonus ? [bonus] : [] };
}

// Cache crates draw only from breakable container frames (a subset of PROP_FRAMES
// minus the immovable anvil) so every cache crate can actually be smashed for loot.
const SECRET_CRATE_FRAMES = [82, 63, 73, 75]; // keg, crate stack, barrel, crates

// Treasury fill (goldvault, floorplans PR C). Room-interior crate clusters:
// seed tiles sprout on open floor (no wall neighbor — placeProps owns the
// edges) and each cluster spreads to some orthogonal neighbors, so the hoard
// reads as heaps rather than a sprinkle. Every crate is breakable (feeds the
// key hunt + the treasure mood) and added under the same one-at-a-time
// connectivity guard as all props, so a heap can never wall anything off.
const TREASURY_CLUSTER_CHANCE = 0.025; // per interior floor tile → a cluster seed
const TREASURY_SPREAD_CHANCE = 0.55; // per neighbor of a seed → the heap grows

function treasuryFill(
  grid: number[][],
  rooms: Rect[],
  start: { x: number; y: number },
  existing: Prop[],
  exclude: Set<string>
): Prop[] {
  const isWall = (x: number, y: number) =>
    x < 0 || y < 0 || x >= MAP_W || y >= MAP_H || grid[y][x] === 1;

  let totalFloor = 0;
  for (let y = 0; y < MAP_H; y++) for (let x = 0; x < MAP_W; x++) if (grid[y][x] === 0) totalFloor++;

  // Guard against the real walkable space: everything already solid counts.
  const blocked = new Set<string>(existing.map((p) => `${p.x},${p.y}`));
  const crates: Prop[] = [];

  const tryCrate = (x: number, y: number) => {
    const key = `${x},${y}`;
    if (grid[y][x] !== 0 || exclude.has(key) || blocked.has(key)) return;
    blocked.add(key);
    if (reachableCount(grid, start, blocked) !== totalFloor - blocked.size) {
      blocked.delete(key);
      return;
    }
    const frame = SECRET_CRATE_FRAMES[Math.floor(coordHash(x, y, 8) * SECRET_CRATE_FRAMES.length)];
    crates.push({ x, y, frame, breakable: true });
  };

  // Interiors only: scan each room's inner tiles so corridors stay clear for
  // kiting between heaps. Deterministic for a grid (coordHash, no RNG draw).
  for (const room of rooms) {
    for (let y = room.y; y < room.y + room.h; y++) {
      for (let x = room.x; x < room.x + room.w; x++) {
        if (grid[y][x] !== 0) continue;
        const wallNeighbors =
          (isWall(x, y - 1) ? 1 : 0) +
          (isWall(x + 1, y) ? 1 : 0) +
          (isWall(x, y + 1) ? 1 : 0) +
          (isWall(x - 1, y) ? 1 : 0);
        if (wallNeighbors !== 0) continue; // edges belong to placeProps
        if (coordHash(x, y, 6) >= TREASURY_CLUSTER_CHANCE) continue;

        tryCrate(x, y); // the heap's anchor…
        for (const [nx, ny] of [[x, y - 1], [x + 1, y], [x, y + 1], [x - 1, y]] as const) {
          if (coordHash(nx, ny, 7) < TREASURY_SPREAD_CHANCE) tryCrate(nx, ny);
        }
      }
    }
  }
  return crates;
}

// Strange stairway (special floors — docs/special-floors-plan.md). An UNCOMMON
// second exit, visually distinct from the descent: a party that gathers on it is
// detoured into a goldvault treasure floor, then returned to this same floor to
// descend normally. Presence and position are seeded like everything else, but
// drawn from a DEDICATED RNG stream (see loadMap) so adding this feature could
// not shift a single existing layout, lighting roll, or quirk — the same safety
// argument the quirk stream carries.
//
// Placement rules make it a real detour you choose to walk to, and a spot a
// party can physically cluster on:
//  - far from every spawn (you have to go find it) and from the descent (so the
//    two exits never blur together into one ambiguous blob of glow);
//  - all four orthogonal neighbors open floor, so up to four heroes can stand in
//    the gather zone at once without shoving each other into walls;
//  - never on a prop/crate tile or inside the sealed vault chamber.
/** How loadMap should treat the strange stairway — see the `stairway` param. */
export type StairwayMode = "auto" | "always" | "never";

const STAIRWAY_CHANCE = 0.25; // per floor below the first — an uncommon treat, not every run
const STAIRWAY_MIN_SPAWN_DIST = 8; // tiles from where the party lands — a detour, not a doorstep
const STAIRWAY_MIN_EXIT_DIST = 6; // tiles from the descent, so the two read as separate places
// `spawns` is EVERY room center, but a party only ever lands on the first few (the
// room hands out spawns[i % len] for its at-most-four clients). The distance rule
// means "not on the doorstep of where you arrive", so it's measured against those
// — checking all of them would reject most layouts outright on a warren floor,
// where almost every tile is near some room center.
const STAIRWAY_ARRIVAL_SPAWNS = 4; // mirrors DungeonRoom.maxClients

function placeStrangeStairway(
  grid: number[][],
  spawns: { x: number; y: number }[], // TILE coords — the ARRIVAL spawns only
  exit: { x: number; y: number },
  props: Prop[],
  exclude: Set<string>,
  rand: () => number
): { x: number; y: number } | null {
  const solid = new Set(props.map((p) => `${p.x},${p.y}`));
  const open = (x: number, y: number) =>
    x >= 0 && y >= 0 && x < MAP_W && y < MAP_H && grid[y][x] === 0 && !solid.has(`${x},${y}`);

  const candidates: { x: number; y: number }[] = [];
  for (let y = 1; y < MAP_H - 1; y++) {
    for (let x = 1; x < MAP_W - 1; x++) {
      if (!open(x, y) || exclude.has(`${x},${y}`)) continue;
      // Room to gather: the whole plus-shape around it must be standable.
      if (!open(x, y - 1) || !open(x + 1, y) || !open(x, y + 1) || !open(x - 1, y)) continue;
      if ((x - exit.x) ** 2 + (y - exit.y) ** 2 < STAIRWAY_MIN_EXIT_DIST ** 2) continue;
      let farFromSpawns = true;
      for (const s of spawns) {
        if ((s.x - x) ** 2 + (s.y - y) ** 2 < STAIRWAY_MIN_SPAWN_DIST ** 2) {
          farFromSpawns = false;
          break;
        }
      }
      if (!farFromSpawns) continue;
      candidates.push({ x, y });
    }
  }
  // A cramped layout can legitimately offer nowhere sensible — then this floor
  // simply has no stairway (it's uncommon by design, so that reads as normal).
  if (candidates.length === 0) return null;
  return candidates[Math.floor(rand() * candidates.length)];
}

/**
 * Carve a sealed vault chamber off the dungeon: a small SxS room reachable only
 * through ONE doorway tile, so the server can seal that single tile to gate it.
 *
 * Tries to attach the chamber to a room edge, preferring rooms far from the start
 * (treasure deep in the dungeon). A placement is accepted only if the whole
 * footprint (door + chamber) and every orthogonal neighbor of it — except the
 * anchoring room tile — is solid rock, which guarantees the chamber touches the
 * rest of the dungeon ONLY through the door. Carved BEFORE pruneWallNubs so the
 * prune pass tidies any stray nubs; the chamber's 1-thick walls each border at
 * most the interior (≤1 floor neighbor) so prune never opens a second entrance.
 *
 * Returns the chest tile (chamber center), the door tile, and every carved cell
 * (for keeping props out), or null when no spot fits (dense layout → the server
 * uses a magic-seal fallback instead). Mutates `grid` when it succeeds.
 */
function carveVault(
  grid: number[][],
  rooms: Rect[]
): { chest: { x: number; y: number }; door: { x: number; y: number }; cells: string[] } | null {
  if (rooms.length === 0) return null;
  const S = 3; // chamber interior side (odd, so the door centers on a wall)
  const half = (S - 1) / 2;
  const start = roomCenter(rooms[0]);

  const inBounds = (x: number, y: number) => x >= 1 && y >= 1 && x <= MAP_W - 2 && y <= MAP_H - 2;
  const isRock = (x: number, y: number) =>
    x < 0 || y < 0 || x >= MAP_W || y >= MAP_H || grid[y][x] === 1;

  // Farthest rooms first — the vault should reward crossing the floor.
  const ordered = [...rooms].sort((a, b) => {
    const ca = roomCenter(a), cb = roomCenter(b);
    return (cb.x - start.x) ** 2 + (cb.y - start.y) ** 2 - ((ca.x - start.x) ** 2 + (ca.y - start.y) ** 2);
  });
  const dirs = [
    { dx: 1, dy: 0 },
    { dx: 0, dy: 1 },
    { dx: -1, dy: 0 },
    { dx: 0, dy: -1 },
  ];

  for (const room of ordered) {
    for (const { dx, dy } of dirs) {
      // Anchor along the room edge facing (dx, dy).
      const anchors: { x: number; y: number }[] = [];
      if (dx !== 0) {
        const ax = dx > 0 ? room.x + room.w - 1 : room.x;
        for (let y = room.y; y < room.y + room.h; y++) anchors.push({ x: ax, y });
      } else {
        const ay = dy > 0 ? room.y + room.h - 1 : room.y;
        for (let x = room.x; x < room.x + room.w; x++) anchors.push({ x, y: ay });
      }
      const px = dy, py = dx; // perpendicular unit (one of these is 0)

      for (const F of anchors) {
        // Door (d=1) then a 1-tile neck (d=2): a 1-wide, wall-flanked throat that
        // separates the room from the chamber face, so the door's flank tiles
        // aren't pinched between room floor and chamber floor (which would be a
        // 3-floor-neighbor nub). The chamber (SxS) opens beyond the neck (d=3..).
        const door = { x: F.x + dx, y: F.y + dy };
        const footprint = [door, { x: F.x + dx * 2, y: F.y + dy * 2 }];
        const C0 = 3; // first chamber depth (past door + neck)
        for (let d = C0; d <= C0 + S - 1; d++) {
          for (let p = -half; p <= half; p++) {
            footprint.push({ x: F.x + dx * d + px * p, y: F.y + dy * d + py * p });
          }
        }
        const fset = new Set(footprint.map((c) => `${c.x},${c.y}`));
        const fkey = `${F.x},${F.y}`;

        // Every footprint tile must be in-bounds rock; every orthogonal neighbor
        // of the footprint (bar the anchor) must be rock too — so the only opening
        // is the door↔anchor seam.
        let ok = true;
        for (const c of footprint) {
          if (!inBounds(c.x, c.y) || !isRock(c.x, c.y)) { ok = false; break; }
          for (const [nx, ny] of [[c.x, c.y - 1], [c.x + 1, c.y], [c.x, c.y + 1], [c.x - 1, c.y]] as const) {
            const k = `${nx},${ny}`;
            if (k === fkey || fset.has(k)) continue;
            if (!isRock(nx, ny)) { ok = false; break; }
          }
          if (!ok) break;
        }
        if (!ok) continue;

        // Nub guard: reject if carving would leave any surrounding wall touching
        // floor on 3+ sides (carved AFTER pruneWallNubs, so we can't lean on it to
        // tidy up). Treat the footprint as floor and check each ring wall tile.
        const floorAfter = (x: number, y: number) =>
          fset.has(`${x},${y}`) || (x >= 0 && y >= 0 && x < MAP_W && y < MAP_H && grid[y][x] === 0);
        const checked = new Set<string>();
        for (const c of footprint) {
          for (const [nx, ny] of [[c.x, c.y - 1], [c.x + 1, c.y], [c.x, c.y + 1], [c.x - 1, c.y]] as const) {
            const k = `${nx},${ny}`;
            if (fset.has(k) || checked.has(k) || isRock(nx, ny) === false) continue; // only ring WALLS
            checked.add(k);
            const fn =
              (floorAfter(nx, ny - 1) ? 1 : 0) +
              (floorAfter(nx + 1, ny) ? 1 : 0) +
              (floorAfter(nx, ny + 1) ? 1 : 0) +
              (floorAfter(nx - 1, ny) ? 1 : 0);
            if (fn >= 3) { ok = false; break; }
          }
          if (!ok) break;
        }
        if (!ok) continue;

        for (const c of footprint) grid[c.y][c.x] = 0; // carve door + neck + chamber
        const mid = C0 + half; // chamber center along the dir (chamber spans C0..C0+S-1)
        return {
          chest: { x: F.x + dx * mid, y: F.y + dy * mid },
          door,
          cells: [...fset],
        };
      }
    }
  }
  return null;
}

/**
 * Build a dungeon from a seed. Geometry is a pure function of (seed, biome):
 * the same seed within the same biome band always yields the identical layout,
 * so every co-op client and every re-run agrees. Biome is itself a pure band
 * lookup on depth (see biomeForDepth), and stone — floors 1-4 — keeps the
 * legacy seed-only layouts bit-for-bit. Beyond geometry, `depth` only gates
 * the lighting roll and the strange-stairway roll (floor 1 gets neither — see
 * below).
 *
 * `stairway` controls the strange stairway: "auto" is the real rule (an uncommon
 * seeded roll, never on floor 1); "never" suppresses it outright — the room passes
 * that for the vault floor the stairway leads TO (no nested vaults) and for the
 * floor a party is returned to (the detour is spent, so the vault can't be farmed
 * in a loop); "always" is the DUNGEON_STAIRWAY dev override, which skips both the
 * roll and the floor-1 exemption so the feature can be exercised without
 * reroll-fishing. See DungeonRoom.enterFloor.
 */
export function loadMap(
  seed: number,
  depth = 1,
  forced?: Lighting,
  forcedBiome?: Biome,
  stairway: StairwayMode = "auto"
): LoadedMap {
  const rand = mulberry32(seed);
  const randInt = (min: number, max: number) =>
    min + Math.floor(rand() * (max - min + 1));

  // Resolve the biome FIRST (pure band lookup, no RNG draw): since the
  // floorplans milestone it shapes generation — it weights the archetype roll
  // and salts the quirk stream below.
  const biome = forcedBiome ?? biomeForDepth(depth);
  // Second RNG stream for biome quirks, so quirks never consume (or shift) the
  // main stream's draws — which seeds roll dark/torchlit stays quirk-proof.
  const quirkRand = mulberry32((seed ^ hashString(biome)) >>> 0);

  // Pick a floor archetype first — exactly one main-RNG draw for EVERY biome
  // (so the streams stay aligned); the biome only changes how that draw maps
  // to a preset. Stone keeps the legacy uniform mapping.
  const preset = pickPreset(biome, rand());

  // Start solid; we carve floors out of the rock.
  const grid: number[][] = Array.from({ length: MAP_H }, () =>
    Array.from({ length: MAP_W }, () => 1)
  );

  const carveRoom = (r: Rect) => {
    for (let y = r.y; y < r.y + r.h; y++) {
      for (let x = r.x; x < r.x + r.w; x++) {
        grid[y][x] = 0;
      }
    }
  };

  // Carve a 1-tile-wide horizontal then vertical run (an L-shaped corridor).
  const carveH = (x1: number, x2: number, y: number) => {
    for (let x = Math.min(x1, x2); x <= Math.max(x1, x2); x++) grid[y][x] = 0;
  };
  const carveV = (y1: number, y2: number, x: number) => {
    for (let y = Math.min(y1, y2); y <= Math.max(y1, y2); y++) grid[y][x] = 0;
  };

  const rooms: Rect[] = [];
  for (let i = 0; i < preset.roomAttempts && rooms.length < preset.maxRooms; i++) {
    const w = randInt(preset.roomMin, preset.roomMax);
    const h = randInt(preset.roomMin, preset.roomMax);
    // keep a 1-tile border of solid rock around the whole map
    const x = randInt(1, MAP_W - w - 1);
    const y = randInt(1, MAP_H - h - 1);
    const candidate: Rect = { x, y, w, h };

    if (rooms.some((r) => overlaps(r, candidate))) continue;

    carveRoom(candidate);

    // Connect each new room to the previous one with an L-shaped corridor.
    if (rooms.length > 0) {
      const prev = roomCenter(rooms[rooms.length - 1]);
      const cur = roomCenter(candidate);
      if (rand() < 0.5) {
        carveH(prev.x, cur.x, prev.y);
        carveV(prev.y, cur.y, cur.x);
      } else {
        carveV(prev.y, cur.y, prev.x);
        carveH(prev.x, cur.x, cur.y);
      }
    }

    rooms.push(candidate);
  }

  // Biome quirks reshape the freshly-carved grid (root breaches, burial
  // niches, organic bulges, scorched chasms). Runs before pruning so the
  // pruner tidies up after them, and before all placement so downstream code
  // sees the final grid.
  applyBiomeQuirks(grid, rooms, biome, quirkRand);

  // Clean up thin wall fragments the carving (or a quirk) leaves behind.
  pruneWallNubs(grid);

  // Carve the sealed vault chamber AFTER pruning: prune opens walls with 3+ floor
  // neighbors, which — run on a freshly-carved chamber — would punch a second
  // entrance and break the single-door seal. Carving last keeps the chamber
  // isolated (its walls touch the chamber on ≤1 side, and the door is the only
  // seam), at the cost of the carve being responsible for not leaving nubs itself
  // (it doesn't: chamber walls ≤1 floor neighbor, door flanks ≤2). Its tiles are
  // kept off prop placement below.
  const vaultCarve = carveVault(grid, rooms);

  // Spawns are room centers (guaranteed floor, comfortably inside a room).
  const spawns = rooms.map((r) => {
    const c = roomCenter(r);
    return { x: c.x * TILE + TILE / 2, y: c.y * TILE + TILE / 2 };
  });

  // Solid furniture on room edges. The connectivity guard floods from a known
  // floor tile (the first room center), so it needs a room to exist. Keep props
  // out of the vault chamber.
  const start = rooms.length > 0 ? roomCenter(rooms[0]) : { x: 1, y: 1 };
  const props = placeProps(grid, start, preset.propChance, new Set(vaultCarve?.cells ?? []));

  // Exit = the room center farthest from the start room, so descending means
  // actually crossing the floor rather than standing on the stairs you spawned at.
  let exit = start;
  let bestD = -1;
  for (const r of rooms) {
    const c = roomCenter(r);
    const d = (c.x - start.x) ** 2 + (c.y - start.y) ** 2;
    if (d > bestD) {
      bestD = d;
      exit = c;
    }
  }

  const vault: VaultPlacement | null = vaultCarve
    ? { chest: vaultCarve.chest, door: vaultCarve.door }
    : null;

  // Strange stairway (special floors): the goldvault detour's trigger. Rolled on
  // its OWN RNG stream — like the quirk stream — so neither the presence roll nor
  // the position pick can consume a draw from the main stream, and every layout,
  // lighting roll and quirk that existed before this feature is bit-for-bit
  // unchanged. Floor 1 is exempt for the same reason it's never dark: the opening
  // floor should teach the normal descent before it offers a strange one.
  let strangeStairway: { x: number; y: number } | null = null;
  if (stairway !== "never" && rooms.length > 0 && (depth > 1 || stairway === "always")) {
    const stairRand = mulberry32((seed ^ hashString("stairway")) >>> 0);
    if (stairway === "always" || stairRand() < STAIRWAY_CHANCE) {
      strangeStairway = placeStrangeStairway(
        grid,
        rooms.slice(0, STAIRWAY_ARRIVAL_SPAWNS).map(roomCenter),
        exit,
        props,
        new Set(vaultCarve?.cells ?? []),
        stairRand
      );
    }
  }
  // Keep crates/secrets off the stairway and its gather ring, so the zone a party
  // has to stand in can't be walled up by a treasure heap.
  const stairwayCells = strangeStairway
    ? [
        `${strangeStairway.x},${strangeStairway.y}`,
        `${strangeStairway.x},${strangeStairway.y - 1}`,
        `${strangeStairway.x + 1},${strangeStairway.y}`,
        `${strangeStairway.x},${strangeStairway.y + 1}`,
        `${strangeStairway.x - 1},${strangeStairway.y}`,
      ]
    : [];

  // Goldvault treasury fill (floorplans PR C): on top of the treasury preset's
  // crate-heavy room EDGES, scatter breakable crate clusters through room
  // INTERIORS — a treasury is FULL of things to smash. A prop pass, not a
  // carve (grid-pure via coordHash, connectivity-guarded like all props), so
  // it lives here after normal placement rather than in applyBiomeQuirks.
  if (biome === "goldvault" && rooms.length > 0) {
    const exclude = new Set<string>([
      ...(vaultCarve?.cells ?? []),
      `${exit.x},${exit.y}`,
      ...stairwayCells,
      ...spawns.map((s) => `${Math.floor(s.x / TILE)},${Math.floor(s.y / TILE)}`),
    ]);
    props.push(...treasuryFill(grid, rooms, start, props, exclude));
  }

  // Lighting mode — rolled last so it never perturbs the geometry RNG above (a
  // given seed keeps its exact layout). Independent of the preset. Floor 1 is
  // always bright: the game should be playable on sight, and opening on a dark
  // floor (with no tutorial) would read as a turn-off rather than a twist. One
  // RNG draw splits past-floor-1 floors into dark / torchlit / bright slices. A
  // `forced` mode (dev override) wins outright and still consumes the draw, so
  // forcing one floor doesn't shift the layouts of other floors in a run.
  let lighting: Lighting = "bright";
  const lightingRoll = rand();
  if (forced) {
    lighting = forced;
  } else if (depth > 1) {
    if (lightingRoll < DARK_CHANCE) lighting = "dark";
    else if (lightingRoll < DARK_CHANCE + TORCHLIT_CHANCE) lighting = "torchlit";
  }

  // Torchlit floors get static wall torches plus secrets (extra crates + a loose
  // bonus drop) seeded in the shadows between them. Both are pure functions of the
  // grid (coordHash, no RNG draw), so they never perturb the geometry above — a
  // given seed keeps its exact layout no matter which mode it rolls.
  let torches: { x: number; y: number }[] = [];
  let secretLoot: { x: number; y: number }[] = [];
  if (lighting === "torchlit") {
    torches = placeTorches(grid);
    const exclude = new Set<string>([
      ...(vaultCarve?.cells ?? []),
      `${exit.x},${exit.y}`,
      ...stairwayCells,
      ...spawns.map((s) => `${Math.floor(s.x / TILE)},${Math.floor(s.y / TILE)}`),
    ]);
    const secrets = placeSecrets(grid, start, torches, props, exclude);
    props.push(...secrets.crates);
    secretLoot = secrets.loot;
  }

  return { tile: TILE, width: MAP_W, height: MAP_H, grid, spawns, props, exit, strangeStairway, vault, preset: preset.name, lighting, biome, torches, secretLoot };
}
