import { describe, it, expect } from "vitest";
import {
  dist,
  normalize,
  collides,
  rollRarity,
  rollCategory,
  applyLootEffect,
  playerAttackDamage,
  mobDamageAfterDefense,
  regenHp,
  pickAggroTarget,
  type LootTarget,
  type LootBuffs,
} from "./logic";
import {
  PLAYER_ATTACK_DAMAGE,
  MOB_DAMAGE,
  BUFF_DURATION,
  MAX_HEAL_CHARGES,
  rarityByName,
} from "./tuning";

/** A fresh, unbuffed loot target + combat buffs pair. */
function freshTarget(): { t: LootTarget; b: LootBuffs } {
  return {
    t: { attackBuff: 0, defenseBuff: 0, healCharges: 0 },
    b: { attackMult: 1, defenseReduce: 0 },
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
});

describe("applyLootEffect", () => {
  it("attack pickup sets the buff timer and the multiplier", () => {
    const { t, b } = freshTarget();
    const kept = applyLootEffect(t, b, { rarity: "rare", category: "attack" });
    expect(kept).toBe(true);
    expect(t.attackBuff).toBe(BUFF_DURATION);
    expect(b.attackMult).toBe(rarityByName("rare").attackMult);
  });

  it("never downgrades an already-stronger active buff", () => {
    const { t, b } = freshTarget();
    applyLootEffect(t, b, { rarity: "legendary", category: "attack" }); // strong
    applyLootEffect(t, b, { rarity: "common", category: "attack" }); // weaker
    expect(b.attackMult).toBe(rarityByName("legendary").attackMult);
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
