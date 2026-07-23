/**
 * Pure game logic — the math the authoritative simulation runs on, with every
 * dependency passed in as an argument (grid, RNG, plain numbers/structs) and no
 * reference to Colyseus, the room, or wall-clock time.
 *
 * DungeonRoom owns the simulation *loop* (per CLAUDE.md, movement/physics stays
 * in DungeonRoom.update()); this module owns the individual *decisions* that loop
 * makes, so each can be unit-tested in isolation and deterministically.
 */
import {
  PLAYER_ATTACK_DAMAGE,
  MOB_DAMAGE,
  BUFF_DURATION,
  MAX_HEAL_CHARGES,
  MAX_BOMBS,
  CRATE_BOMB_CHANCE_BASE,
  CRATE_BOMB_CHANCE_DEPTH,
  CRATE_BOMB_CHANCE_MAX,
  TREASURE_SACK_CHANCE,
  PASSIVE_REGEN,
  RARITIES,
  RARITY_TOTAL,
  CATEGORIES,
  CATEGORY_TOTAL,
  WEAPONS,
  WEAPON_TOTAL,
  MOBS,
  rarityByName,
  weaponByName,
  PRESSURE_RAMP_TIME,
  PRESSURE_BASE_TARGET,
  PRESSURE_MAX_TARGET,
  PRESSURE_SPAWN_INTERVAL_CALM,
  PRESSURE_SPAWN_INTERVAL_HOT,
  PRESSURE_TARGET_HARD_CAP,
  SPAWN_LULL_PER_KILL,
  SPAWN_LULL_MAX,
  DEPTH_PRESSURE_BONUS,
  DEPTH_HP_SCALE,
  DEPTH_DAMAGE_SCALE,
  RESPAWN_DELAYS,
  SCORE_PER_KILL,
  SCORE_DEPTH_SCALE,
  SCORE_MULT_MAX,
  SCORE_DEPTH_BONUS,
  LOOT_SCORE,
  CHEST_BASE_POINTS,
  VAULT_MOB_BASE,
  VAULT_MOB_MAX,
  VAULT_CHEST_POINTS,
  VAULT_RELICS,
  RELIC_RARITIES,
  RELIC_ADJECTIVES,
  RELIC_NOUNS,
  RELIC_SUFFIXES,
  RELIC_DEPTH_STEP,
  RELIC_SUFFIX_MIN_TIER,
  type Rarity,
  type Weapon,
  type MobKind,
} from "./tuning";

/** A function returning a float in [0, 1). Math.random by default; injectable in tests. */
export type Rng = () => number;

// --- Geometry ----------------------------------------------------------

export function dist(ax: number, ay: number, bx: number, by: number): number {
  return Math.hypot(ax - bx, ay - by);
}

/** Unit vector of (dx, dy), or (0, 0) when the input has no length. */
export function normalize(dx: number, dy: number): { x: number; y: number } {
  const len = Math.hypot(dx, dy);
  if (len === 0) return { x: 0, y: 0 };
  return { x: dx / len, y: dy / len };
}

/**
 * True if an axis-aligned box of half-size r centered at (x, y) overlaps any
 * wall tile (grid value 1) or the out-of-bounds rock beyond the grid edge.
 * grid is indexed [y][x]; tileSize is the pixel size of one tile.
 */
export function collides(
  grid: number[][],
  width: number,
  height: number,
  tileSize: number,
  x: number,
  y: number,
  r: number
): boolean {
  const corners = [
    [x - r, y - r],
    [x + r, y - r],
    [x - r, y + r],
    [x + r, y + r],
  ];
  for (const [cx, cy] of corners) {
    const tx = Math.floor(cx / tileSize);
    const ty = Math.floor(cy / tileSize);
    if (ty < 0 || ty >= height || tx < 0 || tx >= width) return true;
    if (grid[ty][tx] === 1) return true;
  }
  return false;
}

// --- Loot rolls --------------------------------------------------------

/** Weighted pick from a list of {weight} items using rng; falls back to the first. */
function rollWeighted<T extends { weight: number }>(items: T[], total: number, rng: Rng): T {
  let roll = rng() * total;
  for (const item of items) {
    roll -= item.weight;
    if (roll < 0) return item;
  }
  return items[0];
}

export function rollRarity(rng: Rng = Math.random): Rarity {
  return rollWeighted(RARITIES, RARITY_TOTAL, rng);
}

export function rollCategory(rng: Rng = Math.random): string {
  return rollWeighted(CATEGORIES, CATEGORY_TOTAL, rng).name;
}

/** Which weapon an "attack" drop is — rarer weapons hit harder/knock back. */
export function rollWeapon(rng: Rng = Math.random): Weapon {
  return rollWeighted(WEAPONS, WEAPON_TOTAL, rng);
}

/**
 * Pick which kind of mob to spawn on floor `depth` (M5): a weighted roll among
 * only the kinds whose `minDepth` has been reached, so early floors stay a
 * slime-and-rat warm-up and deeper floors fold in the tougher monsters. The
 * eligible pool always contains the slime (minDepth 1), so it never rolls empty;
 * the guard is belt-and-suspenders. The weight total is recomputed per call since
 * the eligible set grows with depth.
 */
export function rollMobKind(depth: number, rng: Rng = Math.random): MobKind {
  const eligible = MOBS.filter((m) => m.minDepth <= depth);
  const pool = eligible.length > 0 ? eligible : [MOBS[0]];
  const total = pool.reduce((sum, m) => sum + m.weight, 0);
  return rollWeighted(pool, total, rng);
}

// --- Loot application --------------------------------------------------

/** The slice of a Player that loot mutates (Player satisfies this structurally). */
export interface LootTarget {
  attackBuff: number;
  defenseBuff: number;
  healCharges: number;
  bombs: number; // carried bombs (M10) — a "bomb" drop banks one, capped
  weapon: string; // name of the equipped weapon backing the attack buff (HUD icon)
}

/** The slice of per-player Combat state loot scales (never synced to clients). */
export interface LootBuffs {
  attackMult: number;
  defenseReduce: number;
  knockback: number; // px a hit mob is shoved while the weapon buff is active
}

export interface LootDrop {
  rarity: string;
  category: string; // "heal" | "attack" | "defense"
  variant?: string; // weapon name for an "attack" drop (see WEAPONS); empty otherwise
}

/**
 * Apply a walked-over drop: equip a weapon (attack), instant defense buff, or a
 * banked heal. Mutates `target`/`buffs` in place. Returns false if the drop
 * should be LEFT on the floor — a heal when the stack is already full — so it
 * stays available for later or for a teammate.
 *
 * Weapon perks (power, duration, knockback) only ever ratchet up: grabbing a
 * lesser weapon never downgrades a stronger one you're already wielding, and
 * never shortens your remaining buff time.
 */
export function applyLootEffect(target: LootTarget, buffs: LootBuffs, loot: LootDrop): boolean {
  if (loot.category === "treasure") {
    // Pure score: no buff, no stack — the pickup path scores it by rarity
    // (like all loot) and that's the whole effect. Always consumed.
    return true;
  }
  if (loot.category === "attack") {
    const w = weaponByName(loot.variant ?? "");
    // The displayed weapon is whichever one owns the active (strongest) power, so
    // grabbing a lesser weapon refreshes the timer without changing the icon.
    if (w.attackMult >= buffs.attackMult) target.weapon = w.name;
    target.attackBuff = Math.max(target.attackBuff, w.duration);
    buffs.attackMult = Math.max(buffs.attackMult, w.attackMult);
    buffs.knockback = Math.max(buffs.knockback, w.knockback);
    return true;
  }
  if (loot.category === "bomb") {
    // A carried tool, not a buff: bank one if there's room, else leave it on the
    // floor (like a full heal stack) so a teammate — or you, later — can grab it.
    if (target.bombs >= MAX_BOMBS) return false;
    target.bombs++;
    return true;
  }
  const r = rarityByName(loot.rarity);
  if (loot.category === "defense") {
    target.defenseBuff = BUFF_DURATION;
    buffs.defenseReduce = Math.max(buffs.defenseReduce, r.defenseReduce);
    return true;
  }
  // heal: only grab it if there's room in the stack.
  if (target.healCharges >= MAX_HEAL_CHARGES) return false;
  target.healCharges++;
  return true;
}

/**
 * Roll one goldvault treasure drop (special floors): mostly coins
 * (uncommon-value score), sometimes the fat sack (rare-value). Pure for
 * testing; rarity feeds the normal loot-score path on pickup.
 */
export function rollTreasure(
  rng: Rng = Math.random,
  sackChance: number = TREASURE_SACK_CHANCE
): { variant: string; rarity: string } {
  return rng() < sackChance
    ? { variant: "sack", rarity: "rare" }
    : { variant: "coin", rarity: "uncommon" };
}

/**
 * Chance (0..1) a broken crate drops a bomb on floor `depth`. Rubber-banded:
 * climbs from the floor-1 base by a per-depth bump (capped), so deep floors —
 * exactly where the comeback tool is wanted — hand them out more often. `depth`
 * is 1-based (floor 1 gets the base, no bonus). Pure for testing.
 */
export function crateBombChance(
  depth: number,
  base: number = CRATE_BOMB_CHANCE_BASE,
  perDepth: number = CRATE_BOMB_CHANCE_DEPTH,
  max: number = CRATE_BOMB_CHANCE_MAX
): number {
  return Math.min(max, base + perDepth * Math.max(0, depth - 1));
}

// --- Combat damage -----------------------------------------------------

/** Damage a player swing deals, scaled by an active attack buff. */
export function playerAttackDamage(attackBuffActive: boolean, attackMult: number): number {
  return PLAYER_ATTACK_DAMAGE * (attackBuffActive ? attackMult : 1);
}

/**
 * Damage a mob hit deals to a player after an active defense buff soaks some.
 * `baseDamage` defaults to the flat constant but lets the caller pass a
 * depth-scaled value (see scaleMobDamage) so deeper floors hit harder.
 */
export function mobDamageAfterDefense(
  defenseBuffActive: boolean,
  defenseReduce: number,
  baseDamage: number = MOB_DAMAGE
): number {
  return baseDamage * (1 - (defenseBuffActive ? defenseReduce : 0));
}

/**
 * Where a mob ends up after being knocked `distance` px directly away from the
 * attacker at (px, py). Walks there in small steps with the same axis-separated
 * wall check the simulation uses, so a heavy shove slides along walls and can't
 * tunnel through one. Returns the mob's current spot unchanged when the attacker
 * is exactly on top of it (no push direction).
 */
export function applyKnockback(
  grid: number[][],
  width: number,
  height: number,
  tileSize: number,
  px: number,
  py: number,
  mx: number,
  my: number,
  distance: number,
  radius: number
): { x: number; y: number } {
  const dir = normalize(mx - px, my - py);
  if (dir.x === 0 && dir.y === 0) return { x: mx, y: my };
  const step = Math.max(1, radius); // px per sub-step keeps each hop < a tile
  let x = mx;
  let y = my;
  let remaining = distance;
  while (remaining > 0) {
    const s = Math.min(step, remaining);
    const nx = x + dir.x * s;
    const ny = y + dir.y * s;
    if (!collides(grid, width, height, tileSize, nx, y, radius)) x = nx;
    if (!collides(grid, width, height, tileSize, x, ny, radius)) y = ny;
    remaining -= s;
  }
  return { x, y };
}

// --- Cosmetics ---------------------------------------------------------

/**
 * True if `color` is one of the allowed hero colors. Used to vet the client's
 * lobby pick before it's stored/broadcast — an allowlist, so a hand-crafted
 * client can't smuggle an arbitrary string into the synced `Player.color`.
 */
export function isAllowedColor(color: string | undefined, palette: readonly string[]): boolean {
  return color !== undefined && palette.includes(color);
}

/**
 * True if `sprite` is one of the allowed hero frame indices. Same allowlist
 * guard as `isAllowedColor`, but for the lobby's hero-body pick — keeps a
 * hand-crafted client from setting `Player.sprite` to an arbitrary tile.
 */
export function isAllowedSprite(sprite: number | undefined, frames: readonly number[]): boolean {
  return sprite !== undefined && frames.includes(sprite);
}

// --- Passive regen -----------------------------------------------------

/**
 * HP after `dt` seconds of passive regen, clamped to `maxHp`. Caller gates on the
 * player being alive (hp > 0); this just does the clamped arithmetic so it stays
 * pure and testable. Already-full HP is returned unchanged.
 */
export function regenHp(
  hp: number,
  maxHp: number,
  dt: number,
  ratePerSec: number = PASSIVE_REGEN
): number {
  if (hp >= maxHp) return hp;
  return Math.min(maxHp, hp + ratePerSec * dt);
}

// --- Run stakes (downed / respawn / wipe) ------------------------------

/**
 * Seconds a downed hero waits before the self-respawn button unlocks, ramping by
 * how many times they've already self-respawned this run (`respawnsUsed`, 0 for
 * the first death). Indexes `delays`, clamping past its end so the longest delay
 * holds. Pure so the ramp can be asserted monotonic in tests.
 */
export function respawnDelay(
  respawnsUsed: number,
  delays: readonly number[] = RESPAWN_DELAYS
): number {
  if (delays.length === 0) return 0;
  const i = Math.min(Math.max(0, Math.floor(respawnsUsed)), delays.length - 1);
  return delays[i];
}

/**
 * True iff the party is wholly down — a non-empty room where every player is
 * downed. The room layers a lives check on top (a downed hero with a life can
 * still self-respawn), so this alone is not the game-over trigger; it's the
 * "nobody's standing" building block. Empty room ≠ wipe; one hero up ≠ wipe.
 */
export function isWipe(downedFlags: readonly boolean[]): boolean {
  return downedFlags.length > 0 && downedFlags.every(Boolean);
}

// --- Mob AI ------------------------------------------------------------

export interface AggroCandidate {
  id: string;
  x: number;
  y: number;
}

/**
 * The nearest candidate strictly within `maxRange` of (mx, my), or null if none.
 * Callers pre-filter to living players, so this stays a pure distance pick.
 */
export function pickAggroTarget(
  mx: number,
  my: number,
  candidates: AggroCandidate[],
  maxRange: number
): { id: string; dist: number } | null {
  let bestId = "";
  let best = maxRange;
  for (const c of candidates) {
    const d = dist(mx, my, c.x, c.y);
    if (d < best) {
      best = d;
      bestId = c.id;
    }
  }
  return bestId === "" ? null : { id: bestId, dist: best };
}

// --- Pressure & depth --------------------------------------------------
// The per-floor difficulty clock. `heatLevel` turns time-on-floor into a 0..1
// ramp; the mob population target and top-up cadence are both read off that heat
// (so they climb together), and `depth` shifts everything tougher. All pure so
// the curve can be unit-tested without a clock — DungeonRoom feeds in elapsed
// time and the current depth each tick.

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** Floor "heat" in [0, 1]: how far the pressure ramp has climbed since arrival. */
export function heatLevel(floorElapsed: number, rampTime: number = PRESSURE_RAMP_TIME): number {
  return clamp01(floorElapsed / rampTime);
}

/**
 * Live mob population the floor wants right now: a heat-driven lerp from the calm
 * baseline to the max, plus a per-depth bonus, capped. `depth` is 1-based.
 */
export function targetMobCount(
  heat: number,
  depth: number,
  base: number = PRESSURE_BASE_TARGET,
  max: number = PRESSURE_MAX_TARGET,
  depthBonus: number = DEPTH_PRESSURE_BONUS,
  hardCap: number = PRESSURE_TARGET_HARD_CAP
): number {
  const want = lerp(base, max, clamp01(heat)) + depthBonus * (depth - 1);
  return Math.min(hardCap, Math.round(want));
}

/**
 * Live mob population a strange-stairway VAULT floor wants: depth-scaled mobs are
 * still a real threat (scaleMobHp/Damage handle that on spawn), but the *count*
 * stays a light, non-ramping smash-and-grab — a heat lerp from base to max with
 * NO per-depth population bonus, so a deep vault isn't a wall of bodies. The cost
 * of the detour is the flooded return floor, not a pressure cooker inside. Pure.
 */
export function vaultMobTarget(
  heat: number,
  base: number = VAULT_MOB_BASE,
  max: number = VAULT_MOB_MAX
): number {
  return Math.round(lerp(base, max, clamp01(heat)));
}

/** Seconds between top-up spawns: long when calm, short when hot. */
export function spawnInterval(
  heat: number,
  calm: number = PRESSURE_SPAWN_INTERVAL_CALM,
  hot: number = PRESSURE_SPAWN_INTERVAL_HOT
): number {
  return lerp(calm, hot, clamp01(heat));
}

/**
 * Spawn-lull accumulator (M9). Returns the new "no refills before this time"
 * stamp after a kill: extends the current hold by `perKill`, but never lets the
 * total run past `now + max`. Anchored at `max(current, now)` so a fresh kill
 * after the hold lapsed starts from now (not the stale past stamp), while kills
 * during an active hold stack on top of it — so a burst of simultaneous kills
 * piles up toward the cap and a single straggler adds only a beat. Pure: the room
 * feeds in its running stamp and the current sim time each kill.
 */
export function extendSpawnLull(
  current: number,
  now: number,
  perKill: number = SPAWN_LULL_PER_KILL,
  max: number = SPAWN_LULL_MAX
): number {
  return Math.min(Math.max(current, now) + perKill, now + max);
}

/** Mob max HP scaled for depth (1-based; floor 1 unchanged), rounded to a whole HP. */
export function scaleMobHp(baseHp: number, depth: number, scale: number = DEPTH_HP_SCALE): number {
  return Math.round(baseHp * (1 + scale * (depth - 1)));
}

/** Mob contact damage scaled for depth (1-based; floor 1 unchanged). */
export function scaleMobDamage(baseDmg: number, depth: number, scale: number = DEPTH_DAMAGE_SCALE): number {
  return baseDmg * (1 + scale * (depth - 1));
}

// --- Scoring -----------------------------------------------------------
// Kills and loot score at a live multiplier that climbs with the floor's heat,
// so dwelling (which floods the floor with targets) mints points fast; descending
// banks the haul and drops the multiplier back to 1. All pure — the room feeds in
// the current heat/depth/rarity, so the curve is unit-testable without a clock.

/** Score multiplier from floor heat: ×1 calm → ×maxMult at full heat, clamped. */
export function scoreMultiplier(heat: number, maxMult: number = SCORE_MULT_MAX): number {
  return lerp(1, maxMult, clamp01(heat));
}

/** Base points for killing a mob (before the heat multiplier); deeper = worth more. */
export function killScore(
  depth: number,
  base: number = SCORE_PER_KILL,
  scale: number = SCORE_DEPTH_SCALE
): number {
  return base * (1 + scale * (depth - 1));
}

/** Base points a picked-up drop is worth by rarity (before the heat multiplier). */
export function lootScore(rarity: string, table: Record<string, number> = LOOT_SCORE): number {
  return table[rarity] ?? table.common;
}

/** The per-descend depth bonus, banked on each descent — deeper descents pay more. */
export function depthScore(depth: number, base: number = SCORE_DEPTH_BONUS): number {
  return base * depth;
}

// --- Vault chest (M4) --------------------------------------------------
// The vault's pre-multiplier mega-reward, a dead-end "nook" finder for placing it,
// and the procedural relic namer. All pure: the room feeds in the grid/depth/RNG
// and applies the heat multiplier + reward split itself.

/** Base mega-points a cracked chest is worth (before the heat multiplier); deeper = grander. */
export function chestPoints(depth: number, base: number = CHEST_BASE_POINTS): number {
  return base * depth;
}

export interface Vec {
  x: number;
  y: number;
}

/**
 * Roll a procedurally-named relic for the chest opener — flavor only. Picks a
 * rarity (weighted, with the floor raised by depth so deep chests can't hand out
 * the lowest tier), then builds `${adjective} ${noun}` from that tier's pools,
 * plus " of the ${suffix}" for the grander tiers. Deterministic for a given rng +
 * depth. With rng=0 you get the floor tier + first words; rng→1 the top tier +
 * last words.
 */
export function rollRelic(rng: Rng = Math.random, depth: number = 1): string {
  // Depth raises the lowest tier a relic can roll (the rarity "floor").
  const floor = Math.min(
    RELIC_RARITIES.length - 1,
    Math.floor(Math.max(0, depth - 1) / RELIC_DEPTH_STEP)
  );
  const pool = RELIC_RARITIES.slice(floor);
  const total = pool.reduce((sum, r) => sum + r.weight, 0);
  const rarity = rollWeighted(pool, total, rng);
  const tier = RELIC_RARITIES.findIndex((r) => r.name === rarity.name);

  const pick = <T>(list: T[]): T => list[Math.min(list.length - 1, Math.floor(rng() * list.length))];
  const adj = pick(RELIC_ADJECTIVES[rarity.name]);
  const noun = pick(RELIC_NOUNS[rarity.name]);
  let name = `${adj} ${noun}`;
  if (tier >= RELIC_SUFFIX_MIN_TIER) name += ` of the ${pick(RELIC_SUFFIXES)}`;
  return name;
}

// --- Strange stairway / vault detour (special floors) ------------------
// Pure helpers for the goldvault strange-stairway feature: the gather-to-enter
// quorum, the vault reward chest's jackpot, and its unique trophy. See
// docs/special-floors-plan.md and DungeonRoom's updateStairway / openChest.

/**
 * How many players must gather in the stairway zone to start the entry countdown:
 * "all but one" of the living party — max(1, living - 1). Holdout-proof (a lone
 * AFK/dead/refusing player can never block the vault, since they're the "one" left
 * out), while a real group still has to converge (4 living → 3 must gather). Solo
 * and duo are trivially met. Pure; the room feeds in the living-player count.
 */
export function stairwayQuorum(livingCount: number): number {
  return Math.max(1, livingCount - 1);
}

/** Base jackpot a vault reward chest pays the party (before the heat multiplier); deeper = grander. */
export function vaultChestPoints(depth: number, base: number = VAULT_CHEST_POINTS): number {
  return base * depth;
}

/**
 * Roll a unique gilded trophy for the vault-chest opener from the hand-picked
 * goldvault pool (distinct from the procedural M4 relic names) — score-screen
 * flavor only, like a relic. Deterministic for a given rng.
 */
export function rollVaultRelic(rng: Rng = Math.random, pool: readonly string[] = VAULT_RELICS): string {
  return pool[Math.min(pool.length - 1, Math.floor(rng() * pool.length))];
}
