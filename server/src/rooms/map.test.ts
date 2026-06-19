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

  it("leaves no wall nub touching floor on 3+ orthogonal sides", () => {
    const { grid } = loadMap(555);
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
  });
});
