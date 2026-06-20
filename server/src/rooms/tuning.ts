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
// Slow passive heal while alive, so heroes recover between fights without making
// potions pointless. At 1.5 HP/s a full heal from near-death takes ~over a
// minute — negligible mid-fight (a slime does 8/s), meaningful during a lull.
// This is the main knob to dial after playtesting.
export const PASSIVE_REGEN = 1.5; // HP/s

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
export const BUFF_DURATION = 9; // s — attack/defense buff length (longer: rarer drops, so each lasts)
export const HEAL_PCT = 0.4; // fraction of max HP restored per quaffed potion
export const MAX_HEAL_CHARGES = 5; // how many heal potions a hero can stockpile

// --- Death markers -----------------------------------------------------
// A tombstone left where a hero fell, tinted to their color. Synced state, so
// cap it — old markers are culled oldest-first once there are more than this.
export const MAX_DEATH_MARKERS = 24;

export interface Rarity {
  name: string;
  weight: number;
  attackMult: number;
  defenseReduce: number;
}

// Loot rarity: drop weight + how strongly it scales the attack/defense buffs.
// (Heals are a flat % and stack, so rarity no longer affects them.)
// Potency bumped alongside the rarer drop rates (see CATEGORIES) so the buffs
// you do find feel worth the wait.
export const RARITIES: Rarity[] = [
  { name: "common", weight: 60, attackMult: 1.6, defenseReduce: 0.25 },
  { name: "uncommon", weight: 25, attackMult: 1.9, defenseReduce: 0.4 },
  { name: "rare", weight: 10, attackMult: 2.2, defenseReduce: 0.55 },
  { name: "epic", weight: 4, attackMult: 2.5, defenseReduce: 0.65 },
  { name: "legendary", weight: 1, attackMult: 2.8, defenseReduce: 0.75 },
];
export const RARITY_TOTAL = RARITIES.reduce((sum, r) => sum + r.weight, 0);
export const rarityByName = (name: string): Rarity =>
  RARITIES.find((r) => r.name === name) ?? RARITIES[0];

// Loot categories: heals are now the common drop (heroes can quaff freely),
// while attack/defense buffs are the rarer prize — offset by longer, stronger
// buffs (see BUFF_DURATION and RARITIES). Keep "attack" first and "heal" last:
// logic.test.ts pins rollCategory's bottom/top buckets to that order.
export const CATEGORIES = [
  { name: "attack", weight: 20 },
  { name: "defense", weight: 20 },
  { name: "heal", weight: 60 },
];
export const CATEGORY_TOTAL = CATEGORIES.reduce((sum, c) => sum + c.weight, 0);
