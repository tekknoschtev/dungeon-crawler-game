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

export interface LoadedMap {
  tile: number;
  width: number; // in tiles
  height: number; // in tiles
  /** grid[y][x] === 1 means wall, 0 means floor */
  grid: number[][];
  /** spawn points in pixel coordinates (tile centers), all on room floor */
  spawns: { x: number; y: number }[];
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

  // Spawns are room centers (guaranteed floor, comfortably inside a room).
  const spawns = rooms.map((r) => {
    const c = roomCenter(r);
    return { x: c.x * TILE + TILE / 2, y: c.y * TILE + TILE / 2 };
  });

  return { tile: TILE, width: MAP_W, height: MAP_H, grid, spawns };
}
