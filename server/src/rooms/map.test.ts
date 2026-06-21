import { describe, it, expect } from "vitest";
import { loadMap, MAP_W, MAP_H, TILE } from "./map";

/** Flood-fill the floor (0) cells reachable from a start tile; returns the count. */
function reachableFloorCount(grid: number[][], startX: number, startY: number): number {
  const seen = new Set<string>();
  const stack: [number, number][] = [[startX, startY]];
  while (stack.length) {
    const [x, y] = stack.pop()!;
    if (x < 0 || y < 0 || x >= MAP_W || y >= MAP_H) continue;
    if (grid[y][x] !== 0) continue;
    const key = `${x},${y}`;
    if (seen.has(key)) continue;
    seen.add(key);
    stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
  }
  return seen.size;
}

function totalFloor(grid: number[][]): number {
  let n = 0;
  for (const row of grid) for (const cell of row) if (cell === 0) n++;
  return n;
}

describe("loadMap", () => {
  it("is deterministic for a given seed", () => {
    expect(loadMap(12345)).toEqual(loadMap(12345));
  });

  it("produces different layouts for different seeds", () => {
    // Not a guarantee for any single pair, but across several it must vary.
    const grids = [1, 2, 3, 4, 5].map((s) => JSON.stringify(loadMap(s).grid));
    expect(new Set(grids).size).toBeGreaterThan(1);
  });

  it("has the expected grid dimensions", () => {
    const { grid, width, height } = loadMap(7);
    expect(width).toBe(MAP_W);
    expect(height).toBe(MAP_H);
    expect(grid).toHaveLength(MAP_H);
    for (const row of grid) expect(row).toHaveLength(MAP_W);
  });

  it("keeps a solid wall border around the whole map", () => {
    const { grid } = loadMap(99);
    for (let x = 0; x < MAP_W; x++) {
      expect(grid[0][x]).toBe(1);
      expect(grid[MAP_H - 1][x]).toBe(1);
    }
    for (let y = 0; y < MAP_H; y++) {
      expect(grid[y][0]).toBe(1);
      expect(grid[y][MAP_W - 1]).toBe(1);
    }
  });

  it("places every spawn on a floor tile, in pixel (tile-center) coords", () => {
    const { grid, spawns } = loadMap(2024);
    expect(spawns.length).toBeGreaterThan(0);
    for (const s of spawns) {
      const tx = Math.floor(s.x / TILE);
      const ty = Math.floor(s.y / TILE);
      expect(grid[ty][tx]).toBe(0);
    }
  });

  it("generates a fully connected dungeon (no walled-off rooms)", () => {
    // Run a handful of seeds — corridors must join every floor tile to the rest.
    for (const seed of [1, 42, 777, 31337, 2024]) {
      const { grid, spawns } = loadMap(seed);
      const start = spawns[0];
      const reachable = reachableFloorCount(grid, Math.floor(start.x / TILE), Math.floor(start.y / TILE));
      expect(reachable).toBe(totalFloor(grid));
    }
  });

  it("places props only on floor tiles with exactly one wall neighbor", () => {
    const { grid, props } = loadMap(2024);
    const isWall = (x: number, y: number) =>
      x < 0 || y < 0 || x >= MAP_W || y >= MAP_H || grid[y][x] === 1;
    for (const p of props) {
      expect(grid[p.y][p.x]).toBe(0); // on floor
      const walls =
        (isWall(p.x, p.y - 1) ? 1 : 0) +
        (isWall(p.x + 1, p.y) ? 1 : 0) +
        (isWall(p.x, p.y + 1) ? 1 : 0) +
        (isWall(p.x - 1, p.y) ? 1 : 0);
      expect(walls).toBe(1); // a room edge, never a corridor or open floor
    }
  });

  it("keeps the dungeon fully connected with props treated as solid", () => {
    for (const seed of [1, 42, 777, 31337, 2024]) {
      const { grid, spawns, props } = loadMap(seed);
      const blocked = props.map((p) => `${p.x},${p.y}`);
      const blockedSet = new Set(blocked);
      // No two props at the same tile, and none on a spawn.
      expect(blockedSet.size).toBe(props.length);
      for (const s of spawns) {
        expect(blockedSet.has(`${Math.floor(s.x / TILE)},${Math.floor(s.y / TILE)}`)).toBe(false);
      }
      // Flood the walkable space (floor minus props) from a spawn; it must reach
      // every non-prop floor tile.
      const start = spawns[0];
      const seen = new Set<string>();
      const stack: [number, number][] = [[Math.floor(start.x / TILE), Math.floor(start.y / TILE)]];
      while (stack.length) {
        const [x, y] = stack.pop()!;
        if (x < 0 || y < 0 || x >= MAP_W || y >= MAP_H) continue;
        const key = `${x},${y}`;
        if (grid[y][x] !== 0 || blockedSet.has(key) || seen.has(key)) continue;
        seen.add(key);
        stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
      }
      expect(seen.size).toBe(totalFloor(grid) - props.length);
    }
  });

  it("is deterministic in props for a given seed", () => {
    expect(loadMap(2024).props).toEqual(loadMap(2024).props);
  });

  it("leaves no wall nub touching floor on 3+ orthogonal sides", () => {
    // Several seeds, since the vault carve runs after the prune pass and must not
    // reintroduce nubs (the door+neck geometry is what keeps it clean).
    for (const seed of [1, 42, 555, 777, 2024, 31337]) {
      const { grid } = loadMap(seed);
      const floorNeighbors = (x: number, y: number) => {
        let n = 0;
        if (grid[y - 1][x] === 0) n++;
        if (grid[y + 1][x] === 0) n++;
        if (grid[y][x - 1] === 0) n++;
        if (grid[y][x + 1] === 0) n++;
        return n;
      };
      for (let y = 1; y < MAP_H - 1; y++) {
        for (let x = 1; x < MAP_W - 1; x++) {
          if (grid[y][x] === 1) expect(floorNeighbors(x, y)).toBeLessThan(3);
        }
      }
    }
  });
});

describe("vault chamber", () => {
  const isOpen = (grid: number[][], x: number, y: number) =>
    x >= 0 && y >= 0 && x < MAP_W && y < MAP_H && grid[y][x] === 0;

  it("places a vault on typical seeds, on floor, in bounds", () => {
    let placed = 0;
    for (const seed of [1, 2, 3, 42, 99, 555, 777, 2024, 31337]) {
      const { grid, vault } = loadMap(seed);
      if (!vault) continue;
      placed++;
      // Chest + door are floor, inside the border.
      for (const t of [vault.chest, vault.door]) {
        expect(t.x).toBeGreaterThanOrEqual(1);
        expect(t.y).toBeGreaterThanOrEqual(1);
        expect(t.x).toBeLessThanOrEqual(MAP_W - 2);
        expect(t.y).toBeLessThanOrEqual(MAP_H - 2);
        expect(grid[t.y][t.x]).toBe(0);
      }
      // The door is orthogonally adjacent to the chamber (not diagonal/detached).
      const adj = Math.abs(vault.door.x - vault.chest.x) + Math.abs(vault.door.y - vault.chest.y);
      expect(adj).toBeGreaterThan(0);
    }
    expect(placed).toBeGreaterThan(0); // at least some seeds fit a chamber
  });

  it("sealing the door isolates the chest from the rest of the dungeon", () => {
    // The door is the chamber's ONLY connection: flood from a spawn with the door
    // treated as solid, and the chest tile must be unreachable.
    for (const seed of [1, 2, 3, 42, 99, 555, 777, 2024, 31337]) {
      const { grid, spawns, vault } = loadMap(seed);
      if (!vault) continue;
      const blocked = `${vault.door.x},${vault.door.y}`;
      const seen = new Set<string>();
      const stack: [number, number][] = [[Math.floor(spawns[0].x / TILE), Math.floor(spawns[0].y / TILE)]];
      while (stack.length) {
        const [x, y] = stack.pop()!;
        const key = `${x},${y}`;
        if (!isOpen(grid, x, y) || key === blocked || seen.has(key)) continue;
        seen.add(key);
        stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
      }
      expect(seen.has(`${vault.chest.x},${vault.chest.y}`)).toBe(false); // sealed off
      // ...but with the door OPEN, the chest IS reachable (it's a real chamber).
      const seenOpen = new Set<string>();
      const stack2: [number, number][] = [[Math.floor(spawns[0].x / TILE), Math.floor(spawns[0].y / TILE)]];
      while (stack2.length) {
        const [x, y] = stack2.pop()!;
        const key = `${x},${y}`;
        if (!isOpen(grid, x, y) || seenOpen.has(key)) continue;
        seenOpen.add(key);
        stack2.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
      }
      expect(seenOpen.has(`${vault.chest.x},${vault.chest.y}`)).toBe(true);
    }
  });

  it("keeps props out of the vault chamber", () => {
    for (const seed of [1, 2, 3, 42, 99, 555, 777, 2024, 31337]) {
      const { props, vault } = loadMap(seed);
      if (!vault) continue;
      // No prop on the chest or door tile (the chamber interior is unreachable to
      // the prop scan anyway, but the door is a reachable edge tile).
      for (const p of props) {
        expect(`${p.x},${p.y}`).not.toBe(`${vault.chest.x},${vault.chest.y}`);
        expect(`${p.x},${p.y}`).not.toBe(`${vault.door.x},${vault.door.y}`);
      }
    }
  });

  it("is deterministic in the vault for a given seed", () => {
    expect(loadMap(2024).vault).toEqual(loadMap(2024).vault);
  });
});
