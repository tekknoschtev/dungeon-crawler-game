import { Room, Client, matchMaker } from "colyseus";
import { DungeonState, Player, Mob, Loot, DeathMarker, Chest, Crate, Bomb } from "./schema/DungeonState";
import { loadMap, LoadedMap, TILE } from "./map";
import {
  PLAYER_SPEED,
  PLAYER_RADIUS,
  PLAYER_MAX_HP,
  PLAYER_ATTACK_RANGE,
  PLAYER_ATTACK_COOLDOWN,
  STARTING_LIVES,
  LIFE_CAP,
  REVIVE_RANGE,
  REVIVE_HP_PCT,
  MOB_RADIUS,
  MOB_ATTACK_COOLDOWN,
  MOB_ATTACK_RANGE,
  mobByName,
  PICKUP_RANGE,
  HEAL_PCT,
  MAX_DEATH_MARKERS,
  EXIT_RADIUS,
  DESCEND_CHANNEL_TIME,
  DESCEND_FADE_MS,
  EXIT_PULSE_RADIUS,
  EXIT_PULSE_INTERVAL,
  EXIT_PULSE_KNOCKBACK,
  EXIT_PULSE_STAGGER,
  CHEST_UNLOCK_TIME,
  CHEST_HP,
  CHEST_RADIUS,
  CHEST_BUFF_DURATION,
  CRATE_HP,
  CRATE_RADIUS,
  CRATE_SCORE_BONUS,
  CRATE_POTION_CHANCE,
  BOMB_FUSE,
  BOMB_BLAST_RADIUS,
  BOMB_BLAST_DAMAGE,
  BOMB_KNOCKBACK,
  BOMB_STUN,
} from "./tuning";
import {
  dist,
  normalize,
  collides as tileCollides,
  rollRarity,
  rollCategory,
  rollWeapon,
  rollMobKind,
  applyLootEffect,
  applyKnockback,
  playerAttackDamage,
  mobDamageAfterDefense,
  regenHp,
  isAllowedColor,
  isAllowedSprite,
  pickAggroTarget,
  respawnDelay,
  isWipe,
  scoreMultiplier,
  killScore,
  lootScore,
  depthScore,
  heatLevel,
  targetMobCount,
  spawnInterval,
  scaleMobHp,
  scaleMobDamage,
  extendSpawnLull,
  crateBombChance,
  chestPoints,
  rollRelic,
  type AggroCandidate,
  type Vec,
} from "./logic";
import {
  COLORS,
  SELECTABLE_COLORS,
  HERO_SPRITES,
  DEFAULT_HERO_SPRITE,
} from "./heroAppearance";

// Friendly join codes: 4 chars, no ambiguous glyphs (0/O, 1/I/L). Short enough
// to read aloud or type on a phone; ~707k combinations is plenty for the handful
// of rooms ever live at once.
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_LEN = 4;
const CODE_RE = new RegExp(`^[${CODE_ALPHABET}]{${CODE_LEN}}$`);

// The single vault chest per floor lives in the `chests` MapSchema under this
// fixed id (one entry), reusing the map onAdd/onRemove render path on the client.
const VAULT_ID = "vault";

function randomCode(): string {
  let out = "";
  for (let i = 0; i < CODE_LEN; i++) {
    out += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  }
  return out;
}

/** A code not currently used by another live "dungeon" room. */
async function uniqueCode(): Promise<string> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const code = randomCode();
    const taken = await matchMaker.query({ name: "dungeon", code });
    if (taken.length === 0) return code;
  }
  // Astronomically unlikely to land here; fall back to a longer-tail candidate.
  return randomCode();
}

/** Per-player input held server-side only (never trusted blindly). */
interface InputState {
  up: boolean;
  down: boolean;
  left: boolean;
  right: boolean;
}

/** Per-player combat state (server-only; not synced). */
interface Combat {
  attackReadyAt: number;
  // Sim time the self-respawn button unlocks; set when a hero goes down, drives
  // Player.respawnIn. Meaningless while up.
  respawnReadyAt: number;
  // How many times this hero has self-respawned this run — indexes the ramping
  // respawn delay (revives don't count). Reset on restart.
  respawnsUsed: number;
  // Snapshot of Player.score at the last descend. The current floor's un-banked
  // gain is `score - bankedScore`: descending banks it (banked = score), a wipe
  // forfeits it (score = banked). See checkWipe / updateDescent.
  bankedScore: number;
  attackMult: number; // active attack-buff damage multiplier (1 = none)
  defenseReduce: number; // active defense-buff damage reduction 0..1 (0 = none)
  knockback: number; // px a hit mob is shoved by the equipped weapon (0 = none)
}

/** Per-mob AI state (server-only; not synced). */
interface MobAI {
  attackReadyAt: number;
  nextWanderAt: number;
  wanderDx: number;
  wanderDy: number;
  // Sim time a bomb stun wears off (M10); while now < this the mob is frozen.
  stunnedUntil: number;
}

// Hero appearance (colors + body sprites) lives in ./heroAppearance — the
// canonical, server-authoritative lists, imported above and shared with the
// client lobby so the two can't drift.

export class DungeonRoom extends Room<{ state: DungeonState }> {
  maxClients = 4;
  autoDispose = false; // managed manually so grace-period reconnects keep the room alive

  private map!: LoadedMap;
  // Collision grid = map.grid plus prop tiles marked solid. Kept separate from
  // map.grid (which the client renders as walls) so props collide without
  // drawing as bricks — the client draws the prop sprite over open floor.
  private collision!: number[][];
  private inputs = new Map<string, InputState>();
  private combat = new Map<string, Combat>();
  private mobAI = new Map<string, MobAI>();
  private floors: { x: number; y: number }[] = []; // floor tile coords (for spawns)
  private colorIndex = 0;
  private mobSeq = 0;
  private lootSeq = 0;
  private crateSeq = 0;
  private bombSeq = 0;
  // Server-only: placed-bomb id → the player who placed it, so detonation kills
  // credit the right hero (score + M9 lull). Cleared per floor with the bombs map.
  private bombOwners = new Map<string, string>();
  private markerSeq = 0;
  // Server-only crate tile positions (for removing from collision on break).
  private cratePositions = new Map<string, { tx: number; ty: number }>();
  // ID of the one crate on this floor that holds the vault key, or null.
  private keyCrateId: string | null = null;
  private markerIds: string[] = []; // death-marker ids in insertion order (for culling)
  private now = 0; // accumulated simulation time in seconds
  private nextMobSpawnAt = 0;
  // Spawn-lull stamp (M9): the pressure spawner holds off refilling until sim time
  // passes this. Each mob kill pushes it out (see killMob / extendSpawnLull), so
  // routing a cluster buys quiet. Reset per floor.
  private spawnSuppressedUntil = 0;
  private baseSeed = 0; // room seed; each floor derives its layout from this + depth
  private floorStartAt = 0; // sim time the current floor began (drives the pressure ramp)
  private descendProgress = 0; // s a hero has held the exit toward the descend channel
  private nextExitPulseAt = 0; // sim time the next exit ward-pulse may fire (M11)
  private descending = false; // true during the fade-out window before the floor swaps
  // TILE coords of the current floor's vault chest, so mob/loot spawns stay off
  // it. The door tile (when there is one) is sealed in `collision`, so it's
  // excluded from spawns automatically; null between placements.
  private vaultChestTile: Vec | null = null;

  async onCreate(options: { code?: string } = {}) {
    this.state = new DungeonState();

    // Shareable join code. Honor a valid client-supplied code (lets a host pick
    // one); otherwise mint a unique one. filterBy(["code"]) in index.ts routes
    // `client.join("dungeon", { code })` to the room created with that code.
    const code =
      options.code && CODE_RE.test(options.code) ? options.code : await uniqueCode();
    this.state.code = code;
    this.setMetadata({ code });

    // One random base seed per room; each floor's layout derives from it + depth
    // (see enterFloor), so the dungeon is reproducible and (later) shareable by code.
    this.baseSeed = (Math.random() * 0x100000000) >>> 0;
    this.enterFloor(1);

    // Receive movement intent from a client. We sanitize to plain booleans so a
    // malicious client can't smuggle anything weird into the simulation.
    this.onMessage("input", (client, message: Partial<InputState>) => {
      const input = this.inputs.get(client.sessionId);
      if (!input) return;
      input.up = !!message.up;
      input.down = !!message.down;
      input.left = !!message.left;
      input.right = !!message.right;
    });

    // Melee attack: an omnidirectional swing that hits any mob in range. Gated
    // by a per-player cooldown so a spammy client gains nothing.
    this.onMessage("attack", (client) => this.handleAttack(client.sessionId));

    // Quaff the carried heal potion — or, near a downed ally, spend it to revive them.
    this.onMessage("useHeal", (client) => this.handleUseHeal(client.sessionId));

    // Place a carried bomb at the hero's feet (M10).
    this.onMessage("useBomb", (client) => this.handleUseBomb(client.sessionId));

    // Spend a life to self-respawn once the downed cooldown has unlocked.
    this.onMessage("respawn", (client) => this.handleRespawn(client.sessionId));

    // Anyone can roll a fresh run from the game-over screen.
    this.onMessage("restart", () => this.handleRestart());

    // The client requests the map once its renderer is ready (handlers wired),
    // rather than us pushing it in onJoin — that one-time payload would otherwise
    // be missed while the client finishes booting (loading art, etc.). On descend
    // the server broadcasts a fresh "map" to everyone (see enterFloor).
    this.onMessage("ready", (client) => client.send("map", this.mapPayload()));

    // Fixed-step authoritative simulation. The callback receives delta in ms.
    this.setSimulationInterval((deltaMs) => this.update(deltaMs));

    console.log(`DungeonRoom created: ${this.roomId} (code ${code})`);
  }

  onJoin(client: Client, options: { name?: string; color?: string; sprite?: number } = {}) {
    const player = new Player();
    const spawn = this.map.spawns[this.clients.length % this.map.spawns.length];
    player.x = spawn.x;
    player.y = spawn.y;
    player.hp = PLAYER_MAX_HP;
    player.maxHp = PLAYER_MAX_HP;
    // Honor the lobby's color pick if it's a known one; otherwise hand out the
    // next round-robin color (advancing the cursor only when we actually use it).
    if (isAllowedColor(options.color, SELECTABLE_COLORS)) {
      player.color = options.color!;
    } else {
      player.color = COLORS[this.colorIndex % COLORS.length];
      this.colorIndex++;
    }
    // Honor the lobby's hero-body pick if it's a known frame; otherwise the
    // default knight. (No round-robin here — the color already varies the look.)
    player.sprite = isAllowedSprite(options.sprite, HERO_SPRITES)
      ? options.sprite!
      : DEFAULT_HERO_SPRITE;
    player.name = (options.name && options.name.trim().slice(0, 16)) || `Hero ${this.clients.length}`;
    // Fresh life pool. A late joiner gets a full STARTING_LIVES (their own run
    // resource); the +1/descent bonus accrues from here on (see updateDescent).
    player.respawnsLeft = STARTING_LIVES;

    this.state.players.set(client.sessionId, player);
    this.inputs.set(client.sessionId, { up: false, down: false, left: false, right: false });
    this.combat.set(client.sessionId, { attackReadyAt: 0, respawnReadyAt: 0, respawnsUsed: 0, bankedScore: 0, attackMult: 1, defenseReduce: 0, knockback: 0 });

    // The map is sent when the client signals "ready" (see onCreate), not here.
    console.log(`${player.name} joined (${client.sessionId}). Players: ${this.clients.length}`);
  }

  async onLeave(client: Client, code?: number) {
    // code 4000 = intentional room.leave(); anything else is an unexpected drop
    if (code !== 4000) {
      try {
        await this.allowReconnection(client, 30);
        return; // reconnected successfully — player state is still intact
      } catch {
        // grace period expired
      }
    }
    this.state.players.delete(client.sessionId);
    this.inputs.delete(client.sessionId);
    this.combat.delete(client.sessionId);
    console.log(`Left: ${client.sessionId}. Players: ${this.state.players.size}`);
    if (this.state.players.size === 0) void this.disconnect();
  }

  // --- Floors ------------------------------------------------------------

  /**
   * (Re)generate and enter floor `depth`. Used for the initial floor and every
   * descent: loads a fresh layout (deterministic from baseSeed + depth), rebuilds
   * collision + the walkable-tile cache, clears the old floor's mobs/loot, resets
   * the pressure ramp, repositions any players to the new spawns, seeds the calm
   * starting population, and broadcasts the new map to clients.
   */
  private enterFloor(depth: number) {
    this.state.depth = depth;
    // Mix baseSeed with depth so each floor has its own reproducible layout.
    const seed = (this.baseSeed ^ Math.imul(depth, 0x9e3779b1)) >>> 0;
    this.state.seed = seed;
    this.map = loadMap(seed);
    console.log(`Floor ${depth} — preset: ${this.map.preset} (seed ${seed})`);

    // Bake props into a collision-only grid (walls + prop tiles solid, including
    // breakable ones — they start solid and are removed from collision on break).
    this.collision = this.map.grid.map((row) => row.slice());
    for (const p of this.map.props) this.collision[p.y][p.x] = 1;

    // Arm a fresh vault: seals its door tile in `collision` (so the chamber is
    // unreachable below) and records the chest tile to keep mobs/loot off it.
    this.state.chests.clear();
    this.placeVault(depth);

    // Populate breakable crates as synced entities (not in the static map payload).
    this.state.crates.clear();
    this.cratePositions.clear();
    this.keyCrateId = null;
    for (const p of this.map.props) {
      if (!p.breakable) continue;
      const crate = new Crate();
      crate.x = p.x * TILE + TILE / 2;
      crate.y = p.y * TILE + TILE / 2;
      crate.frame = p.frame;
      crate.hp = CRATE_HP;
      crate.maxHp = CRATE_HP;
      const id = `c${this.crateSeq++}`;
      this.state.crates.set(id, crate);
      this.cratePositions.set(id, { tx: p.x, ty: p.y });
    }
    // Every floor hides the vault key in one random crate.
    if (this.state.crates.size > 0) {
      const idx = Math.floor(Math.random() * this.state.crates.size);
      let i = 0;
      this.state.crates.forEach((_, id) => {
        if (i++ === idx) this.keyCrateId = id;
      });
    }

    // Cache walkable tiles for mob/loot spawns: every floor tile reachable from a
    // spawn (so the sealed vault chamber, behind the locked door, never spawns a
    // trapped mob), minus the chest tile (covers the door-less magic-seal fallback,
    // whose chest sits on an otherwise-reachable tile).
    this.floors = this.reachableFloorTiles();

    // Fresh floor: drop the previous floor's mobs, loot, and death markers (whose
    // coords are meaningless on the new layout), and reset the ramp.
    this.state.mobs.clear();
    this.mobAI.clear();
    this.state.loot.clear();
    this.state.bombs.clear();
    this.bombOwners.clear();
    this.state.markers.clear();
    this.markerIds = [];
    this.floorStartAt = this.now;
    this.nextMobSpawnAt = this.now;
    this.spawnSuppressedUntil = this.now; // no carried-over lull on a fresh floor
    this.descendProgress = 0;
    this.state.heat = 0;

    // Move everyone to the new spawns (a no-op on the very first floor — players
    // join afterwards). HP/buffs carry across; the pressure reset is the relief.
    let i = 0;
    this.state.players.forEach((player) => {
      const spawn = this.map.spawns[i % this.map.spawns.length];
      player.x = spawn.x;
      player.y = spawn.y;
      i++;
    });

    // Seed the calm starting population so the floor isn't empty on arrival.
    const target = targetMobCount(0, depth);
    for (let n = 0; n < target; n++) this.spawnMob();

    // Push the new geometry to everyone (no-op when no one's connected yet).
    this.broadcast("map", this.mapPayload());
  }

  // --- Vault chest (M4) --------------------------------------------------

  /**
   * Place this floor's vault: a sealed chest the party can see from arrival but
   * can't crack until the floor's heat has built. Uses the generator's carved
   * chamber (a real room behind a single door tile, sealed in `collision` while
   * locked); when the layout couldn't fit a chamber, falls back to a magic-sealed
   * open tile far from spawns/exit so the feature always appears. Records the
   * chest tile so spawns stay off it. Sets `this.vaultChestTile`.
   */
  private placeVault(depth: number) {
    const chest = new Chest();
    chest.locked = true;
    chest.unlockIn = CHEST_UNLOCK_TIME;
    chest.hp = CHEST_HP;
    chest.maxHp = CHEST_HP;

    const v = this.map.vault;
    if (v) {
      chest.x = v.chest.x * TILE + TILE / 2;
      chest.y = v.chest.y * TILE + TILE / 2;
      chest.doorX = v.door.x;
      chest.doorY = v.door.y;
      this.collision[v.door.y][v.door.x] = 1; // seal the chamber while locked
      this.vaultChestTile = v.chest;
    } else {
      // No chamber fit this layout: magic-seal an open floor tile (no door) far
      // from spawns/exit. The chest is still impervious until unlock; the client
      // shows a shimmer/lock instead of a gate.
      const avoid: Vec[] = this.map.spawns.map((s) => ({
        x: Math.floor(s.x / TILE),
        y: Math.floor(s.y / TILE),
      }));
      avoid.push({ x: this.map.exit.x, y: this.map.exit.y });
      const tile = this.farthestFloorTile(avoid);
      chest.x = tile.x * TILE + TILE / 2;
      chest.y = tile.y * TILE + TILE / 2;
      chest.doorX = -1;
      chest.doorY = -1;
      this.vaultChestTile = tile;
    }
    this.state.chests.set(VAULT_ID, chest);
  }

  /**
   * Flood-fill from the first spawn over `collision`, returning every reachable
   * floor tile except the vault chest tile. The sealed vault chamber (behind the
   * collision-blocked door) is unreachable, so it's naturally excluded — no mob
   * or loot ever spawns trapped inside the vault.
   */
  private reachableFloorTiles(): { x: number; y: number }[] {
    const w = this.map.width;
    const h = this.map.height;
    const seen = new Uint8Array(w * h);
    const out: { x: number; y: number }[] = [];
    const startSpawn = this.map.spawns[0];
    const sx = startSpawn ? Math.floor(startSpawn.x / TILE) : 1;
    const sy = startSpawn ? Math.floor(startSpawn.y / TILE) : 1;
    const stack: number[] = [sx, sy];
    const chest = this.vaultChestTile;
    while (stack.length) {
      const y = stack.pop()!;
      const x = stack.pop()!;
      if (x < 0 || y < 0 || x >= w || y >= h) continue;
      if (this.collision[y][x] !== 0) continue;
      const idx = y * w + x;
      if (seen[idx]) continue;
      seen[idx] = 1;
      if (!chest || chest.x !== x || chest.y !== y) out.push({ x, y });
      stack.push(x + 1, y, x - 1, y, x, y + 1, x, y - 1);
    }
    return out;
  }

  /** The open floor tile farthest (max nearest-distance) from the avoid points. */
  private farthestFloorTile(avoid: Vec[]): Vec {
    let best: Vec = { x: 1, y: 1 };
    let bestScore = -1;
    for (let y = 0; y < this.map.height; y++) {
      for (let x = 0; x < this.map.width; x++) {
        if (this.collision[y][x] !== 0) continue;
        let score = Infinity;
        for (const a of avoid) {
          const d = (a.x - x) ** 2 + (a.y - y) ** 2;
          if (d < score) score = d;
        }
        if (score > bestScore) {
          bestScore = score;
          best = { x, y };
        }
      }
    }
    return best;
  }

  /**
   * Tick the vault's unlock countdown while it's sealed; when it hits 0 the door
   * opens — flip `locked` and clear the (real) door tile from `collision` so it's
   * passable. The map walls were never changed, so no map re-send is needed.
   */
  private updateChest(dt: number) {
    if (this.state.phase !== "playing") return;
    const chest = this.state.chests.get(VAULT_ID);
    if (!chest || !chest.locked) return;
    chest.unlockIn = Math.max(0, chest.unlockIn - dt);
    if (chest.unlockIn <= 0) {
      chest.locked = false;
      if (chest.doorX >= 0 && chest.doorY >= 0) {
        this.collision[chest.doorY][chest.doorX] = 0; // gate opens → passable
      }
    }
  }

  /**
   * Crack the vault open: the depth-scaled mega-points (riding the heat
   * multiplier, un-banked like all floor score) go to the whole party split
   * evenly; the heal + buff + relic go to the opener who braved it.
   */
  private openChest(openerId: string) {
    const chest = this.state.chests.get(VAULT_ID);
    if (!chest) return;

    // Points → party, split evenly (the party total rises by ~the chest amount).
    // Each share is rounded so scores stay whole on the HUD (the total can differ
    // from `pts` by < n points — immaterial against a depth-scaled jackpot).
    const pts = Math.round(chestPoints(this.state.depth) * scoreMultiplier(this.state.heat));
    const n = this.state.players.size;
    if (n > 0) {
      const each = Math.round(pts / n);
      this.state.players.forEach((p) => {
        p.score += each;
      });
    }

    // Heal + buff + relic → the opener.
    const opener = this.state.players.get(openerId);
    const oc = this.combat.get(openerId);
    if (opener && oc) {
      opener.hp = opener.maxHp; // full heal
      // Reuse the loot machinery for a synthetic top-tier grant (strongest weapon
      // + strongest defense), then stretch both timers to the vault's longer buff.
      applyLootEffect(opener, oc, { rarity: "legendary", category: "attack", variant: "warhammer" });
      applyLootEffect(opener, oc, { rarity: "legendary", category: "defense" });
      opener.attackBuff = Math.max(opener.attackBuff, CHEST_BUFF_DURATION);
      opener.defenseBuff = Math.max(opener.defenseBuff, CHEST_BUFF_DURATION);

      const name = rollRelic(Math.random, this.state.depth);
      opener.relics.push(name);
      this.broadcast("relic", { name, who: opener.name });
    }

    this.state.chests.delete(VAULT_ID); // client onRemove plays the burst
    this.vaultChestTile = null;
  }

  /**
   * Destroy a crate: open the tile in collision, award a score bonus to the
   * breaker, maybe drop a potion, and — if this was the key crate — instantly
   * unlock the vault door so the party can claim the chest early.
   */
  private breakCrate(id: string, crateX: number, crateY: number, breakerId: string) {
    const pos = this.cratePositions.get(id);
    if (pos) {
      this.collision[pos.ty][pos.tx] = 0; // tile is now passable
      this.cratePositions.delete(id);
    }
    this.state.crates.delete(id); // client onRemove plays shatter animation

    // Score bonus to the breaker.
    const breaker = this.state.players.get(breakerId);
    if (breaker) breaker.score += CRATE_SCORE_BONUS;

    // Possible potion drop at the crate's position.
    if (Math.random() < CRATE_POTION_CHANCE) {
      const loot = new Loot();
      loot.x = crateX;
      loot.y = crateY;
      loot.category = "heal";
      loot.rarity = "common";
      loot.variant = "";
      this.state.loot.set(`l${this.lootSeq++}`, loot);
    }

    // Possible bomb drop (M10) — an independent roll, rubber-banded deeper so the
    // comeback tool surfaces more on the floors that need it. Picked up like loot.
    if (Math.random() < crateBombChance(this.state.depth)) {
      const loot = new Loot();
      loot.x = crateX;
      loot.y = crateY;
      loot.category = "bomb";
      loot.rarity = "common";
      loot.variant = "";
      this.state.loot.set(`l${this.lootSeq++}`, loot);
    }

    // Key crate: instantly unlock the vault (same prize as the timed unlock).
    if (id === this.keyCrateId) {
      this.keyCrateId = null;
      const chest = this.state.chests.get(VAULT_ID);
      if (chest && chest.locked) {
        chest.locked = false;
        chest.unlockIn = 0;
        if (chest.doorX >= 0 && chest.doorY >= 0) {
          this.collision[chest.doorY][chest.doorX] = 0; // gate opens
        }
        this.broadcast("key_found", { name: breaker?.name ?? "Someone", x: crateX, y: crateY });
      }
    }
  }

  /** The map payload clients render (geometry + static props + the descent exit).
   *  Breakable props are excluded — they're synced via state.crates instead. */
  private mapPayload() {
    return {
      tile: this.map.tile,
      width: this.map.width,
      height: this.map.height,
      grid: this.map.grid,
      props: this.map.props.filter((p) => !p.breakable),
      exit: this.map.exit,
    };
  }

  /**
   * Descent channel: while any living hero stands on the exit, charge a short
   * timer; when it fills, the whole party drops to the next floor. Stepping off
   * cancels it. Co-op-friendly — anyone can initiate, nobody has to clear first.
   */
  private updateDescent(dt: number) {
    if (this.state.phase !== "playing") return; // run's over; no descending
    if (this.descending) return; // mid fade-out; the floor swap is already scheduled
    const ex = this.map.exit.x * TILE + TILE / 2;
    const ey = this.map.exit.y * TILE + TILE / 2;
    let onExit = false;
    this.state.players.forEach((p) => {
      if (p.hp > 0 && dist(p.x, p.y, ex, ey) <= EXIT_RADIUS) onExit = true;
    });
    if (!onExit) {
      this.descendProgress = 0;
      return;
    }

    // Ward the stairs (M11): pulse the moment channeling begins, then on an
    // interval while it holds — shoving + staggering nearby mobs so the channel
    // can survive under fire. descendProgress is exactly 0 only on the first tick.
    if (this.descendProgress === 0 || this.now >= this.nextExitPulseAt) {
      this.exitPulse(ex, ey);
      this.nextExitPulseAt = this.now + EXIT_PULSE_INTERVAL;
    }

    this.descendProgress += dt;
    if (this.descendProgress >= DESCEND_CHANNEL_TIME) {
      // Tell clients to fade to black, then swap floors under cover of it so the
      // reposition is unseen. enterFloor resets the channel + ramp.
      this.descending = true;
      this.broadcast("descend");
      const fromDepth = this.state.depth;
      this.clock.setTimeout(() => {
        this.state.players.forEach((p, sid) => {
          // Descending banks a life (capped) — racing deep buys survivability.
          p.respawnsLeft = Math.min(LIFE_CAP, p.respawnsLeft + 1);
          // ...and banks the score chase: grant the cleared floor's depth bonus,
          // then lock the whole floor's haul in (banked = current score) so a later
          // wipe can no longer forfeit it. enterFloor resets heat → multiplier to ×1.
          p.score += depthScore(fromDepth);
          const c = this.combat.get(sid);
          if (c) c.bankedScore = p.score;
        });
        this.enterFloor(fromDepth + 1);
        this.descending = false;
      }, DESCEND_FADE_MS);
    }
  }

  /**
   * One exit ward-pulse (M11): shove every mob within range away from the ladder
   * and briefly stagger it (reusing the bomb stun field; Math.max so it never
   * shortens a longer stun). Broadcasts so clients ring the ladder — the stagger
   * tint rides the synced Mob.stunned for free.
   */
  private exitPulse(ex: number, ey: number) {
    this.state.mobs.forEach((mob, id) => {
      if (dist(mob.x, mob.y, ex, ey) > EXIT_PULSE_RADIUS + MOB_RADIUS) return;
      const k = applyKnockback(
        this.collision, this.map.width, this.map.height, TILE,
        ex, ey, mob.x, mob.y, EXIT_PULSE_KNOCKBACK, MOB_RADIUS
      );
      mob.x = k.x;
      mob.y = k.y;
      const ai = this.mobAI.get(id);
      if (ai) ai.stunnedUntil = Math.max(ai.stunnedUntil, this.now + EXIT_PULSE_STAGGER);
    });
    this.broadcast("exit_pulse", { x: ex, y: ey });
  }

  // --- Combat ------------------------------------------------------------

  private handleAttack(sessionId: string) {
    const player = this.state.players.get(sessionId);
    const c = this.combat.get(sessionId);
    if (!player || !c || player.hp <= 0) return; // no attacking while dead
    if (this.now < c.attackReadyAt) return; // on cooldown
    c.attackReadyAt = this.now + PLAYER_ATTACK_COOLDOWN;

    const damage = playerAttackDamage(player.attackBuff > 0, c.attackMult);
    const knockback = player.attackBuff > 0 ? c.knockback : 0;
    this.state.mobs.forEach((mob, id) => {
      if (dist(mob.x, mob.y, player.x, player.y) <= PLAYER_ATTACK_RANGE + MOB_RADIUS) {
        mob.hp -= damage;
        if (mob.hp <= 0) {
          this.killMob(id, mob, sessionId);
        } else if (knockback > 0) {
          const k = applyKnockback(
            this.collision, this.map.width, this.map.height, TILE,
            player.x, player.y, mob.x, mob.y, knockback, MOB_RADIUS
          );
          mob.x = k.x;
          mob.y = k.y;
        }
      }
    });

    // The same swing also breaks crates in range.
    this.state.crates.forEach((crate, id) => {
      if (dist(crate.x, crate.y, player.x, player.y) <= PLAYER_ATTACK_RANGE + CRATE_RADIUS) {
        crate.hp = Math.max(0, crate.hp - damage);
        if (crate.hp <= 0) this.breakCrate(id, crate.x, crate.y, sessionId);
      }
    });

    // The same swing chips the vault — but only once it's unlocked (the door's
    // open) and the hero is in melee range. The breaking blow opens it.
    const chest = this.state.chests.get(VAULT_ID);
    if (
      chest &&
      !chest.locked &&
      chest.hp > 0 &&
      dist(chest.x, chest.y, player.x, player.y) <= PLAYER_ATTACK_RANGE + CHEST_RADIUS
    ) {
      chest.hp = Math.max(0, chest.hp - damage);
      if (chest.hp <= 0) this.openChest(sessionId);
    }
  }

  /**
   * Spend the carried heal potion. Contextual: if a downed ally is within
   * REVIVE_RANGE, the potion revives them (their life is preserved) instead of
   * self-healing — reusing the heal action, no new control. Otherwise it tops up
   * the caller's own HP. A downed caller can do neither.
   */
  private handleUseHeal(sessionId: string) {
    const player = this.state.players.get(sessionId);
    if (!player || player.downed || player.healCharges <= 0) return;

    const ally = this.nearestDownedAlly(sessionId, player.x, player.y);
    if (ally) {
      ally.player.hp = Math.max(1, Math.round(REVIVE_HP_PCT * ally.player.maxHp));
      ally.player.downed = false;
      ally.player.respawnIn = 0;
      const ac = this.combat.get(ally.id);
      if (ac) ac.respawnReadyAt = 0;
      player.healCharges--;
      return;
    }

    player.hp = Math.min(player.maxHp, player.hp + HEAL_PCT * player.maxHp);
    player.healCharges--;
  }

  /**
   * Place a carried bomb at the hero's feet (M10). No-op while downed, out of
   * bombs, or once the run's over. The fuse + blast are simulated in updateBombs.
   */
  private handleUseBomb(sessionId: string) {
    if (this.state.phase !== "playing") return;
    const player = this.state.players.get(sessionId);
    if (!player || player.downed || player.bombs <= 0) return;
    player.bombs--;
    const bomb = new Bomb();
    bomb.x = player.x;
    bomb.y = player.y;
    bomb.fuse = BOMB_FUSE;
    const id = `b${this.bombSeq++}`;
    this.state.bombs.set(id, bomb);
    this.bombOwners.set(id, sessionId);
  }

  /**
   * Tick placed bombs; detonate any whose fuse has run out. Frozen once the run's
   * over so a lingering fuse can't fire on the score screen.
   */
  private updateBombs(dt: number) {
    if (this.state.phase !== "playing") return;
    this.state.bombs.forEach((bomb, id) => {
      bomb.fuse -= dt;
      if (bomb.fuse <= 0) this.detonateBomb(id, bomb);
    });
  }

  /**
   * Blow a bomb (M10). A LOCAL blast damages + knocks back mobs in range and
   * damages any hero caught in it — including the placer who didn't step clear
   * (the risk). Then EVERY surviving mob on the floor is stunned for a beat (the
   * relief). Mob kills route through killMob, so they credit the placer's score
   * and feed the M9 spawn lull. Removes the bomb — the client plays the burst.
   */
  private detonateBomb(id: string, bomb: Bomb) {
    const ownerId = this.bombOwners.get(id) ?? "";
    const bx = bomb.x;
    const by = bomb.y;

    // Local blast: damage + knockback mobs within range (kills credit the placer).
    this.state.mobs.forEach((mob, mid) => {
      if (dist(mob.x, mob.y, bx, by) > BOMB_BLAST_RADIUS + MOB_RADIUS) return;
      mob.hp -= BOMB_BLAST_DAMAGE;
      if (mob.hp <= 0) {
        this.killMob(mid, mob, ownerId);
        return;
      }
      const k = applyKnockback(
        this.collision, this.map.width, this.map.height, TILE,
        bx, by, mob.x, mob.y, BOMB_KNOCKBACK, MOB_RADIUS
      );
      mob.x = k.x;
      mob.y = k.y;
    });

    // Map-wide stun: freeze every surviving mob (the breathing room).
    this.state.mobs.forEach((_mob, mid) => {
      const ai = this.mobAI.get(mid);
      if (ai) ai.stunnedUntil = this.now + BOMB_STUN;
    });

    // The blast is indiscriminate: a living hero in range takes it too. Downing
    // falls out of the normal hp<=0 handling on the next tick.
    this.state.players.forEach((p) => {
      if (p.hp > 0 && dist(p.x, p.y, bx, by) <= BOMB_BLAST_RADIUS + PLAYER_RADIUS) {
        p.hp = Math.max(0, p.hp - BOMB_BLAST_DAMAGE);
      }
    });

    this.state.bombs.delete(id);
    this.bombOwners.delete(id);
  }

  /** The closest downed ally to (x, y) within REVIVE_RANGE, or undefined. */
  private nearestDownedAlly(
    sessionId: string,
    x: number,
    y: number
  ): { id: string; player: Player } | undefined {
    let bestId = "";
    let best = REVIVE_RANGE;
    this.state.players.forEach((p, id) => {
      if (id === sessionId || !p.downed) return;
      const d = dist(x, y, p.x, p.y);
      if (d <= best) {
        best = d;
        bestId = id;
      }
    });
    if (bestId === "") return undefined;
    return { id: bestId, player: this.state.players.get(bestId)! };
  }

  /** Spend a life to self-respawn, once down and the unlock cooldown has elapsed. */
  private handleRespawn(sessionId: string) {
    if (this.state.phase !== "playing") return;
    const player = this.state.players.get(sessionId);
    const c = this.combat.get(sessionId);
    if (!player || !c || !player.downed) return;
    if (player.respawnsLeft <= 0) return; // revive-only; no self-respawn
    if (this.now < c.respawnReadyAt) return; // cooldown still running
    this.respawn(player, c);
    player.respawnsLeft--;
    c.respawnsUsed++;
  }

  /** Roll a fresh run from the game-over screen: new dungeon, lives + state reset. */
  private handleRestart() {
    if (this.state.phase !== "gameover") return;
    // New layout for the new run (each floor still derives from this + depth).
    this.baseSeed = (Math.random() * 0x100000000) >>> 0;
    this.state.players.forEach((player, sessionId) => {
      player.hp = player.maxHp;
      player.downed = false;
      player.respawnIn = 0;
      player.respawnsLeft = STARTING_LIVES;
      player.healCharges = 0;
      player.bombs = 0;
      player.attackBuff = 0;
      player.defenseBuff = 0;
      player.weapon = "";
      player.score = 0;
      player.relics.clear(); // fresh run — relics otherwise persist across floors
      const c = this.combat.get(sessionId);
      if (c) {
        c.attackReadyAt = 0;
        c.respawnReadyAt = 0;
        c.respawnsUsed = 0;
        c.bankedScore = 0;
        c.attackMult = 1;
        c.defenseReduce = 0;
        c.knockback = 0;
      }
    });
    this.state.phase = "playing";
    this.enterFloor(1);
  }

  private killMob(id: string, mob: Mob, killerId: string) {
    // Credit the killer at the floor's live multiplier — dwelling into high heat
    // makes each kill worth more (the dwell payoff). Scored into Player.score; the
    // current floor's gain rides un-banked until they descend (see updateDescent).
    const killer = this.state.players.get(killerId);
    if (killer) {
      // Tougher/deeper kinds are worth more: the kind's base value feeds the
      // depth + heat-multiplier scoring (see MOBS / killScore).
      const base = mobByName(mob.kind).score;
      killer.score += Math.round(killScore(this.state.depth, base) * scoreMultiplier(this.state.heat));
    }
    this.dropLoot(mob.x, mob.y);
    this.state.mobs.delete(id);
    this.mobAI.delete(id);
    // Hold off the pressure refill (M9). Killing en masse stacks the lull toward
    // its cap, so a rout — not a trickle — is what actually quiets the floor.
    this.spawnSuppressedUntil = extendSpawnLull(this.spawnSuppressedUntil, this.now);
  }

  // --- Mobs --------------------------------------------------------------

  private spawnMob() {
    const tile = this.floors[Math.floor(Math.random() * this.floors.length)];
    if (!tile) return;
    const mob = new Mob();
    mob.x = tile.x * TILE + TILE / 2;
    mob.y = tile.y * TILE + TILE / 2;
    // Pick a kind from the depth-gated spawn mix (M5), then field it tougher the
    // deeper we are: HP scales with depth here; its damage is scaled at hit time
    // in updateMob. Speed/aggro/score come from the kind's row (see MOBS).
    const kind = rollMobKind(this.state.depth);
    mob.kind = kind.name;
    const hp = scaleMobHp(kind.hp, this.state.depth);
    mob.hp = hp;
    mob.maxHp = hp;
    const id = `m${this.mobSeq++}`;
    this.state.mobs.set(id, mob);
    this.mobAI.set(id, { attackReadyAt: 0, nextWanderAt: 0, wanderDx: 0, wanderDy: 0, stunnedUntil: 0 });
  }

  private updateMob(mob: Mob, id: string, dt: number, candidates: AggroCandidate[]) {
    const ai = this.mobAI.get(id);
    if (!ai) return;

    // Bomb stun (M10): frozen mobs don't move or attack. Toggle the synced flag
    // only on the transition so it stays off the wire while unchanged.
    const stunned = this.now < ai.stunnedUntil;
    if (mob.stunned !== stunned) mob.stunned = stunned;
    if (stunned) return;

    const kind = mobByName(mob.kind); // per-kind aggro / damage (M5)

    // Aggro the nearest living player within range (candidates pre-filtered to
    // the living, built once per tick).
    const aggro = pickAggroTarget(mob.x, mob.y, candidates, kind.aggro);
    const target = aggro ? this.state.players.get(aggro.id) : undefined;
    if (aggro && target) {
      if (aggro.dist <= MOB_ATTACK_RANGE) {
        if (this.now >= ai.attackReadyAt) {
          ai.attackReadyAt = this.now + MOB_ATTACK_COOLDOWN;
          mob.attackTick = (mob.attackTick + 1) % 256; // signal a strike to clients
          const tc = this.combat.get(aggro.id);
          const base = scaleMobDamage(kind.damage, this.state.depth);
          const dmg = mobDamageAfterDefense(target.defenseBuff > 0, tc ? tc.defenseReduce : 0, base);
          target.hp = Math.max(0, target.hp - dmg);
        }
      } else {
        this.moveMob(mob, target.x - mob.x, target.y - mob.y, dt, 1);
      }
      return;
    }

    // No target: gentle wander, re-rolling direction every couple seconds.
    if (this.now >= ai.nextWanderAt) {
      ai.nextWanderAt = this.now + 1 + Math.random() * 2;
      if (Math.random() < 0.4) {
        ai.wanderDx = 0;
        ai.wanderDy = 0;
      } else {
        const a = Math.random() * Math.PI * 2;
        ai.wanderDx = Math.cos(a);
        ai.wanderDy = Math.sin(a);
      }
    }
    if (ai.wanderDx !== 0 || ai.wanderDy !== 0) {
      this.moveMob(mob, ai.wanderDx, ai.wanderDy, dt, 0.5);
    }
  }

  private moveMob(mob: Mob, dx: number, dy: number, dt: number, speedScale: number) {
    const dir = normalize(dx, dy);
    if (dir.x === 0 && dir.y === 0) return;
    const speed = mobByName(mob.kind).speed * speedScale * dt;
    const nx = mob.x + dir.x * speed;
    const ny = mob.y + dir.y * speed;
    if (!this.collides(nx, mob.y, MOB_RADIUS)) mob.x = nx;
    if (!this.collides(mob.x, ny, MOB_RADIUS)) mob.y = ny;
  }

  // --- Loot --------------------------------------------------------------

  private dropLoot(x: number, y: number) {
    const loot = new Loot();
    loot.x = x;
    loot.y = y;
    loot.category = rollCategory();
    if (loot.category === "attack") {
      // Attack drops are a specific weapon; its own rarity tags the floor glow.
      const weapon = rollWeapon();
      loot.variant = weapon.name;
      loot.rarity = weapon.rarity;
    } else {
      loot.rarity = rollRarity().name;
    }
    this.state.loot.set(`l${this.lootSeq++}`, loot);
  }

  // --- Death markers -----------------------------------------------------

  /** Drop a tombstone where a hero fell, culling the oldest past the cap. */
  private placeDeathMarker(x: number, y: number, color: string) {
    const marker = new DeathMarker();
    marker.x = x;
    marker.y = y;
    marker.color = color;
    const id = `d${this.markerSeq++}`;
    this.state.markers.set(id, marker);
    this.markerIds.push(id);
    while (this.markerIds.length > MAX_DEATH_MARKERS) {
      this.state.markers.delete(this.markerIds.shift()!);
    }
  }

  // --- Simulation --------------------------------------------------------

  private update(deltaMs: number) {
    const dt = deltaMs / 1000;
    this.now += dt;

    // Pressure ramps with time on the floor (reset on descend). Surface it to the
    // HUD as `heat` and drive the mob population + top-up cadence off the same value.
    const heat = heatLevel(this.now - this.floorStartAt);
    this.state.heat = heat;

    this.state.players.forEach((player, sessionId) => {
      const c = this.combat.get(sessionId);
      if (!c) return;

      // Downed: hp<=0, awaiting a player-driven self-respawn or a teammate's
      // revive. No movement or pickups meanwhile.
      if (player.hp <= 0) {
        if (!player.downed) {
          // First downed tick → mark down, leave a tombstone, and arm the ramping
          // self-respawn cooldown (longer the more lives this hero has spent).
          player.downed = true;
          c.respawnReadyAt = this.now + respawnDelay(c.respawnsUsed);
          this.placeDeathMarker(player.x, player.y, player.color);
        }
        // Tick the unlock countdown (only meaningful while lives remain — at 0
        // there's no self-respawn button, just the wait for a revive).
        player.respawnIn = player.respawnsLeft > 0 ? Math.max(0, c.respawnReadyAt - this.now) : 0;
        return;
      }

      // Slow passive heal while alive (no-op at full HP).
      player.hp = regenHp(player.hp, player.maxHp, dt);

      // Tick down active buffs; clear their potency once they lapse.
      if (player.attackBuff > 0) {
        player.attackBuff = Math.max(0, player.attackBuff - dt);
        if (player.attackBuff === 0) {
          c.attackMult = 1;
          c.knockback = 0;
          player.weapon = "";
        }
      }
      if (player.defenseBuff > 0) {
        player.defenseBuff = Math.max(0, player.defenseBuff - dt);
        if (player.defenseBuff === 0) c.defenseReduce = 0;
      }

      const input = this.inputs.get(sessionId);
      if (input) {
        // normalize() keeps diagonals from being faster than cardinal moves.
        const dir = normalize(
          (input.right ? 1 : 0) - (input.left ? 1 : 0),
          (input.down ? 1 : 0) - (input.up ? 1 : 0)
        );
        if (dir.x !== 0 || dir.y !== 0) {
          const nextX = player.x + dir.x * PLAYER_SPEED * dt;
          const nextY = player.y + dir.y * PLAYER_SPEED * dt;
          // Axis-separated collision check gives smooth wall-sliding.
          if (!this.collides(nextX, player.y, PLAYER_RADIUS)) player.x = nextX;
          if (!this.collides(player.x, nextY, PLAYER_RADIUS)) player.y = nextY;
        }
      }

      // Auto-pickup any loot underfoot → applies its effect. A heal you can't
      // hold (full stack) is left on the floor instead of being wasted.
      this.state.loot.forEach((loot, lid) => {
        if (dist(loot.x, loot.y, player.x, player.y) <= PICKUP_RANGE && applyLootEffect(player, c, loot)) {
          // Grabbing a drop scores by its rarity, at the floor's live multiplier —
          // except a bomb, which is a carried tool, not a haul (no points).
          if (loot.category !== "bomb") {
            player.score += Math.round(lootScore(loot.rarity) * scoreMultiplier(this.state.heat));
          }
          this.state.loot.delete(lid);
        }
      });
    });

    // Build the mob-aggro candidate list once per tick (living players only),
    // then let every mob target against the same snapshot.
    const livingPlayers: AggroCandidate[] = [];
    this.state.players.forEach((p, sid) => {
      if (p.hp > 0) livingPlayers.push({ id: sid, x: p.x, y: p.y });
    });
    this.state.mobs.forEach((mob, id) => this.updateMob(mob, id, dt, livingPlayers));

    // Top the population up toward the pressure target — the hotter the floor, the
    // higher the target and the faster the top-ups. Frozen once the run is over.
    if (
      this.state.phase === "playing" &&
      this.state.mobs.size < targetMobCount(heat, this.state.depth) &&
      this.now >= this.nextMobSpawnAt &&
      this.now >= this.spawnSuppressedUntil // M9: recent kills hold the refill off
    ) {
      this.spawnMob();
      this.nextMobSpawnAt = this.now + spawnInterval(heat);
    }

    // Tick placed bombs; detonate any whose fuse has run out (M10).
    this.updateBombs(dt);

    // Tick the vault's unlock countdown (opens its door when it lands).
    this.updateChest(dt);

    // Let the party descend by holding the exit.
    this.updateDescent(dt);

    // End the run once nobody can recover: every hero down, none with a life left
    // to self-respawn (a downed hero with a life can still spend it; a standing one
    // can revive). Solo simply means "your lives are your run."
    this.checkWipe();
  }

  /**
   * Flip to game-over when the party is wholly down with no lives left. isWipe
   * gates on "everyone down"; the lives check is what keeps a solo hero (or a
   * party with a life banked) from a premature loss — they can still self-respawn.
   */
  private checkWipe() {
    if (this.state.phase !== "playing" || this.state.players.size === 0) return;
    const downed: boolean[] = [];
    let anyLifeLeft = false;
    this.state.players.forEach((p) => {
      downed.push(p.downed);
      if (p.respawnsLeft > 0) anyLifeLeft = true;
    });
    if (isWipe(downed) && !anyLifeLeft) {
      // Forfeit the current (un-banked) floor's haul — that's the risk that made
      // dwelling for a fat multiplier a gamble. Already-descended floors are safe.
      this.state.players.forEach((p, sid) => {
        const c = this.combat.get(sid);
        if (c) p.score = c.bankedScore;
      });
      this.state.phase = "gameover";
      this.broadcast("gameover", { floor: this.state.depth });
    }
  }

  private respawn(player: Player, c: Combat) {
    const spawn = this.map.spawns[Math.floor(Math.random() * this.map.spawns.length)];
    player.x = spawn.x;
    player.y = spawn.y;
    player.hp = player.maxHp;
    player.downed = false;
    player.respawnIn = 0;
    // Buffs lapse on death; the carried heal potion is kept.
    player.attackBuff = 0;
    player.defenseBuff = 0;
    player.weapon = "";
    c.attackMult = 1;
    c.defenseReduce = 0;
    c.knockback = 0;
    c.respawnReadyAt = 0;
  }

  /** True if a box of half-size r centered at (x, y) overlaps a wall or prop tile. */
  private collides(x: number, y: number, r: number): boolean {
    return tileCollides(this.collision, this.map.width, this.map.height, TILE, x, y, r);
  }
}
