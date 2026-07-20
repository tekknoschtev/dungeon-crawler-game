import { describe, it, expect } from "vitest";
import { loadMap, applyBiomeQuirks, MAP_W, MAP_H, TILE, LIGHTING, BIOMES, biomeForDepth } from "./map";

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

describe("biomeForDepth (M15)", () => {
  it("maps the shallow band to stone", () => {
    expect(biomeForDepth(1)).toBe("stone");
    expect(biomeForDepth(4)).toBe("stone");
  });

  it("maps floors 5-9 to overgrown", () => {
    expect(biomeForDepth(5)).toBe("overgrown");
    expect(biomeForDepth(9)).toBe("overgrown");
  });

  it("maps floors 10-14 to crypt", () => {
    expect(biomeForDepth(10)).toBe("crypt");
    expect(biomeForDepth(14)).toBe("crypt");
  });

  it("maps floors 15+ to ember — every band's kit is built", () => {
    expect(biomeForDepth(15)).toBe("ember");
    expect(biomeForDepth(99)).toBe("ember");
  });

  it("never deals a special biome from the depth bands", () => {
    // frost/goldvault/flesh are special-floor kits (trigger design TBD) —
    // normal band generation must never produce them.
    const bands = new Set(["stone", "overgrown", "crypt", "ember"]);
    for (let depth = 1; depth <= 40; depth++) {
      expect(bands.has(biomeForDepth(depth))).toBe(true);
    }
  });

  it("pins geometry per (seed, biome): identical layouts within a band", () => {
    // Floorplans milestone: the biome SHAPES the floor, so layouts are pinned
    // within a band (same seed + same biome ⇒ identical grid), not across
    // bands the way they were when biome was pure cosmetics.
    expect(loadMap(4242, 1).grid).toEqual(loadMap(4242, 4).grid); // stone band
    expect(loadMap(4242, 5).grid).toEqual(loadMap(4242, 9).grid); // overgrown band
    expect(loadMap(4242, 10).grid).toEqual(loadMap(4242, 14).grid); // crypt band
  });

  it("is carried on the loaded map and respects the dev override", () => {
    expect(loadMap(11, 6).biome).toBe("overgrown");
    expect(loadMap(11, 1).biome).toBe("stone");
    expect(loadMap(11, 1, undefined, "overgrown").biome).toBe("overgrown");
  });
});

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

  it("rolls a known lighting mode, deterministic per seed", () => {
    for (const seed of [1, 2, 3, 42, 99, 555, 777, 2024, 31337]) {
      const lighting = loadMap(seed, 3).lighting;
      expect(LIGHTING).toContain(lighting);
      expect(loadMap(seed, 3).lighting).toBe(lighting); // same seed+depth → same mode
    }
  });

  it("never makes floor 1 dark (no-tutorial on-ramp)", () => {
    for (let seed = 0; seed < 80; seed++) {
      expect(loadMap(seed, 1).lighting).toBe("bright");
    }
  });

  it("produces every lighting mode deeper than floor 1", () => {
    const modes = new Set(Array.from({ length: 120 }, (_, s) => loadMap(s, 2).lighting));
    expect(modes).toEqual(new Set(["bright", "dark", "torchlit"]));
  });

  it("ignores depth for geometry within a band — only lighting (and its torchlit secrets) changes", () => {
    // Same seed at different depths OF THE SAME BIOME BAND must yield the
    // identical GEOMETRY (grid + spawns are rolled before the depth-sensitive
    // lighting roll). Props can differ only because torchlit floors seed secret
    // caches; force the same mode and the full prop layout matches too.
    const a = loadMap(2024, 1);
    const b = loadMap(2024, 4); // both stone (floors 1-4)
    expect(a.grid).toEqual(b.grid);
    expect(a.spawns).toEqual(b.spawns);
    expect(loadMap(2024, 1, "bright").props).toEqual(loadMap(2024, 4, "bright").props);
    expect(loadMap(2024, 5, "bright").props).toEqual(loadMap(2024, 9, "bright").props); // overgrown band too
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

describe("biome floorplans (PR A: weights + plumbing)", () => {
  const SEEDS = [1, 7, 42, 777, 2024, 31337];
  /** djb2 over the grid — the same fingerprint used to capture the pins below. */
  const gridHash = (grid: number[][]): number => {
    let h = 5381;
    for (const row of grid) for (const c of row) h = ((h * 33) ^ c) >>> 0;
    return h;
  };

  it("stone regression: floors 1-4 keep the pre-floorplans layouts, seed-for-seed", () => {
    // Fingerprints captured from the generator BEFORE the floorplans milestone
    // (main @ 3ddb76b). If one of these moves, stone drifted — that's a bug by
    // definition: stone is the untouched baseline (design rule 2 in
    // docs/biome-floorplans-plan.md). Covers all three legacy archetypes.
    const pins: [number, number, string][] = [
      [1, 1994636293, "standard"],
      [7, 3055064068, "warren"],
      [42, 4151813796, "standard"],
      [777, 4170641893, "hall"],
      [2024, 3248936389, "hall"],
      [31337, 626201508, "hall"],
    ];
    for (const [seed, hash, preset] of pins) {
      const m = loadMap(seed, 2, "bright"); // depth 2 = stone band
      expect(m.preset).toBe(preset);
      expect(gridHash(m.grid)).toBe(hash);
    }
  });

  it("is deterministic per (seed, biome) — every co-op client and re-run agrees", () => {
    for (const biome of BIOMES) {
      expect(loadMap(4242, 2, undefined, biome)).toEqual(loadMap(4242, 2, undefined, biome));
    }
  });

  it("gives every non-stone biome a structural fingerprint distinct from stone", () => {
    // Not guaranteed per seed (a biome can roll the same archetype as stone) —
    // but across a spread of seeds every biome must reshape at least some floors.
    for (const biome of BIOMES) {
      if (biome === "stone") continue;
      let differs = 0;
      for (let s = 0; s < 20; s++) {
        if (gridHash(loadMap(s, 2, "bright", biome).grid) !== gridHash(loadMap(s, 2, "bright").grid)) {
          differs++;
        }
      }
      expect(differs).toBeGreaterThan(0);
    }
  });

  it("quirkless biomes change shape ONLY via the weight table: same archetype as stone ⇒ stone's exact grid", () => {
    // When a biome's weighted pick lands on the same archetype stone would
    // roll, every subsequent main-stream draw lines up — so a biome with no
    // carve quirk must yield stone's exact grid. Holds for ember until PR C's
    // chasms (replace this pin with the chasm containment tests then), and for
    // frost permanently (its glacial preset IS its quirk).
    for (const biome of ["ember", "frost"] as const) {
      let matched = 0;
      for (let s = 0; s < 40; s++) {
        const stone = loadMap(s, 2, "bright");
        const other = loadMap(s, 2, "bright", biome);
        if (other.preset === stone.preset) {
          matched++;
          expect(other.grid).toEqual(stone.grid);
        }
      }
      expect(matched).toBeGreaterThan(0);
    }
  });

  it("weights the archetype roll per biome (deterministic over a fixed seed sweep)", () => {
    const N = 80;
    const dist = (biome: (typeof BIOMES)[number]) => {
      const counts: Record<string, number> = {};
      for (let s = 0; s < N; s++) {
        const p = loadMap(s, 2, "bright", biome).preset;
        counts[p] = (counts[p] ?? 0) + 1;
      }
      return counts;
    };

    const overgrown = dist("overgrown"); // 45/35/20 — warren-leaning
    expect(overgrown.warren).toBeGreaterThan(overgrown.hall ?? 0);
    expect(overgrown.catacombs).toBeUndefined();

    const crypt = dist("crypt"); // catacombs half the floors
    expect(crypt.catacombs).toBeGreaterThan(N * 0.3);

    const ember = dist("ember"); // 15/35/50 — hall-leaning
    expect(ember.hall).toBeGreaterThan(ember.warren ?? 0);

    const frost = dist("frost"); // 10/25/65 glacial
    expect(frost.glacial).toBeGreaterThan(N * 0.45);
    expect(frost.hall).toBeUndefined(); // glacial replaces the base hall

    const goldvault = dist("goldvault"); // 0/20/80 treasury — never a warren
    expect(goldvault.warren).toBeUndefined();
    expect(goldvault.treasury).toBeGreaterThan(N * 0.6);

    const flesh = dist("flesh"); // 70/20/10 — a warren of guts
    expect(flesh.warren).toBeGreaterThan(N * 0.5);
  });

  it("keeps the biome-only presets off stone floors", () => {
    for (let s = 0; s < 80; s++) {
      expect(["warren", "standard", "hall"]).toContain(loadMap(s, 2, "bright").preset);
    }
  });

  it("caps catacombs at few small rooms and glacial at few grand ones", () => {
    // spawns are 1:1 with accepted rooms, so they expose the room count.
    let cataSeen = 0, glacialSeen = 0;
    for (let s = 0; s < 60; s++) {
      const crypt = loadMap(s, 2, "bright", "crypt");
      if (crypt.preset === "catacombs") {
        cataSeen++;
        expect(crypt.spawns.length).toBeLessThanOrEqual(8);
        expect(crypt.spawns.length).toBeGreaterThan(1);
      }
      const frost = loadMap(s, 2, "bright", "frost");
      if (frost.preset === "glacial") {
        glacialSeen++;
        expect(frost.spawns.length).toBeLessThanOrEqual(6);
      }
    }
    expect(cataSeen).toBeGreaterThan(0);
    expect(glacialSeen).toBeGreaterThan(0);
  });

  it("makes treasury floors visibly crate-rich next to a plain hall", () => {
    // Same seed, same hall-family geometry — the treasury's cranked propChance
    // must actually show up as more furniture to smash.
    let compared = 0;
    for (let s = 0; s < 40; s++) {
      const stone = loadMap(s, 2, "bright");
      const gold = loadMap(s, 2, "bright", "goldvault");
      if (stone.preset === "hall" && gold.preset === "treasury") {
        compared++;
        expect(gold.props.length).toBeGreaterThan(stone.props.length);
      }
    }
    expect(compared).toBeGreaterThan(0);
  });

  it("keeps every biome fully connected with props solid, and nub-free", () => {
    // Design rule 5: connectivity is provable per biome. The quirk hook is a
    // no-op today, but this sweep is the harness PR B/C quirks must pass.
    for (const biome of BIOMES) {
      for (const seed of SEEDS) {
        const { grid, spawns, props } = loadMap(seed, 2, "bright", biome);
        const blocked = new Set(props.map((p) => `${p.x},${p.y}`));
        expect(blocked.size).toBe(props.length);
        const start = spawns[0];
        const seen = new Set<string>();
        const stack: [number, number][] = [[Math.floor(start.x / TILE), Math.floor(start.y / TILE)]];
        while (stack.length) {
          const [x, y] = stack.pop()!;
          if (x < 0 || y < 0 || x >= MAP_W || y >= MAP_H) continue;
          const key = `${x},${y}`;
          if (grid[y][x] !== 0 || blocked.has(key) || seen.has(key)) continue;
          seen.add(key);
          stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
        }
        expect(seen.size).toBe(totalFloor(grid) - props.length);
        // No wall nub touching floor on 3+ orthogonal sides, whatever the preset.
        for (let y = 1; y < MAP_H - 1; y++) {
          for (let x = 1; x < MAP_W - 1; x++) {
            if (grid[y][x] !== 1) continue;
            const fn =
              (grid[y - 1][x] === 0 ? 1 : 0) +
              (grid[y + 1][x] === 0 ? 1 : 0) +
              (grid[y][x - 1] === 0 ? 1 : 0) +
              (grid[y][x + 1] === 0 ? 1 : 0);
            expect(fn).toBeLessThan(3);
          }
        }
      }
    }
  });
});

describe("biome quirks (PR B: floor-opening carves)", () => {
  // Same tiny PRNG the generator uses, reimplemented here so the direct quirk
  // contract tests below get a deterministic stream without exporting internals.
  const prng = (seed: number) => {
    let a = seed >>> 0;
    return () => {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };
  const clone = (g: number[][]) => g.map((r) => r.slice());
  /** Diff two grids → list of changed cells with before/after values. */
  const diff = (before: number[][], after: number[][]) => {
    const changes: { x: number; y: number; from: number; to: number }[] = [];
    for (let y = 0; y < MAP_H; y++) {
      for (let x = 0; x < MAP_W; x++) {
        if (before[y][x] !== after[y][x]) {
          changes.push({ x, y, from: before[y][x], to: after[y][x] });
        }
      }
    }
    return changes;
  };
  const floorNeighbors = (g: number[][], x: number, y: number) =>
    (g[y - 1]?.[x] === 0 ? 1 : 0) +
    (g[y + 1]?.[x] === 0 ? 1 : 0) +
    (g[y]?.[x - 1] === 0 ? 1 : 0) +
    (g[y]?.[x + 1] === 0 ? 1 : 0);
  // A realistic pre-quirk grid to carve against (any stone layout works — the
  // contracts below are about the DIFF, not the base).
  const baseGrid = (seed: number) => loadMap(seed, 2, "bright").grid;

  it("root breaches tunnel straight through rock between two floor spaces", () => {
    let totalBreaches = 0;
    for (const seed of [1, 7, 42, 777, 2024]) {
      const before = baseGrid(seed);
      const after = clone(before);
      applyBiomeQuirks(after, [], "overgrown", prng(seed));
      const changes = diff(before, after);
      totalBreaches += changes.length;
      // At most 8 tunnels of at most 3 tiles each.
      expect(changes.length).toBeLessThanOrEqual(24);
      for (const c of changes) {
        expect(c.from).toBe(1); // only ever wall → floor
        expect(c.to).toBe(0);
        // Every carved cell is part of a through-tunnel: in the carved grid it
        // connects onward on at least two sides (its tunnel neighbors / the
        // floor spaces at the ends) — never a dead-end scratch in the rock.
        expect(floorNeighbors(after, c.x, c.y)).toBeGreaterThanOrEqual(2);
        // Never the border ring.
        expect(c.x).toBeGreaterThanOrEqual(1);
        expect(c.y).toBeGreaterThanOrEqual(1);
        expect(c.x).toBeLessThanOrEqual(MAP_W - 2);
        expect(c.y).toBeLessThanOrEqual(MAP_H - 2);
      }
      expect(changes.length).toBeGreaterThan(0); // every floor gets its loops
    }
    expect(totalBreaches).toBeGreaterThan(5); // and the sweep shows real punch
  });

  it("burial niches carve 1-tile pockets off straight corridors, never breaches", () => {
    let totalNiches = 0;
    for (const seed of [1, 7, 42, 777, 2024]) {
      const before = baseGrid(seed);
      const after = clone(before);
      applyBiomeQuirks(after, [], "crypt", prng(seed));
      const changes = diff(before, after);
      totalNiches += changes.length;
      for (const c of changes) {
        expect(c.from).toBe(1); // only ever wall → floor
        // A pocket: exactly ONE floor neighbor in the carved grid (the corridor
        // tile it opens onto) — so a niche can never join two floor spaces.
        expect(floorNeighbors(after, c.x, c.y)).toBe(1);
        // Never touches the border ring.
        expect(c.x).toBeGreaterThanOrEqual(1);
        expect(c.y).toBeGreaterThanOrEqual(1);
        expect(c.x).toBeLessThanOrEqual(MAP_W - 2);
        expect(c.y).toBeLessThanOrEqual(MAP_H - 2);
      }
    }
    expect(totalNiches).toBeGreaterThan(0); // corridors actually grow pockets
  });

  it("organic bulges only melt floor-adjacent walls, leaving the border solid", () => {
    let totalMelted = 0;
    for (const seed of [1, 7, 42, 777, 2024]) {
      const before = baseGrid(seed);
      const after = clone(before);
      applyBiomeQuirks(after, [], "flesh", prng(seed));
      const changes = diff(before, after);
      totalMelted += changes.length;
      for (const c of changes) {
        expect(c.from).toBe(1); // bulge-only erosion: wall → floor, never the reverse
        expect(floorNeighbors(before, c.x, c.y)).toBeGreaterThanOrEqual(1);
        expect(c.x).toBeGreaterThanOrEqual(1);
        expect(c.y).toBeGreaterThanOrEqual(1);
        expect(c.x).toBeLessThanOrEqual(MAP_W - 2);
        expect(c.y).toBeLessThanOrEqual(MAP_H - 2);
      }
    }
    expect(totalMelted).toBeGreaterThan(0); // the melt actually fires
  });

  it("leaves stone, frost and (until PR C) ember/goldvault untouched", () => {
    for (const biome of ["stone", "frost", "ember", "goldvault"] as const) {
      const before = baseGrid(42);
      const after = clone(before);
      applyBiomeQuirks(after, [], biome, prng(42));
      expect(after).toEqual(before);
    }
  });

  it("never shifts the lighting roll: matched-preset seeds keep stone's lighting", () => {
    // Quirks draw from the second RNG stream only. When a quirked biome rolls
    // the same archetype as stone, the main stream is draw-for-draw identical,
    // so the lighting roll must land the same — even though the grid differs.
    for (const biome of ["overgrown", "crypt", "flesh"] as const) {
      let matched = 0;
      for (let s = 0; s < 60; s++) {
        const stone = loadMap(s, 3);
        const quirked = loadMap(s, 3, undefined, biome);
        if (quirked.preset === stone.preset) {
          matched++;
          expect(quirked.lighting).toBe(stone.lighting);
        }
      }
      expect(matched).toBeGreaterThan(0);
    }
  });

  it("reshapes matched-preset floors: the quirk is visible beyond the weight table", () => {
    // Counterpart to the quirkless-biome pin above: for the quirked biomes a
    // matched archetype must now yield a DIFFERENT grid on at least some seeds.
    for (const biome of ["overgrown", "crypt", "flesh"] as const) {
      let differs = 0;
      for (let s = 0; s < 40; s++) {
        const stone = loadMap(s, 2, "bright");
        const quirked = loadMap(s, 2, "bright", biome);
        if (quirked.preset === stone.preset && JSON.stringify(quirked.grid) !== JSON.stringify(stone.grid)) {
          differs++;
        }
      }
      expect(differs).toBeGreaterThan(0);
    }
  });

  it("survives a full descent: every floor 1-12 generates connected through the band transitions", () => {
    // Mirrors DungeonRoom.enterFloor exactly (same per-depth seed mixing), so
    // this is a real descent minus the walking: stone → overgrown at 5,
    // overgrown → crypt at 10, quirks kicking in mid-run.
    for (const baseSeed of [17, 4242, 987654321]) {
      for (let depth = 1; depth <= 12; depth++) {
        const seed = (baseSeed ^ Math.imul(depth, 0x9e3779b1)) >>> 0;
        const { grid, spawns } = loadMap(seed, depth);
        const start = spawns[0];
        const reachable = reachableFloorCount(grid, Math.floor(start.x / TILE), Math.floor(start.y / TILE));
        expect(reachable).toBe(totalFloor(grid));
      }
    }
  });

  it("keeps quirked floors fully connected across a wide seed sweep", () => {
    // The heavyweight harness of design rule 5: floor-opening quirks cannot
    // disconnect anything, and this proves it empirically per biome.
    for (const biome of ["overgrown", "crypt", "flesh"] as const) {
      for (let seed = 0; seed < 25; seed++) {
        const { grid, spawns } = loadMap(seed, 2, "bright", biome);
        const start = spawns[0];
        const reachable = reachableFloorCount(grid, Math.floor(start.x / TILE), Math.floor(start.y / TILE));
        expect(reachable).toBe(totalFloor(grid));
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

describe("torchlit floors", () => {
  const SEEDS = [1, 2, 3, 42, 99, 555, 777, 2024, 31337];
  const SECRET_DARK_D2 = 5 * 5; // SECRET_DARK_THRESHOLD² (tiles)
  const torchlit = (seed: number) => loadMap(seed, 2, "torchlit");

  it("rolls torchlit among the deeper-floor modes (deterministic per seed)", () => {
    const modes = new Set(Array.from({ length: 120 }, (_, s) => loadMap(s, 2).lighting));
    expect(modes.has("torchlit")).toBe(true);
    // The forced mode wins and is reproducible.
    expect(loadMap(2024, 1, "torchlit").lighting).toBe("torchlit");
  });

  it("places torches only on front-facing walls (floor to the south, rock elsewhere)", () => {
    const isFloor = (grid: number[][], x: number, y: number) =>
      x >= 0 && y >= 0 && x < MAP_W && y < MAP_H && grid[y][x] === 0;
    let total = 0;
    for (const seed of SEEDS) {
      const { grid, torches } = torchlit(seed);
      total += torches.length;
      for (const t of torches) {
        expect(grid[t.y][t.x]).toBe(1); // mounted on a wall
        expect(isFloor(grid, t.x, t.y + 1)).toBe(true); // a visible brick face below
        expect(isFloor(grid, t.x, t.y - 1)).toBe(false);
        expect(isFloor(grid, t.x + 1, t.y)).toBe(false);
        expect(isFloor(grid, t.x - 1, t.y)).toBe(false); // never a side/back/corner wall
      }
    }
    expect(total).toBeGreaterThan(0); // torchlit floors actually carry torches
  });

  it("is deterministic in torches + secrets for a given seed", () => {
    expect(torchlit(2024).torches).toEqual(torchlit(2024).torches);
    expect(torchlit(2024).secretLoot).toEqual(torchlit(2024).secretLoot);
    expect(torchlit(2024).props).toEqual(torchlit(2024).props);
  });

  it("carries no torches or secrets on bright/dark floors", () => {
    for (const mode of ["bright", "dark"] as const) {
      const m = loadMap(2024, 2, mode);
      expect(m.torches).toEqual([]);
      expect(m.secretLoot).toEqual([]);
    }
  });

  it("seeds bonus loot on floor tiles, in the shadow far from every torch", () => {
    let checked = 0;
    for (const seed of SEEDS) {
      const { grid, torches, secretLoot } = torchlit(seed);
      for (const s of secretLoot) {
        checked++;
        expect(grid[s.y][s.x]).toBe(0); // a loose drop, on open floor
        const minD2 = Math.min(...torches.map((t) => (t.x - s.x) ** 2 + (t.y - s.y) ** 2));
        expect(minD2).toBeGreaterThanOrEqual(SECRET_DARK_D2); // genuinely in shadow
      }
    }
    expect(checked).toBeGreaterThan(0); // some floors place a bonus drop
  });

  it("adds breakable secret caches beyond the floor's furniture", () => {
    let grew = 0;
    for (const seed of SEEDS) {
      const bright = loadMap(seed, 2, "bright").props.length;
      const torch = torchlit(seed).props.length;
      expect(torch).toBeGreaterThanOrEqual(bright); // caches only add props
      if (torch > bright) grew++;
    }
    expect(grew).toBeGreaterThan(0); // at least some floors grow a cache
  });

  it("keeps the dungeon connected with secret caches treated as solid", () => {
    const isWall = (grid: number[][], x: number, y: number) =>
      x < 0 || y < 0 || x >= MAP_W || y >= MAP_H || grid[y][x] === 1;
    for (const seed of SEEDS) {
      const { grid, spawns, props } = torchlit(seed);
      const blocked = new Set(props.map((p) => `${p.x},${p.y}`));
      expect(blocked.size).toBe(props.length); // no two props (or caches) share a tile
      for (const p of props) {
        expect(grid[p.y][p.x]).toBe(0); // every prop on floor
        const walls =
          (isWall(grid, p.x, p.y - 1) ? 1 : 0) +
          (isWall(grid, p.x + 1, p.y) ? 1 : 0) +
          (isWall(grid, p.x, p.y + 1) ? 1 : 0) +
          (isWall(grid, p.x - 1, p.y) ? 1 : 0);
        expect(walls).toBe(1); // a room edge, never a corridor
      }
      const start = spawns[0];
      const seen = new Set<string>();
      const stack: [number, number][] = [[Math.floor(start.x / TILE), Math.floor(start.y / TILE)]];
      while (stack.length) {
        const [x, y] = stack.pop()!;
        if (x < 0 || y < 0 || x >= MAP_W || y >= MAP_H) continue;
        const key = `${x},${y}`;
        if (grid[y][x] !== 0 || blocked.has(key) || seen.has(key)) continue;
        seen.add(key);
        stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
      }
      expect(seen.size).toBe(totalFloor(grid) - props.length);
    }
  });
});
