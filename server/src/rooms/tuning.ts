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
// Slow passive heal while alive, so heroes recover between fights without making
// potions pointless. At 1.5 HP/s a full heal from near-death takes ~over a
// minute — negligible mid-fight (a slime does 8/s), meaningful during a lull.
// This is the main knob to dial after playtesting.
export const PASSIVE_REGEN = 1.5; // HP/s

// --- Run stakes (downed / respawn / lives) -----------------------------
// A run is losable (M2). A hero at 0 HP is "downed", not dead: a ramping cooldown
// counts down, then they spend a life to self-respawn OR wait for a teammate to
// revive them for free. Lives are a run resource — you start below the cap and
// bank +1 each descent, so racing deep buys survivability at the cost of score.
export const STARTING_LIVES = 3; // lives every hero starts a run with (below LIFE_CAP)
export const LIFE_CAP = 6; // most lives a hero can bank (the +1/descent guardrail)
// Self-respawn unlock delay (s), indexed by how many times this hero has already
// self-respawned this run (clamped to the last). Ramps so later deaths cost more
// downtime — long enough that heat climbs meaningfully while you're down.
export const RESPAWN_DELAYS = [4, 6, 9, 13, 18];
export const REVIVE_RANGE = 18; // px — how close a healer must be to revive a downed ally
export const REVIVE_HP_PCT = 0.5; // fraction of max HP a revived ally comes back with

// --- Mobs --------------------------------------------------------------
export const MOB_MAX_HP = 30;
export const MOB_SPEED = 50; // px/s — slower than the player so mobs are kiteable
export const MOB_RADIUS = 5;
export const MOB_DAMAGE = 8;
export const MOB_ATTACK_COOLDOWN = 1.0; // s
export const MOB_AGGRO_RANGE = 96; // px (~6 tiles)
export const MOB_ATTACK_RANGE = 18; // px

// --- Pressure (the per-floor difficulty clock) -------------------------
// Mob pressure ramps with TIME ON THE FLOOR, not by clearing it — a fresh floor
// starts calm and climbs to a sweat over PRESSURE_RAMP_TIME, then holds. The ramp
// (and the spawn timer) reset every time the party descends, so each new floor is
// a breather that builds again (see DungeonRoom.enterFloor). `heat` (0..1) is this
// ramp surfaced to the HUD. Tuned for a ~2–3 min floor: staying floods you with
// targets, which is the pull to linger against the push to descend.
export const PRESSURE_RAMP_TIME = 150; // s for heat to climb 0 → 1
export const PRESSURE_BASE_TARGET = 6; // live mob population on a fresh, calm floor (heat 0)
export const PRESSURE_MAX_TARGET = 22; // population the ramp tops out at (heat 1)
export const PRESSURE_SPAWN_INTERVAL_CALM = 5.0; // s between top-up spawns at heat 0
export const PRESSURE_SPAWN_INTERVAL_HOT = 1.2; // s between top-up spawns at heat 1
export const PRESSURE_TARGET_HARD_CAP = 30; // absolute population ceiling (depth bonus included)

// --- Depth scaling -----------------------------------------------------
// Each floor deeper raises the stakes: tougher mobs and a higher starting
// pressure baseline, so "go deeper" means "scarier." depth is 1-based — floor 1
// gets no bonus, floor N gets (N-1)× each scaler.
export const DEPTH_PRESSURE_BONUS = 1.5; // extra target population per floor below 1
export const DEPTH_HP_SCALE = 0.15; // +15% mob max HP per floor below 1
export const DEPTH_DAMAGE_SCALE = 0.1; // +10% mob damage per floor below 1

// --- Descent -----------------------------------------------------------
// Leaving is never forced (no "clear the floor"): a hero walks to the exit and
// holds it briefly, then the whole party drops to the next floor (pressure
// resets, depth +1). The short channel stops an accidental brush from dropping
// everyone mid-fight.
export const EXIT_RADIUS = 14; // px — how close a hero must be to count as "on" the exit
export const DESCEND_CHANNEL_TIME = 1.5; // s a hero must hold the exit before the party descends
// On descend the server signals clients (fade to black), waits this long so the
// screen is black, then swaps floors — so the teleport happens unseen, not as a pop.
export const DESCEND_FADE_MS = 300;

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
