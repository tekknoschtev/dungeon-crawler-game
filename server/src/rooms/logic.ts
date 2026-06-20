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
  rarityByName,
  type Rarity,
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

// --- Loot application --------------------------------------------------

/** The slice of a Player that loot mutates (Player satisfies this structurally). */
export interface LootTarget {
  attackBuff: number;
  defenseBuff: number;
  healCharges: number;
}

/** The slice of per-player Combat state loot scales (never synced to clients). */
export interface LootBuffs {
  attackMult: number;
  defenseReduce: number;
}

export interface LootDrop {
  rarity: string;
  category: string; // "heal" | "attack" | "defense"
}

/**
 * Apply a walked-over drop: instant buff (attack/defense) or a banked heal.
 * Mutates `target`/`buffs` in place. Returns false if the drop should be LEFT on
 * the floor — a heal when the stack is already full — so it stays available for
 * later or for a teammate.
 */
export function applyLootEffect(target: LootTarget, buffs: LootBuffs, loot: LootDrop): boolean {
  const r = rarityByName(loot.rarity);
  if (loot.category === "attack") {
    target.attackBuff = BUFF_DURATION; // refresh
    buffs.attackMult = Math.max(buffs.attackMult, r.attackMult); // never downgrade an active buff
    return true;
  }
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

/** Damage a mob hit deals to a player after an active defense buff soaks some. */
export function mobDamageAfterDefense(defenseBuffActive: boolean, defenseReduce: number): number {
  return MOB_DAMAGE * (1 - (defenseBuffActive ? defenseReduce : 0));
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
