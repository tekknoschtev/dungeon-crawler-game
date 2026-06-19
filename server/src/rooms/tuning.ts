/**
 * Gameplay tuning — every magic number the simulation leans on, in one place.
 *
 * Pulled out of DungeonRoom so the pure logic (see logic.ts) and its tests can
 * share the exact same constants the live room uses. Changing balance here
 * changes both the server and the tests in lockstep, so a tuning tweak can't
 * silently drift away from what the suite asserts.
 */

// --- Player ------------------------------------------------------------
// Tuned for 16px tiles. PLAYER_RADIUS keeps the hero's box narrower than a
// 1-tile corridor so it slips through gaps.
export const PLAYER_SPEED = 80; // px/s
export const PLAYER_RADIUS = 5;
export const PLAYER_MAX_HP = 100;
export const PLAYER_ATTACK_DAMAGE = 12;
export const PLAYER_ATTACK_RANGE = 24; // px radius of the (omnidirectional) melee swing
export const PLAYER_ATTACK_COOLDOWN = 0.45; // s
export const RESPAWN_DELAY = 3; // s

// --- Mobs --------------------------------------------------------------
export const MOB_MAX_HP = 30;
export const MOB_SPEED = 50; // px/s — slower than the player so mobs are kiteable
export const MOB_RADIUS = 5;
export const MOB_DAMAGE = 8;
export const MOB_ATTACK_COOLDOWN = 1.0; // s
export const MOB_AGGRO_RANGE = 96; // px (~6 tiles)
export const MOB_ATTACK_RANGE = 18; // px
export const MOB_TARGET_COUNT = 12; // population the room tops up to
export const MOB_RESPAWN_INTERVAL = 4; // s between top-up spawns

// --- Loot --------------------------------------------------------------
export const PICKUP_RANGE = 14; // px — auto-collect radius
export const BUFF_DURATION = 6; // s — attack/defense buff length
export const HEAL_PCT = 0.4; // fraction of max HP restored per quaffed potion
export const MAX_HEAL_CHARGES = 5; // how many heal potions a hero can stockpile

export interface Rarity {
  name: string;
  weight: number;
  attackMult: number;
  defenseReduce: number;
}

// Loot rarity: drop weight + how strongly it scales the attack/defense buffs.
// (Heals are a flat % and stack, so rarity no longer affects them.)
export const RARITIES: Rarity[] = [
  { name: "common", weight: 60, attackMult: 1.4, defenseReduce: 0.2 },
  { name: "uncommon", weight: 25, attackMult: 1.7, defenseReduce: 0.35 },
  { name: "rare", weight: 10, attackMult: 2.0, defenseReduce: 0.5 },
  { name: "epic", weight: 4, attackMult: 2.3, defenseReduce: 0.6 },
  { name: "legendary", weight: 1, attackMult: 2.6, defenseReduce: 0.7 },
];
export const RARITY_TOTAL = RARITIES.reduce((sum, r) => sum + r.weight, 0);
export const rarityByName = (name: string): Rarity =>
  RARITIES.find((r) => r.name === name) ?? RARITIES[0];

// Loot categories: attack/defense a touch more common than heal, so heals feel
// like the prize you ration.
export const CATEGORIES = [
  { name: "attack", weight: 40 },
  { name: "defense", weight: 40 },
  { name: "heal", weight: 30 },
];
export const CATEGORY_TOTAL = CATEGORIES.reduce((sum, c) => sum + c.weight, 0);
