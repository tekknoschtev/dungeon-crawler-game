import { Schema, MapSchema, type } from "@colyseus/schema";

/**
 * A single player's networked state.
 * Only the fields decorated with @type() are synchronized to clients.
 * Movement input + combat timers are NOT here — they live server-side only
 * (see DungeonRoom). Dead = hp <= 0.
 */
export class Player extends Schema {
  @type("string") name: string = "";
  @type("string") color: string = "#ffffff";
  // Tiny Dungeon sheet frame index for this hero's body (picked in the lobby,
  // tinted by `color`). Validated against an allowlist server-side; see
  // HERO_SPRITES in DungeonRoom.
  @type("uint8") sprite: number = 96;
  @type("number") x: number = 0;
  @type("number") y: number = 0;
  @type("number") hp: number = 100;
  @type("number") maxHp: number = 100;
  // Usable loot. healCharges = number of carried heal potions (stackable, quaffed
  // on demand). attackBuff/defenseBuff are seconds remaining on the instant
  // pickup buffs (> 0 = active); they drive the HUD + hero feedback.
  @type("number") healCharges: number = 0;
  @type("number") attackBuff: number = 0;
  @type("number") defenseBuff: number = 0;
  // Name of the weapon backing the active attack buff (see WEAPONS in tuning.ts),
  // so the HUD can show the actual weapon's icon. "" while unarmed.
  @type("string") weapon: string = "";
}

/** A server-driven enemy. Position is simulated and synced every tick. */
export class Mob extends Schema {
  @type("number") x: number = 0;
  @type("number") y: number = 0;
  @type("number") hp: number = 30;
  @type("number") maxHp: number = 30;
  @type("string") kind: string = "slime";
  // Bumped once each time the mob lands a hit (wraps at 256). Clients watch for
  // the change to fire a one-shot strike animation — cheaper than a ticking
  // timer, which would re-encode every tick for every attacking mob.
  @type("uint8") attackTick: number = 0;
}

/** A loot drop sitting on the floor until a player walks over it. */
export class Loot extends Schema {
  @type("number") x: number = 0;
  @type("number") y: number = 0;
  @type("string") rarity: string = "common"; // scales the effect's strength (and the floor-glow color)
  @type("string") category: string = "heal"; // "heal" | "attack" | "defense"
  // For an "attack" drop, which weapon it is (see WEAPONS in tuning.ts) — the
  // client renders the matching sprite. Empty for heal/defense drops.
  @type("string") variant: string = "";
}

/**
 * A tombstone left where a hero died, tinted to that hero's color. Decorative
 * (not collidable), but server-owned so late-joiners see markers laid down
 * before they arrived. Capped + culled oldest-first (see MAX_DEATH_MARKERS).
 */
export class DeathMarker extends Schema {
  @type("number") x: number = 0;
  @type("number") y: number = 0;
  @type("string") color: string = "#ffffff"; // the fallen hero's color
}

/**
 * The full room state. Players, mobs, loot, and death markers, plus the dungeon
 * seed + code.
 *
 * The seed is the single source of truth for this room's layout; the code is the
 * shareable join identifier (see DungeonRoom). Mobs, loot, and markers are
 * dynamic — driven by the server simulation, not the seed.
 */
export class DungeonState extends Schema {
  @type("number") seed: number = 0;
  @type("string") code: string = "";
  @type({ map: Player }) players = new MapSchema<Player>();
  @type({ map: Mob }) mobs = new MapSchema<Mob>();
  @type({ map: Loot }) loot = new MapSchema<Loot>();
  @type({ map: DeathMarker }) markers = new MapSchema<DeathMarker>();
}
