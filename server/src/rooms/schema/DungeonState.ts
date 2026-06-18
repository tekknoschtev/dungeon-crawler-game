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
 * The full room state. Players, the dungeon seed, and the shareable join code.
 *
 * The seed is the single source of truth for this room's layout: the server
 * generates the grid from it on create and ships the resolved grid to clients.
 *
 * The code is the friendly 4-char identifier players share to join this exact
 * room (see DungeonRoom.onCreate). It's synced so clients can show it + build a
 * share link. Later milestones will add mobs, loot, doors, etc. here.
 */
export class DungeonState extends Schema {
  @type("number") seed: number = 0;
  @type("string") code: string = "";
  @type({ map: Player }) players = new MapSchema<Player>();
}
