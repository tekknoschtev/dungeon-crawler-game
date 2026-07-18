/**
 * The dungeon map. The SERVER is the source of truth: on join it sends the
 * resolved grid to each client via a "map" message, so the client never
 * hard-codes or generates geometry — it just renders what it's told.
 *
 * Geometry is produced by a small SEEDED room-and-corridor generator: we place
 * a handful of non-overlapping rectangular rooms and join them with L-shaped
 * corridors. Because everything is driven by one numeric seed (stored in
 * DungeonState and generated here on room create), every client in a room gets
 * the exact same dungeon, and we can reproduce any layout later.
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
 * Depth biome (M15) — a COSMETIC axis (unlike lighting): every ~5 floors the
 * dungeon becomes a different place. Pure function of depth (no RNG draw, so
 * adding biomes never perturbs seeded layouts). The client maps the name to a
 * tile-sheet texture; bands whose art isn't built yet fall back to stone so
 * the band table can lead the kits. Sent in the "map" message.
 */
export const BIOMES = ["stone", "overgrown", "crypt", "ember"] as const;
export type Biome = (typeof BIOMES)[number];
// Kits that exist as shipped sheets (see docs/biome-art-plan.md). Grow this as
// crypt/ember land — the band table below already routes to them.
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
 * Build a dungeon from a seed. The same seed always yields the same layout.
 * `depth` only gates the lighting roll (floor 1 is never dark — see below); it
 * does not affect geometry, so the same seed yields the same layout at any depth.
 */
export function loadMap(
  seed: number,
  depth = 1,
  forced?: Lighting,
  forcedBiome?: Biome
): LoadedMap {
  const rand = mulberry32(seed);
  const randInt = (min: number, max: number) =>
    min + Math.floor(rand() * (max - min + 1));

  // Pick a floor archetype first — uses one RNG draw so it's part of the seed.
  const preset = PRESETS[Math.floor(rand() * PRESETS.length)];

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

  // Clean up thin wall fragments the carving leaves behind.
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
      ...spawns.map((s) => `${Math.floor(s.x / TILE)},${Math.floor(s.y / TILE)}`),
    ]);
    const secrets = placeSecrets(grid, start, torches, props, exclude);
    props.push(...secrets.crates);
    secretLoot = secrets.loot;
  }

  // Depth biome (M15): pure band lookup — deliberately NOT an RNG draw, so
  // biome changes can never shift a seed's layout or lighting roll.
  const biome = forcedBiome ?? biomeForDepth(depth);

  return { tile: TILE, width: MAP_W, height: MAP_H, grid, spawns, props, exit, vault, preset: preset.name, lighting, biome, torches, secretLoot };
}
