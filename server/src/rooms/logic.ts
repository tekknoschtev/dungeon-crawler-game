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
  PASSIVE_REGEN,
  RARITIES,
  RARITY_TOTAL,
  CATEGORIES,
  CATEGORY_TOTAL,
  WEAPONS,
  WEAPON_TOTAL,
  rarityByName,
  weaponByName,
  PRESSURE_RAMP_TIME,
  PRESSURE_BASE_TARGET,
  PRESSURE_MAX_TARGET,
  PRESSURE_SPAWN_INTERVAL_CALM,
  PRESSURE_SPAWN_INTERVAL_HOT,
  PRESSURE_TARGET_HARD_CAP,
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
  RELIC_RARITIES,
  RELIC_ADJECTIVES,
  RELIC_NOUNS,
  RELIC_SUFFIXES,
  RELIC_DEPTH_STEP,
  RELIC_SUFFIX_MIN_TIER,
  type Rarity,
  type Weapon,
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

// --- Loot application --------------------------------------------------

/** The slice of a Player that loot mutates (Player satisfies this structurally). */
export interface LootTarget {
  attackBuff: number;
  defenseBuff: number;
  healCharges: number;
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

/** Seconds between top-up spawns: long when calm, short when hot. */
export function spawnInterval(
  heat: number,
  calm: number = PRESSURE_SPAWN_INTERVAL_CALM,
  hot: number = PRESSURE_SPAWN_INTERVAL_HOT
): number {
  return lerp(calm, hot, clamp01(heat));
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
