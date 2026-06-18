import { Schema, MapSchema, type } from "@colyseus/schema";

/**
 * A single player's networked state.
 * Only the fields decorated with @type() are synchronized to clients.
 * Movement input is NOT stored here — it lives server-side only (see DungeonRoom).
 */
export class Player extends Schema {
  @type("string") name: string = "";
  @type("string") color: string = "#ffffff";
  @type("number") x: number = 0;
  @type("number") y: number = 0;
}

/**
 * The full room state. Players plus the dungeon seed.
 *
 * The seed is the single source of truth for this room's layout: the server
 * generates the grid from it on create and ships the resolved grid to clients.
 * Syncing the seed (cheap — one number) is a forward-compat hook for a future
 * create/join-by-code lobby (M3) where the seed identifies the dungeon.
 * Later milestones will add mobs, loot, doors, etc. here.
 */
export class DungeonState extends Schema {
  @type("number") seed: number = 0;
  @type({ map: Player }) players = new MapSchema<Player>();
}
