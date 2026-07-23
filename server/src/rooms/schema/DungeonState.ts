import { Schema, MapSchema, ArraySchema, type } from "@colyseus/schema";

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
  // Carried bombs (M10): stockpiled like heal potions, placed with the E key /
  // contextual mobile button. Capped (see MAX_BOMBS). Drives the HUD bomb chip.
  @type("uint8") bombs: number = 0;
  @type("number") attackBuff: number = 0;
  @type("number") defenseBuff: number = 0;
  // Name of the weapon backing the active attack buff (see WEAPONS in tuning.ts),
  // so the HUD can show the actual weapon's icon. "" while unarmed.
  @type("string") weapon: string = "";
  // --- Run stakes (M2) ---
  // hp<=0 and awaiting self-respawn or a teammate's revive. The client renders a
  // downed hero greyed/prone and shows the local "You're down" overlay.
  @type("boolean") downed: boolean = false;
  // Lives remaining this run (HUD "♥×N"). 0 = revive-only (no self-respawn button).
  // Start below the cap; +1 each descent (see DungeonRoom).
  @type("uint8") respawnsLeft: number = 0;
  // Seconds until the self-respawn button unlocks; only nonzero while downed with
  // lives left (same per-tick countdown pattern as attackBuff). 0 = ready / N/A.
  @type("number") respawnIn: number = 0;
  // --- Scoring (M3) ---
  // Live run score = banked floors + the current floor's un-banked gain. Churns
  // only on discrete events (a kill, a pickup, a descend), never per-tick. The
  // current floor's gain is forfeited on a wipe; descending banks it (see
  // DungeonRoom). The HUD + score screen read this directly.
  @type("number") score: number = 0;
  // --- Relics (M4) ---
  // Procedurally-named flavor trophies this hero has unsealed from vault chests
  // (one per chest they open). Never held or used — score-screen flavor only.
  // Churns only on an open (rare); persists across floors, cleared on restart.
  @type(["string"]) relics = new ArraySchema<string>();
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
  // Frozen by a bomb blast (M10): no movement or attacks while true. Synced so
  // clients can tint stunned mobs; the server owns the timer (see MobAI). Toggled
  // only on the transition, not per-tick, to keep it off the wire when unchanged.
  @type("boolean") stunned: boolean = false;
}

/**
 * A placed, ticking bomb (M10). Lives on the floor for a short fuse, then the
 * server detonates it (local blast + map-wide mob stun) and removes it — the
 * client plays the explosion on onRemove. `fuse` is synced so the client can
 * accelerate its warning flash as detonation nears.
 */
export class Bomb extends Schema {
  @type("number") x: number = 0; // pixel center
  @type("number") y: number = 0;
  @type("number") fuse: number = 0; // seconds remaining until it blows
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
 * A breakable prop (crate, barrel, keg) on the floor. Server-owned so clients
 * see it disappear when destroyed and late-joiners don't see already-broken ones.
 * hp ticks down as players hit it; reaching 0 triggers a drop + possible key.
 */
export class Crate extends Schema {
  @type("number") x: number = 0; // pixel center
  @type("number") y: number = 0;
  @type("uint8") frame: number = 0; // Tiny Dungeon sheet index
  @type("number") hp: number = 2;
  @type("number") maxHp: number = 2;
}

/**
 * The per-floor vault chest (M4): visible from arrival, sealed behind a timed
 * door that opens once the floor's heat is spicy, then cracked open by attacking
 * it. One per floor (a `chests` MapSchema with a single entry, reusing the
 * onAdd/onRemove render pattern). Re-armed each descent; cleared on the old floor.
 */
export class Chest extends Schema {
  @type("number") x: number = 0; // chest render position (px)
  @type("number") y: number = 0;
  // The sealing door's TILE coords, or (-1,-1) for the magic-seal fallback (no
  // physical door tile — the client shows a shimmer/lock instead of a gate).
  @type("int16") doorX: number = -1;
  @type("int16") doorY: number = -1;
  // Door shut + chest impervious. Flips false when unlockIn hits 0 (the door
  // tile, if any, becomes passable then too).
  @type("boolean") locked: boolean = true;
  // Seconds until the door opens (ticks down while locked, like respawnIn; 0 once
  // open). Drives the client's anticipation countdown.
  @type("number") unlockIn: number = 0;
  // Break progress once unlocked — churns only while being hit. hp<=0 → opened.
  // (Tuned low — see CHEST_HP — so a single swing cracks it; the server sets the
  // real value in placeVault.)
  @type("number") hp: number = 1;
  @type("number") maxHp: number = 1;
}

/**
 * The full room state. Players, mobs, loot, death markers, and the per-floor
 * vault chest, plus the dungeon seed + code.
 *
 * The seed is the single source of truth for this room's layout; the code is the
 * shareable join identifier (see DungeonRoom). Mobs, loot, and markers are
 * dynamic — driven by the server simulation, not the seed.
 */
export class DungeonState extends Schema {
  @type("number") seed: number = 0;
  @type("string") code: string = "";
  // Current floor (1-based). Drives depth scaling + the HUD; bumped on descend.
  @type("uint8") depth: number = 1;
  // Per-floor pressure ramp surfaced to the HUD, 0 (just arrived) → 1 (max heat).
  // Derived each tick from time-on-floor; resets to 0 on descend.
  @type("number") heat: number = 0;
  // Run phase: "playing" | "gameover". Flips to "gameover" on a party wipe with no
  // lives left (drives the game-over overlay); "restart" rolls a fresh run.
  @type("string") phase: string = "playing";
  // --- Strange stairway (special floors) ---
  // Gather-to-enter state for this floor's strange stairway (the goldvault
  // detour). The stairway's POSITION is static per floor and rides the one-shot
  // "map" message like the exit — only this handful of dynamic values is synced,
  // and only while a party is actually gathering. All 0 on floors without one.
  // Living heroes currently standing in the gather zone.
  @type("uint8") stairwayCount: number = 0;
  // How many of them it takes to start the countdown ("all but one" — see
  // stairwayQuorum). 0 when this floor has no stairway.
  @type("uint8") stairwayNeed: number = 0;
  // Seconds left on the entry countdown once quorum is standing; ticks down like
  // respawnIn/unlockIn, and snaps back to 0 the moment quorum breaks. 0 = idle.
  @type("number") stairwayIn: number = 0;
  @type({ map: Player }) players = new MapSchema<Player>();
  @type({ map: Mob }) mobs = new MapSchema<Mob>();
  @type({ map: Loot }) loot = new MapSchema<Loot>();
  @type({ map: DeathMarker }) markers = new MapSchema<DeathMarker>();
  // The per-floor vault chest — a single-entry map (one vault per floor), reusing
  // the existing onAdd/onRemove render path. Cleared + re-armed each descent.
  @type({ map: Chest }) chests = new MapSchema<Chest>();
  // Breakable props (crates, barrels, kegs) — synced so destruction is
  // authoritative and late-joiners don't see already-broken ones.
  @type({ map: Crate }) crates = new MapSchema<Crate>();
  // Placed, ticking bombs (M10) — usually empty; a handful at most while fuses run.
  @type({ map: Bomb }) bombs = new MapSchema<Bomb>();
}
