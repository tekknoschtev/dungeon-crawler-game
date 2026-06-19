import { Room, Client, matchMaker } from "colyseus";
import { DungeonState, Player, Mob, Loot } from "./schema/DungeonState";
import { loadMap, LoadedMap, TILE } from "./map";
import {
  PLAYER_SPEED,
  PLAYER_RADIUS,
  PLAYER_MAX_HP,
  PLAYER_ATTACK_RANGE,
  PLAYER_ATTACK_COOLDOWN,
  RESPAWN_DELAY,
  MOB_MAX_HP,
  MOB_SPEED,
  MOB_RADIUS,
  MOB_ATTACK_COOLDOWN,
  MOB_AGGRO_RANGE,
  MOB_ATTACK_RANGE,
  MOB_TARGET_COUNT,
  MOB_RESPAWN_INTERVAL,
  PICKUP_RANGE,
  HEAL_PCT,
} from "./tuning";
import {
  dist,
  normalize,
  collides as tileCollides,
  rollRarity,
  rollCategory,
  applyLootEffect,
  playerAttackDamage,
  mobDamageAfterDefense,
  regenHp,
  isAllowedColor,
  pickAggroTarget,
  type AggroCandidate,
} from "./logic";

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

/** Per-player input held server-side only (never trusted blindly). */
interface InputState {
  up: boolean;
  down: boolean;
  left: boolean;
  right: boolean;
}

/** Per-player combat state (server-only; not synced). respawnAt 0 = alive. */
interface Combat {
  attackReadyAt: number;
  respawnAt: number;
  attackMult: number; // active attack-buff damage multiplier (1 = none)
  defenseReduce: number; // active defense-buff damage reduction 0..1 (0 = none)
}

/** Per-mob AI state (server-only; not synced). */
interface MobAI {
  attackReadyAt: number;
  nextWanderAt: number;
  wanderDx: number;
  wanderDy: number;
}

// Distinct hero colors. Players pick one in the lobby (validated against this
// allowlist); unrecognised/absent picks fall back to round-robin assignment.
// The client lobby mirrors this list (HERO_COLORS in lobby.ts) — keep them in sync.
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

    // Quaff the carried heal potion, if any.
    this.onMessage("useHeal", (client) => this.handleUseHeal(client.sessionId));

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

  onJoin(client: Client, options: { name?: string; color?: string } = {}) {
    const player = new Player();
    const spawn = this.map.spawns[this.clients.length % this.map.spawns.length];
    player.x = spawn.x;
    player.y = spawn.y;
    player.hp = PLAYER_MAX_HP;
    player.maxHp = PLAYER_MAX_HP;
    // Honor the lobby's color pick if it's a known one; otherwise hand out the
    // next round-robin color (advancing the cursor only when we actually use it).
    if (isAllowedColor(options.color, COLORS)) {
      player.color = options.color!;
    } else {
      player.color = COLORS[this.colorIndex % COLORS.length];
      this.colorIndex++;
    }
    player.name = (options.name && options.name.trim().slice(0, 16)) || `Hero ${this.clients.length}`;

    this.state.players.set(client.sessionId, player);
    this.inputs.set(client.sessionId, { up: false, down: false, left: false, right: false });
    this.combat.set(client.sessionId, { attackReadyAt: 0, respawnAt: 0, attackMult: 1, defenseReduce: 0 });

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

    const damage = playerAttackDamage(player.attackBuff > 0, c.attackMult);
    this.state.mobs.forEach((mob, id) => {
      if (dist(mob.x, mob.y, player.x, player.y) <= PLAYER_ATTACK_RANGE + MOB_RADIUS) {
        mob.hp -= damage;
        if (mob.hp <= 0) this.killMob(id, mob);
      }
    });
  }

  private handleUseHeal(sessionId: string) {
    const player = this.state.players.get(sessionId);
    if (!player || player.hp <= 0 || player.healCharges <= 0) return;
    player.hp = Math.min(player.maxHp, player.hp + HEAL_PCT * player.maxHp);
    player.healCharges--;
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

  private updateMob(mob: Mob, id: string, dt: number, candidates: AggroCandidate[]) {
    const ai = this.mobAI.get(id);
    if (!ai) return;

    // Aggro the nearest living player within range (candidates pre-filtered to
    // the living, built once per tick).
    const aggro = pickAggroTarget(mob.x, mob.y, candidates, MOB_AGGRO_RANGE);
    const target = aggro ? this.state.players.get(aggro.id) : undefined;
    if (aggro && target) {
      if (aggro.dist <= MOB_ATTACK_RANGE) {
        if (this.now >= ai.attackReadyAt) {
          ai.attackReadyAt = this.now + MOB_ATTACK_COOLDOWN;
          mob.attackTick = (mob.attackTick + 1) % 256; // signal a strike to clients
          const tc = this.combat.get(aggro.id);
          const dmg = mobDamageAfterDefense(target.defenseBuff > 0, tc ? tc.defenseReduce : 0);
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
    const speed = MOB_SPEED * speedScale * dt;
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
    loot.rarity = rollRarity().name;
    loot.category = rollCategory();
    this.state.loot.set(`l${this.lootSeq++}`, loot);
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

      // Slow passive heal while alive (no-op at full HP).
      player.hp = regenHp(player.hp, player.maxHp, dt);

      // Tick down active buffs; clear their potency once they lapse.
      if (player.attackBuff > 0) {
        player.attackBuff = Math.max(0, player.attackBuff - dt);
        if (player.attackBuff === 0) c.attackMult = 1;
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
    // Buffs lapse on death; the carried heal potion is kept.
    player.attackBuff = 0;
    player.defenseBuff = 0;
    c.attackMult = 1;
    c.defenseReduce = 0;
    c.respawnAt = 0;
  }

  /** True if a box of half-size r centered at (x, y) overlaps any wall tile. */
  private collides(x: number, y: number, r: number): boolean {
    return tileCollides(this.map.grid, this.map.width, this.map.height, TILE, x, y, r);
  }
}
