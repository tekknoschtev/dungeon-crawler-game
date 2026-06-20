import { describe, it, expect } from "vitest";
import {
  dist,
  normalize,
  collides,
  rollRarity,
  rollCategory,
  rollWeapon,
  applyLootEffect,
  applyKnockback,
  playerAttackDamage,
  mobDamageAfterDefense,
  regenHp,
  isAllowedColor,
  isAllowedSprite,
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
  weaponByName,
} from "./tuning";

/** A fresh, unbuffed loot target + combat buffs pair. */
function freshTarget(): { t: LootTarget; b: LootBuffs } {
  return {
    t: { attackBuff: 0, defenseBuff: 0, healCharges: 0, weapon: "" },
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
