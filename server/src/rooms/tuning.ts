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
// The slime baseline. These stay the canonical defaults (the slime entry in MOBS
// mirrors them, so floor 1 feels exactly as before) and back the logic.ts param
// defaults + their tests. Per-kind stats live in MOBS below.
export const MOB_MAX_HP = 30;
export const MOB_SPEED = 50; // px/s — slower than the player so mobs are kiteable
export const MOB_RADIUS = 5;
export const MOB_DAMAGE = 8;
export const MOB_ATTACK_COOLDOWN = 1.0; // s
export const MOB_AGGRO_RANGE = 96; // px (~6 tiles)
export const MOB_ATTACK_RANGE = 18; // px

// Mob bestiary (M5). One row per kind; the spawn mix is a depth-gated weighted
// roll (see rollMobKind) so deeper floors unlock tougher monsters while the early
// floors stay a slime-and-rat warm-up. Per-kind stats let each read distinctly:
// rats/bats are fast and fragile (skittering pressure), crabs/ghosts are slow
// bruisers (they hit hard), imps/spiders are aggressive mid-tier. `hp`/`damage`
// are the *base* values — depth still scales them on top (scaleMobHp/Damage).
// `score` is the base kill value feeding M3's heat-multiplied scoring (tougher,
// rarer, deeper kinds pay more). `minDepth` is the first floor a kind appears on;
// `weight` is its spawn share among the kinds eligible on the current floor.
//
// `frame` is the Tiny Dungeon sheet index the *client* renders (mirrored by
// MOB_FRAMES in GameScene.ts — keep the names in sync); the server never renders.
export interface MobKind {
  name: string; // synced to Mob.kind
  frame: number; // Tiny Dungeon sheet index (client render hint)
  hp: number; // base max HP (before depth scaling)
  speed: number; // px/s chase speed (wander is half this)
  damage: number; // base contact damage (before depth scaling)
  aggro: number; // px — how far it notices a hero
  score: number; // base kill points (before depth + heat multiplier)
  minDepth: number; // earliest floor this kind can spawn on (1-based)
  weight: number; // spawn weight among the kinds eligible this floor
}

// Keep "slime" first and "ghost" last: logic.test.ts pins rollMobKind's bottom
// (floor 1) and top (deep floor) buckets to that order. The slime row matches the
// MOB_* defaults above so floor 1 is unchanged from pre-M5.
export const MOBS: MobKind[] = [
  { name: "slime", frame: 108, hp: 30, speed: 50, damage: 8, aggro: 96, score: 10, minDepth: 1, weight: 40 },
  { name: "rat", frame: 124, hp: 16, speed: 72, damage: 5, aggro: 84, score: 8, minDepth: 1, weight: 24 },
  { name: "bat", frame: 120, hp: 18, speed: 80, damage: 6, aggro: 112, score: 12, minDepth: 2, weight: 18 },
  { name: "crab", frame: 110, hp: 48, speed: 46, damage: 12, aggro: 100, score: 18, minDepth: 3, weight: 16 },
  { name: "imp", frame: 109, hp: 30, speed: 64, damage: 14, aggro: 124, score: 24, minDepth: 4, weight: 12 },
  { name: "spider", frame: 122, hp: 26, speed: 68, damage: 9, aggro: 128, score: 16, minDepth: 5, weight: 12 },
  { name: "ghost", frame: 121, hp: 42, speed: 58, damage: 17, aggro: 140, score: 32, minDepth: 7, weight: 8 },
];
export const mobByName = (name: string): MobKind =>
  MOBS.find((m) => m.name === name) ?? MOBS[0];

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

// --- Spawn lull (M9) ---------------------------------------------------
// A comeback valve for deep floors. When a mob dies its slot doesn't refill
// immediately — the pressure spawner is held off for a beat, and every kill
// extends the hold (stacking up to a cap). So chipping one mob barely registers
// against the hot top-up cadence (PRESSURE_SPAWN_INTERVAL_HOT ~1.2s), but routing
// a cluster at once — AoE, knockback, the M10 bomb — empties a stack of slots
// that all stay empty together, buying several seconds of quiet. This is what
// makes killing *en masse* feel like progress and a deliberate pressure-relief
// tactic. PER_KILL is deliberately under the hot interval so a single kill is no
// relief; MAX caps a huge rout so the floor can't be emptied indefinitely.
export const SPAWN_LULL_PER_KILL = 0.6; // s of refill suppression added per kill
export const SPAWN_LULL_MAX = 4.0; // s — ceiling on accumulated suppression

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

// Exit pulse (M11): the descent is the intended pressure reset, but you have to
// survive the channel to reach it. While a hero holds the exit, the ladder wards
// the stairs — periodic pulses shove nearby mobs back and briefly stagger them
// (reusing the bomb stun + applyKnockback) — so racing to the stairs is a viable
// escape *under fire*, not something you can only do once a room's already clear.
export const EXIT_PULSE_RADIUS = 40; // px — how far from the ladder a pulse reaches
export const EXIT_PULSE_INTERVAL = 0.5; // s between pulses while a hero channels
export const EXIT_PULSE_KNOCKBACK = 36; // px a pulsed mob is shoved away from the ladder
export const EXIT_PULSE_STAGGER = 0.5; // s a pulsed mob is staggered (stunned)
// On descend the server signals clients (fade to black), waits this long so the
// screen is black, then swaps floors — so the teleport happens unseen, not as a pop.
export const DESCEND_FADE_MS = 300;

// --- Loot --------------------------------------------------------------
export const PICKUP_RANGE = 14; // px — auto-collect radius
export const BUFF_DURATION = 9; // s — attack/defense buff length (longer: rarer drops, so each lasts)
export const HEAL_PCT = 0.4; // fraction of max HP restored per quaffed potion
export const MAX_HEAL_CHARGES = 5; // how many heal potions a hero can stockpile

// --- Scoring (M3) ------------------------------------------------------
// A run is a score chase. Kills and loot score at a live multiplier that climbs
// with the floor's `heat` (dwelling at high heat mints points fast); descending
// banks the floor's haul and resets the multiplier, while a wipe forfeits the
// un-banked floor. So score embodies the dwell-vs-descend tension: greed vs safety.
export const SCORE_PER_KILL = 10; // base points per mob (before depth + multiplier)
export const SCORE_DEPTH_SCALE = 0.1; // +10% kill value per floor below 1 (tougher = worth more)
export const SCORE_MULT_MAX = 3; // heat 1 ⇒ ×3 — the dwell payoff ceiling (headline knob)
// Dark floors are higher-risk (you're blind, the mobs aren't), so everything you
// earn on one pays more — the reward that flips "ugh, dark" into "ooh, dark."
export const DARK_FLOOR_SCORE_MULT = 1.5;
// Torchlit floors are only partially dark (static torches light the rooms; the
// gaps between them are the risk), so they pay a smaller bump than full dark.
export const TORCHLIT_FLOOR_SCORE_MULT = 1.25;
export const SCORE_DEPTH_BONUS = 100; // × depth, granted + banked on each descend
// Points a picked-up drop is worth by rarity (before the multiplier). Tuned against
// RARITIES' drop weights so a legendary reads as a jackpot, not just a bigger common.
export const LOOT_SCORE: Record<string, number> = {
  common: 15,
  uncommon: 40,
  rare: 100,
  epic: 250,
  legendary: 600,
};

// --- Death markers -----------------------------------------------------
// A tombstone left where a hero fell, tinted to their color. Synced state, so
// cap it — old markers are culled oldest-first once there are more than this.
export const MAX_DEATH_MARKERS = 24;

// --- Breakable crates (M6) ---------------------------------------------
// Crates/barrels/kegs are destructible props: hit them to break them. They
// award a small score bonus and have a chance to drop a heal potion. Every
// floor hides one vault key in a random crate — finding it instantly opens
// the vault door so the party claims the chest before the countdown ends.
export const CRATE_HP = 2;               // hits to destroy (2 = quick but not instant)
export const CRATE_RADIUS = 7;           // px hit detection (added to PLAYER_ATTACK_RANGE)
export const CRATE_SCORE_BONUS = 5;      // direct score awarded to the breaker
export const CRATE_POTION_CHANCE = 0.4;  // 40% chance of a common heal potion drop

// --- Collectible bomb (M10) --------------------------------------------
// A deep-floor comeback tool. Broken crates have a chance (rubber-banded deeper,
// so bombs show up when the floor is drowning you) to drop a bomb the player
// carries and places with the E key (or a contextual mobile button). On a short
// fuse it does two things at once: a LOCAL blast — radius damage + knockback that
// also hurts the placer if they're still inside (the skill/risk) — and a MAP-WIDE
// stun freezing every mob for a beat (the relief: reposition, revive, or bolt for
// the stairs while they're stunned). Bomb kills route through killMob, so they
// score to the placer and feed the M9 spawn lull for free. A deliberate exception
// to the "immediate-use loot / no new buttons" rules (see roadmap M10); the carry
// count mirrors MAX_HEAL_CHARGES and the mobile button is contextual/transient.
export const MAX_BOMBS = 2; // carry cap (stockpile, like heal charges)
export const CRATE_BOMB_CHANCE_BASE = 0.12; // floor-1 chance a broken crate drops a bomb
export const CRATE_BOMB_CHANCE_DEPTH = 0.02; // +chance per floor below 1 (rubber-band)
export const CRATE_BOMB_CHANCE_MAX = 0.35; // ceiling so deep floors aren't flooded with bombs
export const BOMB_FUSE = 1.2; // s from placement to detonation (time to step clear)
export const BOMB_BLAST_RADIUS = 45; // px — radius of the damaging/knockback blast
export const BOMB_BLAST_DAMAGE = 60; // damage to mobs AND players caught in the blast
export const BOMB_KNOCKBACK = 48; // px a mob in the blast is shoved outward from the bomb
export const BOMB_STUN = 2.5; // s every mob on the map is frozen on detonation
export const BOMB_FRAME = 105; // Tiny Town sheet index the client renders (bomb tile)

// --- Special floors ------------------------------------------------------
// Goldvault floors are strewn with pure-score treasure pickups ("treasure"
// loot category: no buff, just points at the floor's live multiplier —
// coins are uncommon-value, sacks rare-value; see rollTreasure). Dormant
// until special-floor triggers exist (the biome isn't in the depth bands),
// but fully live under the DUNGEON_BIOME override.
export const GOLDVAULT_TREASURE_COUNT = 12; // drops scattered per goldvault floor
export const TREASURE_SACK_CHANCE = 0.2; // share of drops that are the fat sack

// --- Strange stairway (goldvault special-floor trigger) ----------------
// An uncommon SECOND exit that appears on some floors (seeded presence +
// position, on a dedicated RNG stream so it never perturbs geometry — see
// map.ts). Standing on it as a party detours everyone into a goldvault
// treasure floor; a return exit sends the whole room back to the same floor
// to descend normally. Additive bonus content, not a branch (see
// docs/special-floors-plan.md).
// (Its per-floor rarity + placement rules are GENERATION constants and live with
// the rest of the generator in map.ts — see STAIRWAY_CHANCE there.)
export const STAIRWAY_GATHER_RADIUS = 28; // px — the gather zone a hero stands in (~1.75 tiles)
export const STAIRWAY_COUNTDOWN = 3; // s the quorum must hold the zone before the room transitions
// Gather-to-enter quorum = "all but one" (holdout-proof: a lone AFK/dead player
// can't block the vault, but a real group has to converge). See stairwayQuorum.

// --- Vault (strange-stairway detour) floor -----------------------------
// The vault is a goldvault floor entered via the strange stairway: depth-scaled
// mobs but a LIGHTER, non-ramping population — it reads as a smash-and-grab, not
// a pressure cooker (the cost is paid on the flooded return, not in the vault).
export const VAULT_MOB_BASE = 4; // calm starting population in the vault
export const VAULT_MOB_MAX = 8; // ceiling even at full vault-heat (well under a normal floor)

// The vault's reward chest: unlike the M4 chest it opens IMMEDIATELY (no lock,
// no timer, no key) — a single swing cracks it. Grants a treasure jackpot to the
// party and a unique gold trophy to the opener (see VAULT_RELICS). The points are
// VAULT_CHEST_POINTS × depth × heat-multiplier × floor-mult, like a fat chest.
export const VAULT_CHEST_POINTS = 120; // × depth — a jackpot base above the M4 chest's 60
// Unique goldvault trophies the opener keeps for the run (score-screen flavor,
// like relics — but a hand-picked gilded pool, distinct from the procedural M4
// relic names). One is rolled per vault chest opened; see rollVaultRelic.
export const VAULT_RELICS = [
  "the Midas Coffer",
  "the Gilded Fang",
  "Aurelian's Hoard",
  "the Sunken Crown",
  "the Bullion Heart",
  "the Coinforged Idol",
  "the Dragon's Tithe",
  "the Everfull Purse",
];

// --- Vault chest (M4) --------------------------------------------------
// One vault per floor: visible from arrival, sealed behind a timed door that
// opens once the floor's heat is already spicy. Cracking it open under fire pays
// depth-scaled mega-points (×heat multiplier, un-banked like all floor score),
// plus the opener gets a full heal + a long buff + a flavor relic. The unlock
// time is the headline feel knob — it should land right as "should I leave?"
// starts to bite (heat ≈ 0.6 on the 150s ramp).
export const CHEST_UNLOCK_TIME = 90; // s on the floor before the door opens
export const CHEST_HP = 1; // one solid swing cracks it open (no chip-away grind)
export const CHEST_RADIUS = 7; // px — melee reach to chip it (added to PLAYER_ATTACK_RANGE)
export const CHEST_BASE_POINTS = 60; // × depth, × heat multiplier — the mega-reward base
export const CHEST_BUFF_DURATION = 18; // s of attack + defense buff granted to the opener

// Relic: a procedurally-named flavor trophy the opener keeps for the run (never
// held or used — score-screen flavor only). A rarity is rolled (weighted, biased
// deeper) then a name is built from rarity-tiered word pools. Rarer/deeper chests
// roll grander names. Mirrors the RARITIES table pattern.
export interface RelicRarity {
  name: string;
  weight: number;
}
// Keep "worn" first and "mythic" last: logic.test.ts pins rollRelic's bottom/top
// tiers to that order. Deeper floors shift the rarity floor up (see rollRelic).
export const RELIC_RARITIES: RelicRarity[] = [
  { name: "worn", weight: 50 },
  { name: "fine", weight: 28 },
  { name: "ornate", weight: 14 },
  { name: "regal", weight: 6 },
  { name: "mythic", weight: 2 },
];
export const RELIC_RARITY_TOTAL = RELIC_RARITIES.reduce((sum, r) => sum + r.weight, 0);

// Per-rarity word pools. A relic name is `${adjective} ${noun}` plus, for the
// grander tiers, an optional " of the ${suffix}". Indexed by rarity name; deeper
// tiers read grander. (rng picks within each pool; see rollRelic.)
export const RELIC_ADJECTIVES: Record<string, string[]> = {
  worn: ["Cracked", "Rusty", "Chipped", "Dull", "Mossy"],
  fine: ["Polished", "Sturdy", "Keen", "Burnished", "Etched"],
  ornate: ["Gilded", "Jeweled", "Runed", "Silvered", "Filigreed"],
  regal: ["Radiant", "Hallowed", "Imperial", "Resplendent", "Astral"],
  mythic: ["Eternal", "Godforged", "Abyssal", "Celestial", "Sovereign"],
};
export const RELIC_NOUNS: Record<string, string[]> = {
  worn: ["Spoon", "Trinket", "Buckle", "Token", "Charm"],
  fine: ["Chalice", "Locket", "Sigil", "Pendant", "Idol"],
  ornate: ["Crown", "Scepter", "Reliquary", "Talisman", "Diadem"],
  regal: ["Fang", "Heart", "Eye", "Crucible", "Aegis"],
  mythic: ["Fang", "Heart", "Eye", "Throne", "Star"],
};
// Suffix pool ("… of the ___"), only appended for the grander tiers (see rollRelic).
export const RELIC_SUFFIXES = [
  "Deep", "Abyss", "Forgotten", "Ember", "Void", "Dawn", "Hollow", "Storm",
];
// Every RELIC_DEPTH_STEP floors, the lowest rarity a relic can roll climbs one
// rung — so deeper chests can't hand out a "Cracked Spoon." Suffixes (" of the
// ___") only attach from the RELIC_SUFFIX_MIN_TIER rung up (ornate and grander).
export const RELIC_DEPTH_STEP = 2;
export const RELIC_SUFFIX_MIN_TIER = 2; // index into RELIC_RARITIES (0 = worn)

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
