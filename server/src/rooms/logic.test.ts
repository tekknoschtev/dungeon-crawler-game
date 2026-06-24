import { describe, it, expect } from "vitest";
import {
  dist,
  normalize,
  collides,
  rollRarity,
  rollCategory,
  rollWeapon,
  rollMobKind,
  applyLootEffect,
  crateBombChance,
  applyKnockback,
  playerAttackDamage,
  mobDamageAfterDefense,
  regenHp,
  isAllowedColor,
  isAllowedSprite,
  pickAggroTarget,
  heatLevel,
  targetMobCount,
  spawnInterval,
  extendSpawnLull,
  scaleMobHp,
  scaleMobDamage,
  respawnDelay,
  isWipe,
  scoreMultiplier,
  killScore,
  lootScore,
  depthScore,
  chestPoints,
  rollRelic,
  type LootTarget,
  type LootBuffs,
} from "./logic";
import {
  PLAYER_ATTACK_DAMAGE,
  MOB_DAMAGE,
  BUFF_DURATION,
  MAX_HEAL_CHARGES,
  MAX_BOMBS,
  RESPAWN_DELAYS,
  SCORE_PER_KILL,
  SCORE_MULT_MAX,
  SCORE_DEPTH_BONUS,
  LOOT_SCORE,
  CHEST_BASE_POINTS,
  RELIC_ADJECTIVES,
  RELIC_NOUNS,
  MOBS,
  rarityByName,
  weaponByName,
} from "./tuning";

/** A fresh, unbuffed loot target + combat buffs pair. */
function freshTarget(): { t: LootTarget; b: LootBuffs } {
  return {
    t: { attackBuff: 0, defenseBuff: 0, healCharges: 0, bombs: 0, weapon: "" },
    b: { attackMult: 1, defenseReduce: 0, knockback: 0 },
  };
}

describe("geometry", () => {
  it("dist is euclidean", () => {
    expect(dist(0, 0, 3, 4)).toBe(5);
  });

  it("normalize returns a unit vector and (0,0) for no input", () => {
    expect(normalize(0, 0)).toEqual({ x: 0, y: 0 });
    const diag = normalize(1, 1);
    expect(Math.hypot(diag.x, diag.y)).toBeCloseTo(1);
    expect(normalize(0, -5)).toEqual({ x: 0, y: -1 });
  });
});

describe("collides", () => {
  // 3x3 grid: solid border of wall, single floor tile in the center.
  const grid = [
    [1, 1, 1],
    [1, 0, 1],
    [1, 1, 1],
  ];
  const T = 16;

  it("passes inside the floor tile", () => {
    expect(collides(grid, 3, 3, T, 24, 24, 5)).toBe(false); // center of tile (1,1)
  });

  it("hits an adjacent wall tile when the box overlaps it", () => {
    expect(collides(grid, 3, 3, T, 18, 24, 5)).toBe(true); // left edge spills into wall (0,1)
  });

  it("treats out-of-bounds as solid", () => {
    expect(collides(grid, 3, 3, T, -2, -2, 5)).toBe(true);
  });
});

describe("loot rolls (deterministic RNG)", () => {
  it("rollRarity hits the bottom and top of the weight table", () => {
    expect(rollRarity(() => 0).name).toBe("common"); // first bucket
    expect(rollRarity(() => 0.999).name).toBe("legendary"); // last bucket
  });

  it("rollCategory hits the bottom and top of the weight table", () => {
    expect(rollCategory(() => 0)).toBe("attack");
    expect(rollCategory(() => 0.999)).toBe("heal");
  });

  it("rollWeapon hits the bottom and top of the weight table", () => {
    expect(rollWeapon(() => 0).name).toBe("shortsword"); // first bucket
    expect(rollWeapon(() => 0.999).name).toBe("warhammer"); // last bucket
  });
});

describe("rollMobKind (M5 depth-gated spawn mix)", () => {
  it("floor 1 only fields the kinds unlocked at depth 1", () => {
    // slime + rat are the only minDepth<=1 kinds; the roll spans just those.
    expect(rollMobKind(1, () => 0).name).toBe("slime"); // first eligible bucket
    expect(rollMobKind(1, () => 0.999).name).toBe("rat"); // last eligible at depth 1
  });

  it("never rolls a kind below its minDepth, at any depth", () => {
    for (const depth of [1, 2, 3, 5, 7, 20]) {
      for (let r = 0; r < 1; r += 0.05) {
        const kind = rollMobKind(depth, () => r);
        expect(kind.minDepth).toBeLessThanOrEqual(depth);
      }
    }
  });

  it("deep floors fold in the tougher kinds, up to the last in the table", () => {
    // By the deepest minDepth every kind is eligible, so the top bucket is ghost.
    const maxMinDepth = Math.max(...MOBS.map((m) => m.minDepth));
    expect(rollMobKind(maxMinDepth, () => 0.999).name).toBe("ghost");
    // A mid kind (crab, minDepth 3) is unreachable before its floor but
    // reachable once it unlocks.
    const depthsHitCrab = (depth: number) =>
      Array.from({ length: 40 }, (_, i) => rollMobKind(depth, () => i / 40).name).includes(
        "crab"
      );
    expect(depthsHitCrab(2)).toBe(false);
    expect(depthsHitCrab(3)).toBe(true);
  });
});

describe("applyLootEffect", () => {
  it("a weapon pickup equips its duration, multiplier, and knockback", () => {
    const { t, b } = freshTarget();
    const hammer = weaponByName("warhammer");
    const kept = applyLootEffect(t, b, { rarity: hammer.rarity, category: "attack", variant: "warhammer" });
    expect(kept).toBe(true);
    expect(t.attackBuff).toBe(hammer.duration);
    expect(b.attackMult).toBe(hammer.attackMult);
    expect(b.knockback).toBe(hammer.knockback);
    expect(t.weapon).toBe("warhammer"); // HUD shows the equipped weapon
  });

  it("an unknown/empty weapon variant falls back to the first weapon", () => {
    const { t, b } = freshTarget();
    applyLootEffect(t, b, { rarity: "common", category: "attack" }); // no variant
    expect(b.attackMult).toBe(weaponByName("shortsword").attackMult);
  });

  it("never downgrades a stronger weapon's power, knockback, or remaining time", () => {
    const { t, b } = freshTarget();
    applyLootEffect(t, b, { rarity: "legendary", category: "attack", variant: "warhammer" }); // strong
    applyLootEffect(t, b, { rarity: "common", category: "attack", variant: "shortsword" }); // weaker
    const hammer = weaponByName("warhammer");
    expect(b.attackMult).toBe(hammer.attackMult);
    expect(b.knockback).toBe(hammer.knockback);
    expect(t.attackBuff).toBe(hammer.duration); // shorter shortsword timer didn't cut it
    expect(t.weapon).toBe("warhammer"); // icon stays the stronger weapon
  });

  it("upgrades to a stronger buff and refreshes the timer", () => {
    const { t, b } = freshTarget();
    applyLootEffect(t, b, { rarity: "common", category: "defense" });
    applyLootEffect(t, b, { rarity: "epic", category: "defense" });
    expect(b.defenseReduce).toBe(rarityByName("epic").defenseReduce);
    expect(t.defenseBuff).toBe(BUFF_DURATION);
  });

  it("banks a heal when there is room", () => {
    const { t, b } = freshTarget();
    expect(applyLootEffect(t, b, { rarity: "common", category: "heal" })).toBe(true);
    expect(t.healCharges).toBe(1);
  });

  it("leaves a heal on the floor when the stack is full", () => {
    const { t, b } = freshTarget();
    t.healCharges = MAX_HEAL_CHARGES;
    expect(applyLootEffect(t, b, { rarity: "common", category: "heal" })).toBe(false);
    expect(t.healCharges).toBe(MAX_HEAL_CHARGES); // unchanged
  });

  it("banks a bomb when there is room, and leaves it once the carry cap is hit", () => {
    const { t, b } = freshTarget();
    expect(applyLootEffect(t, b, { rarity: "common", category: "bomb" })).toBe(true);
    expect(t.bombs).toBe(1);
    t.bombs = MAX_BOMBS;
    expect(applyLootEffect(t, b, { rarity: "common", category: "bomb" })).toBe(false);
    expect(t.bombs).toBe(MAX_BOMBS); // unchanged — left on the floor
  });
});

describe("crateBombChance (M10 rubber-band)", () => {
  it("is the base on floor 1 and climbs with depth, capped", () => {
    expect(crateBombChance(1, 0.12, 0.02, 0.35)).toBeCloseTo(0.12); // no bonus on 1
    expect(crateBombChance(5, 0.12, 0.02, 0.35)).toBeCloseTo(0.2); // +0.02 * 4
    expect(crateBombChance(100, 0.12, 0.02, 0.35)).toBe(0.35); // clamped at the cap
  });
});

describe("combat damage", () => {
  it("player base damage, scaled only while the attack buff is active", () => {
    expect(playerAttackDamage(false, 2)).toBe(PLAYER_ATTACK_DAMAGE);
    expect(playerAttackDamage(true, 2)).toBe(PLAYER_ATTACK_DAMAGE * 2);
  });

  it("mob damage is reduced only while the defense buff is active", () => {
    expect(mobDamageAfterDefense(false, 0.5)).toBe(MOB_DAMAGE);
    expect(mobDamageAfterDefense(true, 0.5)).toBe(MOB_DAMAGE * 0.5);
    expect(mobDamageAfterDefense(true, 0)).toBe(MOB_DAMAGE);
  });
});

describe("applyKnockback", () => {
  // 5-wide, 1-tall open corridor (walls top/bottom are implicit via OOB on a
  // single row); use a tall open room so horizontal pushes have headroom.
  const T = 16;
  const open = [
    [1, 1, 1, 1, 1],
    [1, 0, 0, 0, 1],
    [1, 0, 0, 0, 1],
    [1, 0, 0, 0, 1],
    [1, 1, 1, 1, 1],
  ];

  it("shoves the mob directly away from the attacker", () => {
    // Attacker at the center tile, mob just to its right → pushed further right.
    const r = applyKnockback(open, 5, 5, T, 40, 40, 48, 40, 16, 5);
    expect(r.x).toBeGreaterThan(48);
    expect(r.y).toBeCloseTo(40);
  });

  it("stops at a wall instead of tunnelling through it", () => {
    // Mob hugging the right-open edge, big shove right: it can't enter the wall
    // column (x >= 64), so it stays within the open area minus its radius.
    const r = applyKnockback(open, 5, 5, T, 24, 40, 56, 40, 200, 5);
    expect(r.x).toBeLessThanOrEqual(64 - 5);
    expect(r.x).toBeGreaterThan(24);
  });

  it("is a no-op when the attacker is exactly on the mob", () => {
    const r = applyKnockback(open, 5, 5, T, 40, 40, 40, 40, 32, 5);
    expect(r).toEqual({ x: 40, y: 40 });
  });
});

describe("regenHp", () => {
  it("heals at the given rate over dt", () => {
    expect(regenHp(50, 100, 2, 1.5)).toBe(53); // 50 + 1.5*2
  });

  it("clamps at maxHp (no overheal)", () => {
    expect(regenHp(99, 100, 10, 1.5)).toBe(100);
  });

  it("is a no-op when already at full HP", () => {
    expect(regenHp(100, 100, 5, 1.5)).toBe(100);
  });

  it("uses the PASSIVE_REGEN default rate when none is passed", () => {
    // Default rate is positive, so a wounded hero gains some HP.
    expect(regenHp(50, 100, 1)).toBeGreaterThan(50);
    expect(regenHp(50, 100, 1)).toBeLessThanOrEqual(100);
  });
});

describe("isAllowedColor", () => {
  const palette = ["#ff5d73", "#4ec9ff", "#ffd65c"];

  it("accepts a color in the palette", () => {
    expect(isAllowedColor("#4ec9ff", palette)).toBe(true);
  });

  it("rejects a color not in the palette", () => {
    expect(isAllowedColor("#123456", palette)).toBe(false);
  });

  it("rejects undefined and junk (allowlist, not just a type check)", () => {
    expect(isAllowedColor(undefined, palette)).toBe(false);
    expect(isAllowedColor("red", palette)).toBe(false);
    expect(isAllowedColor("javascript:alert(1)", palette)).toBe(false);
  });
});

describe("heatLevel", () => {
  it("is 0 on arrival, 1 at the ramp time, and clamps past it", () => {
    expect(heatLevel(0, 100)).toBe(0);
    expect(heatLevel(50, 100)).toBeCloseTo(0.5);
    expect(heatLevel(100, 100)).toBe(1);
    expect(heatLevel(500, 100)).toBe(1); // clamped, never overshoots
  });
});

describe("targetMobCount", () => {
  it("lerps from base (calm) to max (hot) with heat, on floor 1", () => {
    expect(targetMobCount(0, 1, 6, 22, 1.5, 30)).toBe(6);
    expect(targetMobCount(1, 1, 6, 22, 1.5, 30)).toBe(22);
    expect(targetMobCount(0.5, 1, 6, 22, 1.5, 30)).toBe(14); // (6+22)/2
  });

  it("adds a per-depth bonus (depth is 1-based)", () => {
    expect(targetMobCount(0, 1, 6, 22, 2, 30)).toBe(6); // floor 1: no bonus
    expect(targetMobCount(0, 3, 6, 22, 2, 30)).toBe(10); // +2 per floor below 1 → +4
  });

  it("never exceeds the hard cap", () => {
    expect(targetMobCount(1, 10, 6, 22, 5, 30)).toBe(30);
  });
});

describe("spawnInterval", () => {
  it("is long when calm and short when hot", () => {
    expect(spawnInterval(0, 5, 1)).toBe(5);
    expect(spawnInterval(1, 5, 1)).toBe(1);
    expect(spawnInterval(0.5, 5, 1)).toBe(3);
  });
});

describe("extendSpawnLull (M9)", () => {
  it("adds one beat per kill from an unsuppressed state", () => {
    // current stamp is in the past (no active hold) → anchored at now.
    expect(extendSpawnLull(0, 100, 0.6, 4)).toBeCloseTo(100.6);
  });

  it("stacks when kills land during an active hold", () => {
    // Simulate a rout: repeated kills at the same instant pile onto the stamp.
    let stamp = 100;
    for (let i = 0; i < 3; i++) stamp = extendSpawnLull(stamp, 100, 0.6, 4);
    expect(stamp).toBeCloseTo(101.8); // 100 + 3 * 0.6
  });

  it("caps a huge rout so the floor can't be emptied forever", () => {
    let stamp = 100;
    for (let i = 0; i < 20; i++) stamp = extendSpawnLull(stamp, 100, 0.6, 4);
    expect(stamp).toBe(104); // now + max, never beyond
  });

  it("re-anchors at now once the previous hold has lapsed", () => {
    // A stale stamp (kill long ago) shouldn't shorten the new hold.
    expect(extendSpawnLull(100, 200, 0.6, 4)).toBeCloseTo(200.6);
  });
});

describe("depth stat scaling", () => {
  it("leaves floor 1 unchanged and scales deeper floors", () => {
    expect(scaleMobHp(30, 1, 0.15)).toBe(30);
    expect(scaleMobHp(30, 3, 0.15)).toBe(39); // 30 * (1 + 0.3)
    expect(scaleMobDamage(8, 1, 0.1)).toBe(8);
    expect(scaleMobDamage(8, 6, 0.1)).toBeCloseTo(12); // 8 * (1 + 0.5)
  });
});

describe("isAllowedSprite", () => {
  const frames = [84, 96, 100];

  it("accepts a frame in the allowlist", () => {
    expect(isAllowedSprite(96, frames)).toBe(true);
  });

  it("rejects a frame not in the allowlist", () => {
    expect(isAllowedSprite(7, frames)).toBe(false);
  });

  it("rejects undefined (absent pick)", () => {
    expect(isAllowedSprite(undefined, frames)).toBe(false);
  });
});

describe("pickAggroTarget", () => {
  const candidates = [
    { id: "a", x: 100, y: 0 },
    { id: "b", x: 10, y: 0 },
    { id: "c", x: 40, y: 0 },
  ];

  it("returns the nearest candidate within range", () => {
    const got = pickAggroTarget(0, 0, candidates, 96);
    expect(got?.id).toBe("b");
    expect(got?.dist).toBeCloseTo(10);
  });

  it("returns null when none are within range", () => {
    expect(pickAggroTarget(0, 0, candidates, 5)).toBeNull();
  });

  it("returns null for no candidates", () => {
    expect(pickAggroTarget(0, 0, [], 96)).toBeNull();
  });
});

describe("respawnDelay", () => {
  it("ramps with each self-respawn, clamping past the table's end", () => {
    expect(respawnDelay(0)).toBe(RESPAWN_DELAYS[0]); // first death
    expect(respawnDelay(2)).toBe(RESPAWN_DELAYS[2]);
    // Beyond the table the longest delay holds.
    expect(respawnDelay(RESPAWN_DELAYS.length)).toBe(RESPAWN_DELAYS[RESPAWN_DELAYS.length - 1]);
    expect(respawnDelay(999)).toBe(RESPAWN_DELAYS[RESPAWN_DELAYS.length - 1]);
  });

  it("never decreases (monotonic ramp)", () => {
    for (let i = 1; i < RESPAWN_DELAYS.length; i++) {
      expect(respawnDelay(i)).toBeGreaterThanOrEqual(respawnDelay(i - 1));
    }
  });

  it("clamps a negative respawn count to the first delay", () => {
    expect(respawnDelay(-3)).toBe(RESPAWN_DELAYS[0]);
  });
});

describe("isWipe", () => {
  it("is true only when a non-empty party is wholly down", () => {
    expect(isWipe([true, true])).toBe(true);
    expect(isWipe([true])).toBe(true);
  });

  it("is false when anyone is still up", () => {
    expect(isWipe([true, false])).toBe(false);
    expect(isWipe([false])).toBe(false);
  });

  it("is false for an empty room", () => {
    expect(isWipe([])).toBe(false);
  });
});

describe("scoring", () => {
  it("scoreMultiplier runs ×1 calm → ×max at full heat, monotonic", () => {
    expect(scoreMultiplier(0)).toBe(1);
    expect(scoreMultiplier(1)).toBe(SCORE_MULT_MAX);
    expect(scoreMultiplier(0.5)).toBeCloseTo(1 + (SCORE_MULT_MAX - 1) / 2);
    expect(scoreMultiplier(0.25)).toBeGreaterThan(scoreMultiplier(0));
    expect(scoreMultiplier(1)).toBeGreaterThan(scoreMultiplier(0.75));
  });

  it("scoreMultiplier clamps heat outside [0,1]", () => {
    expect(scoreMultiplier(-1)).toBe(1);
    expect(scoreMultiplier(2)).toBe(SCORE_MULT_MAX);
  });

  it("killScore is the base on floor 1 and grows with depth", () => {
    expect(killScore(1)).toBe(SCORE_PER_KILL);
    expect(killScore(6, 10, 0.1)).toBeCloseTo(15); // 10 * (1 + 0.5)
  });

  it("lootScore looks up by rarity and falls back to common", () => {
    expect(lootScore("legendary")).toBe(LOOT_SCORE.legendary);
    expect(lootScore("common")).toBe(LOOT_SCORE.common);
    expect(lootScore("nonsense")).toBe(LOOT_SCORE.common);
  });

  it("depthScore scales the descend bonus with depth", () => {
    expect(depthScore(1, 100)).toBe(100);
    expect(depthScore(4, 100)).toBe(400);
    expect(depthScore(3)).toBe(SCORE_DEPTH_BONUS * 3);
  });
});

describe("vault chest (M4)", () => {
  describe("chestPoints", () => {
    it("is the base on floor 1 and scales with depth", () => {
      expect(chestPoints(1)).toBe(CHEST_BASE_POINTS);
      expect(chestPoints(4)).toBe(CHEST_BASE_POINTS * 4);
      expect(chestPoints(3, 50)).toBe(150);
    });
  });

  describe("rollRelic", () => {
    it("rng=0 yields the lowest tier's first adjective + noun, no suffix", () => {
      const name = rollRelic(() => 0, 1);
      expect(name).toBe(`${RELIC_ADJECTIVES.worn[0]} ${RELIC_NOUNS.worn[0]}`);
      expect(name).not.toContain("of the");
    });

    it("rng→1 yields the top tier's last words plus a suffix", () => {
      const name = rollRelic(() => 0.999, 1);
      const adj = RELIC_ADJECTIVES.mythic;
      const noun = RELIC_NOUNS.mythic;
      expect(name.startsWith(`${adj[adj.length - 1]} ${noun[noun.length - 1]}`)).toBe(true);
      expect(name).toContain("of the");
    });

    it("a deeper depth raises the rarity floor (rng=0 climbs above the worn tier)", () => {
      const shallow = rollRelic(() => 0, 1);
      const deep = rollRelic(() => 0, 9); // floor pushed well above worn
      expect(shallow).toBe(`${RELIC_ADJECTIVES.worn[0]} ${RELIC_NOUNS.worn[0]}`);
      expect(deep).not.toBe(shallow);
      // At depth 9 the floor tier is mythic, so rng=0 lands on mythic's first words.
      expect(deep).toContain(RELIC_ADJECTIVES.mythic[0]);
    });
  });
});
