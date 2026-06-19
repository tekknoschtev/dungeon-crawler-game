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
  @type("string") rarity: string = "common"; // scales the effect's strength
  @type("string") category: string = "heal"; // "heal" | "attack" | "defense"
}

/**
 * The full room state. Players, mobs, and loot, plus the dungeon seed + code.
 *
 * The seed is the single source of truth for this room's layout; the code is the
 * shareable join identifier (see DungeonRoom). Mobs and loot are dynamic — driven
 * by the server simulation, not the seed.
 */
export class DungeonState extends Schema {
  @type("number") seed: number = 0;
  @type("string") code: string = "";
  @type({ map: Player }) players = new MapSchema<Player>();
  @type({ map: Mob }) mobs = new MapSchema<Mob>();
  @type({ map: Loot }) loot = new MapSchema<Loot>();
}
