import { Room, Client, matchMaker } from "colyseus";
import { DungeonState, Player, Mob, Loot } from "./schema/DungeonState";
import { loadMap, LoadedMap, TILE } from "./map";

// Friendly join codes: 4 chars, no ambiguous glyphs (0/O, 1/I/L). Short enough
// to read aloud or type on a phone; ~707k combinations is plenty for the handful
// of rooms ever live at once.
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_LEN = 4;
const CODE_RE = new RegExp(`^[${CODE_ALPHABET}]{${CODE_LEN}}$`);

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

function dist(ax: number, ay: number, bx: number, by: number): number {
  return Math.hypot(ax - bx, ay - by);
}

/** Per-player input held server-side only (never trusted blindly). */
interface InputState {
  up: boolean;
  down: boolean;
  left: boolean;
  right: boolean;
}

/** Per-player combat timers (server-only; not synced). respawnAt 0 = alive. */
interface Combat {
  attackReadyAt: number;
  respawnAt: number;
}

/** Per-mob AI state (server-only; not synced). */
interface MobAI {
  attackReadyAt: number;
  nextWanderAt: number;
  wanderDx: number;
  wanderDy: number;
}

// --- Tuning -------------------------------------------------------------
// Tuned for 16px tiles. PLAYER_RADIUS keeps the hero's box narrower than a
// 1-tile corridor so it slips through gaps.
const PLAYER_SPEED = 80; // px/s
const PLAYER_RADIUS = 5;
const PLAYER_MAX_HP = 100;
const PLAYER_ATTACK_DAMAGE = 12;
const PLAYER_ATTACK_RANGE = 24; // px radius of the (omnidirectional) melee swing
const PLAYER_ATTACK_COOLDOWN = 0.45; // s
const RESPAWN_DELAY = 3; // s

const MOB_MAX_HP = 30;
const MOB_SPEED = 50; // px/s — slower than the player so mobs are kiteable
const MOB_RADIUS = 5;
const MOB_DAMAGE = 8;
const MOB_ATTACK_COOLDOWN = 1.0; // s
const MOB_AGGRO_RANGE = 96; // px (~6 tiles)
const MOB_ATTACK_RANGE = 18; // px
const MOB_TARGET_COUNT = 12; // population the room tops up to
const MOB_RESPAWN_INTERVAL = 4; // s between top-up spawns

const PICKUP_RANGE = 14; // px — auto-collect radius

// Loot rarities: relative drop weight + the item sprite frame to render.
// Frames are Tiny Dungeon indices (potions #113–116, chest #89 for the jackpot).
const RARITIES = [
  { name: "common", weight: 60, frame: 113 },
  { name: "uncommon", weight: 25, frame: 114 },
  { name: "rare", weight: 10, frame: 115 },
  { name: "epic", weight: 4, frame: 116 },
  { name: "legendary", weight: 1, frame: 89 },
];
const RARITY_TOTAL = RARITIES.reduce((sum, r) => sum + r.weight, 0);

// Distinct hero colors handed out round-robin as players join.
const COLORS = ["#ff5d73", "#4ec9ff", "#ffd65c", "#7cf36b", "#c08bff", "#ff9f45"];

export class DungeonRoom extends Room<{ state: DungeonState }> {
  maxClients = 4;

  private map!: LoadedMap;
  private inputs = new Map<string, InputState>();
  private combat = new Map<string, Combat>();
  private mobAI = new Map<string, MobAI>();
  private floors: { x: number; y: number }[] = []; // floor tile coords (for spawns)
  private colorIndex = 0;
  private mobSeq = 0;
  private lootSeq = 0;
  private now = 0; // accumulated simulation time in seconds
  private nextMobSpawnAt = 0;

  async onCreate(options: { code?: string } = {}) {
    this.state = new DungeonState();

    // Shareable join code. Honor a valid client-supplied code (lets a host pick
    // one); otherwise mint a unique one. filterBy(["code"]) in index.ts routes
    // `client.join("dungeon", { code })` to the room created with that code.
    const code =
      options.code && CODE_RE.test(options.code) ? options.code : await uniqueCode();
    this.state.code = code;
    this.setMetadata({ code });

    // One random seed per room drives the whole layout. Stored in state so the
    // exact dungeon is reproducible and (later) shareable by code.
    this.state.seed = (Math.random() * 0x100000000) >>> 0;
    this.map = loadMap(this.state.seed);

    // Cache every floor tile once, for random mob/loot placement.
    for (let y = 0; y < this.map.height; y++) {
      for (let x = 0; x < this.map.width; x++) {
        if (this.map.grid[y][x] === 0) this.floors.push({ x, y });
      }
    }

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

    // The client requests the map once its renderer is ready (handlers wired),
    // rather than us pushing it in onJoin — that one-time payload would otherwise
    // be missed while the client finishes booting (loading art, etc.).
    this.onMessage("ready", (client) => {
      client.send("map", {
        tile: this.map.tile,
        width: this.map.width,
        height: this.map.height,
        grid: this.map.grid,
      });
    });

    // Seed the initial mob population.
    for (let i = 0; i < MOB_TARGET_COUNT; i++) this.spawnMob();

    // Fixed-step authoritative simulation. The callback receives delta in ms.
    this.setSimulationInterval((deltaMs) => this.update(deltaMs));

    console.log(`DungeonRoom created: ${this.roomId} (code ${code})`);
  }

  onJoin(client: Client, options: { name?: string } = {}) {
    const player = new Player();
    const spawn = this.map.spawns[this.clients.length % this.map.spawns.length];
    player.x = spawn.x;
    player.y = spawn.y;
    player.hp = PLAYER_MAX_HP;
    player.maxHp = PLAYER_MAX_HP;
    player.color = COLORS[this.colorIndex % COLORS.length];
    this.colorIndex++;
    player.name = (options.name && options.name.trim().slice(0, 16)) || `Hero ${this.clients.length}`;

    this.state.players.set(client.sessionId, player);
    this.inputs.set(client.sessionId, { up: false, down: false, left: false, right: false });
    this.combat.set(client.sessionId, { attackReadyAt: 0, respawnAt: 0 });

    // The map is sent when the client signals "ready" (see onCreate), not here.
    console.log(`${player.name} joined (${client.sessionId}). Players: ${this.clients.length}`);
  }

  onLeave(client: Client) {
    this.state.players.delete(client.sessionId);
    this.inputs.delete(client.sessionId);
    this.combat.delete(client.sessionId);
    console.log(`Left: ${client.sessionId}. Players: ${this.clients.length}`);
  }

  // --- Combat ------------------------------------------------------------

  private handleAttack(sessionId: string) {
    const player = this.state.players.get(sessionId);
    const c = this.combat.get(sessionId);
    if (!player || !c || player.hp <= 0) return; // no attacking while dead
    if (this.now < c.attackReadyAt) return; // on cooldown
    c.attackReadyAt = this.now + PLAYER_ATTACK_COOLDOWN;

    this.state.mobs.forEach((mob, id) => {
      if (dist(mob.x, mob.y, player.x, player.y) <= PLAYER_ATTACK_RANGE + MOB_RADIUS) {
        mob.hp -= PLAYER_ATTACK_DAMAGE;
        if (mob.hp <= 0) this.killMob(id, mob);
      }
    });
  }

  private killMob(id: string, mob: Mob) {
    this.dropLoot(mob.x, mob.y);
    this.state.mobs.delete(id);
    this.mobAI.delete(id);
  }

  // --- Mobs --------------------------------------------------------------

  private spawnMob() {
    const tile = this.floors[Math.floor(Math.random() * this.floors.length)];
    if (!tile) return;
    const mob = new Mob();
    mob.x = tile.x * TILE + TILE / 2;
    mob.y = tile.y * TILE + TILE / 2;
    mob.hp = MOB_MAX_HP;
    mob.maxHp = MOB_MAX_HP;
    mob.kind = "slime";
    const id = `m${this.mobSeq++}`;
    this.state.mobs.set(id, mob);
    this.mobAI.set(id, { attackReadyAt: 0, nextWanderAt: 0, wanderDx: 0, wanderDy: 0 });
  }

  private updateMob(mob: Mob, id: string, dt: number) {
    const ai = this.mobAI.get(id);
    if (!ai) return;

    // Aggro the nearest living player within range.
    let target: Player | null = null;
    let best = MOB_AGGRO_RANGE;
    this.state.players.forEach((p) => {
      if (p.hp <= 0) return;
      const d = dist(mob.x, mob.y, p.x, p.y);
      if (d < best) {
        best = d;
        target = p;
      }
    });

    if (target) {
      const t = target as Player;
      if (best <= MOB_ATTACK_RANGE) {
        if (this.now >= ai.attackReadyAt) {
          ai.attackReadyAt = this.now + MOB_ATTACK_COOLDOWN;
          t.hp = Math.max(0, t.hp - MOB_DAMAGE);
        }
      } else {
        this.moveMob(mob, t.x - mob.x, t.y - mob.y, dt, 1);
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
    const len = Math.hypot(dx, dy);
    if (len === 0) return;
    const speed = MOB_SPEED * speedScale * dt;
    const nx = mob.x + (dx / len) * speed;
    const ny = mob.y + (dy / len) * speed;
    if (!this.collides(nx, mob.y, MOB_RADIUS)) mob.x = nx;
    if (!this.collides(mob.x, ny, MOB_RADIUS)) mob.y = ny;
  }

  // --- Loot --------------------------------------------------------------

  private dropLoot(x: number, y: number) {
    const r = this.rollRarity();
    const loot = new Loot();
    loot.x = x;
    loot.y = y;
    loot.rarity = r.name;
    loot.kind = r.frame;
    this.state.loot.set(`l${this.lootSeq++}`, loot);
  }

  private rollRarity() {
    let roll = Math.random() * RARITY_TOTAL;
    for (const r of RARITIES) {
      roll -= r.weight;
      if (roll < 0) return r;
    }
    return RARITIES[0];
  }

  private creditLoot(player: Player, rarity: string) {
    switch (rarity) {
      case "uncommon":
        player.lootUncommon++;
        break;
      case "rare":
        player.lootRare++;
        break;
      case "epic":
        player.lootEpic++;
        break;
      case "legendary":
        player.lootLegendary++;
        break;
      default:
        player.lootCommon++;
    }
  }

  // --- Simulation --------------------------------------------------------

  private update(deltaMs: number) {
    const dt = deltaMs / 1000;
    this.now += dt;

    this.state.players.forEach((player, sessionId) => {
      const c = this.combat.get(sessionId);
      if (!c) return;

      // Dead: count down to respawn; no movement or pickups meanwhile.
      if (player.hp <= 0) {
        if (c.respawnAt === 0) c.respawnAt = this.now + RESPAWN_DELAY;
        else if (this.now >= c.respawnAt) this.respawn(player, c);
        return;
      }

      const input = this.inputs.get(sessionId);
      if (input) {
        let dx = (input.right ? 1 : 0) - (input.left ? 1 : 0);
        let dy = (input.down ? 1 : 0) - (input.up ? 1 : 0);
        if (dx !== 0 || dy !== 0) {
          // normalize diagonals so they aren't faster
          if (dx !== 0 && dy !== 0) {
            const inv = Math.SQRT1_2;
            dx *= inv;
            dy *= inv;
          }
          const nextX = player.x + dx * PLAYER_SPEED * dt;
          const nextY = player.y + dy * PLAYER_SPEED * dt;
          // Axis-separated collision check gives smooth wall-sliding.
          if (!this.collides(nextX, player.y, PLAYER_RADIUS)) player.x = nextX;
          if (!this.collides(player.x, nextY, PLAYER_RADIUS)) player.y = nextY;
        }
      }

      // Auto-pickup any loot underfoot.
      this.state.loot.forEach((loot, lid) => {
        if (dist(loot.x, loot.y, player.x, player.y) <= PICKUP_RANGE) {
          this.creditLoot(player, loot.rarity);
          this.state.loot.delete(lid);
        }
      });
    });

    this.state.mobs.forEach((mob, id) => this.updateMob(mob, id, dt));

    // Top the population back up over time as mobs are killed.
    if (this.state.mobs.size < MOB_TARGET_COUNT && this.now >= this.nextMobSpawnAt) {
      this.spawnMob();
      this.nextMobSpawnAt = this.now + MOB_RESPAWN_INTERVAL;
    }
  }

  private respawn(player: Player, c: Combat) {
    const spawn = this.map.spawns[Math.floor(Math.random() * this.map.spawns.length)];
    player.x = spawn.x;
    player.y = spawn.y;
    player.hp = player.maxHp;
    c.respawnAt = 0;
  }

  /** True if a box of half-size r centered at (x, y) overlaps any wall tile. */
  private collides(x: number, y: number, r: number): boolean {
    const corners = [
      [x - r, y - r],
      [x + r, y - r],
      [x - r, y + r],
      [x + r, y + r],
    ];
    for (const [cx, cy] of corners) {
      const tx = Math.floor(cx / TILE);
      const ty = Math.floor(cy / TILE);
      if (ty < 0 || ty >= this.map.height || tx < 0 || tx >= this.map.width) return true;
      if (this.map.grid[ty][tx] === 1) return true;
    }
    return false;
  }
}
