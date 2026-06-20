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
  defenseReduce: number;
}

// Loot rarity: drop weight + how strongly it scales the defense buff. (Attack
// drops are weapons now — their power lives in WEAPONS, not here; heals are a
// flat % and stack, so rarity doesn't touch them either.) Rarity still tags the
// floor-glow color on the client. Potency is bumped alongside the rarer drop
// rates (see CATEGORIES) so the buffs you do find feel worth the wait.
export const RARITIES: Rarity[] = [
  { name: "common", weight: 60, defenseReduce: 0.25 },
  { name: "uncommon", weight: 25, defenseReduce: 0.4 },
  { name: "rare", weight: 10, defenseReduce: 0.55 },
  { name: "epic", weight: 4, defenseReduce: 0.65 },
  { name: "legendary", weight: 1, defenseReduce: 0.75 },
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

// --- Weapons -----------------------------------------------------------
// An "attack" drop is now one of several distinct weapons, not a generic buff
// scaled only by rarity. Each weapon equips for `duration` seconds and gives its
// own damage `attackMult`; the heavy ones also `knockback` mobs you hit (px the
// mob is shoved back). The bigger the impact, the rarer the drop — so `weight`
// falls as the effect grows. `rarity` only tags the floor-glow color (mirrors
// RARITY_COLORS on the client); the gameplay numbers live entirely here.
//
// `frame` is the Tiny Dungeon sheet index the *client* renders for this weapon's
// drop — kept here so the canonical table is in one place, but the client mirrors
// it (WEAPON_FRAMES in GameScene.ts) since the server never renders. Keep the
// names in sync with that mirror.
export interface Weapon {
  name: string;
  frame: number; // Tiny Dungeon sheet index (client render hint)
  rarity: string; // floor-glow tier only (see RARITY_COLORS)
  weight: number; // drop weight: rarer = bigger effect
  attackMult: number; // damage multiplier while equipped
  duration: number; // s the weapon stays equipped
  knockback: number; // px a hit mob is shoved back (0 = none)
}

// Keep "shortsword" first and "warhammer" last: logic.test.ts pins rollWeapon's
// bottom/top buckets to that order.
export const WEAPONS: Weapon[] = [
  { name: "shortsword", frame: 103, rarity: "common", weight: 40, attackMult: 1.6, duration: 9, knockback: 0 },
  { name: "longsword", frame: 104, rarity: "uncommon", weight: 24, attackMult: 1.8, duration: 15, knockback: 0 },
  { name: "handaxe", frame: 119, rarity: "uncommon", weight: 14, attackMult: 2.1, duration: 9, knockback: 0 },
  { name: "falchion", frame: 105, rarity: "rare", weight: 9, attackMult: 2.4, duration: 11, knockback: 0 },
  { name: "broadsword", frame: 106, rarity: "rare", weight: 7, attackMult: 2.2, duration: 10, knockback: 28 },
  { name: "battleaxe", frame: 118, rarity: "epic", weight: 4, attackMult: 2.6, duration: 12, knockback: 40 },
  { name: "warhammer", frame: 117, rarity: "legendary", weight: 2, attackMult: 2.9, duration: 16, knockback: 56 },
];
export const WEAPON_TOTAL = WEAPONS.reduce((sum, w) => sum + w.weight, 0);
export const weaponByName = (name: string): Weapon =>
  WEAPONS.find((w) => w.name === name) ?? WEAPONS[0];
