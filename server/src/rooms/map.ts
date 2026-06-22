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
export const MAP_W = 60; // tiles
export const MAP_H = 40; // tiles

// Generator tuning.
const ROOM_MIN = 5; // min room side (tiles)
const ROOM_MAX = 11; // max room side (tiles)
const ROOM_ATTEMPTS = 120; // how many placements to try
const MAX_ROOMS = 14; // stop once we have this many

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
}

// Prop placement. Props go only on room-edge tiles (exactly one orthogonal wall
// neighbor) so they never sit in a 1-wide corridor, and any candidate that would
// wall off part of the dungeon is rejected (see placeProps). Kept sparse — they
// block movement, so a dense scatter would make rooms annoying to cross.
const PROP_CHANCE = 0.05;
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
      if (coordHash(x, y, 1) >= PROP_CHANCE) continue;

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
 */
export function loadMap(seed: number): LoadedMap {
  const rand = mulberry32(seed);
  const randInt = (min: number, max: number) =>
    min + Math.floor(rand() * (max - min + 1));

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
  for (let i = 0; i < ROOM_ATTEMPTS && rooms.length < MAX_ROOMS; i++) {
    const w = randInt(ROOM_MIN, ROOM_MAX);
    const h = randInt(ROOM_MIN, ROOM_MAX);
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
  const props = placeProps(grid, start, new Set(vaultCarve?.cells ?? []));

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

  return { tile: TILE, width: MAP_W, height: MAP_H, grid, spawns, props, exit, vault };
}
