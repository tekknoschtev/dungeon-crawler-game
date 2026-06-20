import { Room, Client, matchMaker } from "colyseus";
import { DungeonState, Player, Mob, Loot, DeathMarker } from "./schema/DungeonState";
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
  MOB_DAMAGE,
  PICKUP_RANGE,
  HEAL_PCT,
  MAX_DEATH_MARKERS,
  EXIT_RADIUS,
  DESCEND_CHANNEL_TIME,
  DESCEND_FADE_MS,
} from "./tuning";
import {
  dist,
  normalize,
  collides as tileCollides,
  rollRarity,
  rollCategory,
  rollWeapon,
  applyLootEffect,
  applyKnockback,
  playerAttackDamage,
  mobDamageAfterDefense,
  regenHp,
  isAllowedColor,
  isAllowedSprite,
  pickAggroTarget,
  heatLevel,
  targetMobCount,
  spawnInterval,
  scaleMobHp,
  scaleMobDamage,
  type AggroCandidate,
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
  knockback: number; // px a hit mob is shoved by the equipped weapon (0 = none)
}

/** Per-mob AI state (server-only; not synced). */
interface MobAI {
  attackReadyAt: number;
  nextWanderAt: number;
  wanderDx: number;
  wanderDy: number;
}

// Hero appearance (colors + body sprites) lives in ./heroAppearance — the
// canonical, server-authoritative lists, imported above and shared with the
// client lobby so the two can't drift.

export class DungeonRoom extends Room<{ state: DungeonState }> {
  maxClients = 4;

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
  private markerSeq = 0;
  private markerIds: string[] = []; // death-marker ids in insertion order (for culling)
  private now = 0; // accumulated simulation time in seconds
  private nextMobSpawnAt = 0;
  private baseSeed = 0; // room seed; each floor derives its layout from this + depth
  private floorStartAt = 0; // sim time the current floor began (drives the pressure ramp)
  private descendProgress = 0; // s a hero has held the exit toward the descend channel
  private descending = false; // true during the fade-out window before the floor swaps

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

    // Quaff the carried heal potion, if any.
    this.onMessage("useHeal", (client) => this.handleUseHeal(client.sessionId));

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

    this.state.players.set(client.sessionId, player);
    this.inputs.set(client.sessionId, { up: false, down: false, left: false, right: false });
    this.combat.set(client.sessionId, { attackReadyAt: 0, respawnAt: 0, attackMult: 1, defenseReduce: 0, knockback: 0 });

    // The map is sent when the client signals "ready" (see onCreate), not here.
    console.log(`${player.name} joined (${client.sessionId}). Players: ${this.clients.length}`);
  }

  onLeave(client: Client) {
    this.state.players.delete(client.sessionId);
    this.inputs.delete(client.sessionId);
    this.combat.delete(client.sessionId);
    console.log(`Left: ${client.sessionId}. Players: ${this.clients.length}`);
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

    // Bake props into a collision-only grid (walls + prop tiles solid).
    this.collision = this.map.grid.map((row) => row.slice());
    for (const p of this.map.props) this.collision[p.y][p.x] = 1;

    // Cache every walkable tile once (floor minus props), for mob/loot spawns.
    this.floors = [];
    for (let y = 0; y < this.map.height; y++) {
      for (let x = 0; x < this.map.width; x++) {
        if (this.collision[y][x] === 0) this.floors.push({ x, y });
      }
    }

    // Fresh floor: drop the previous floor's mobs, loot, and death markers (whose
    // coords are meaningless on the new layout), and reset the ramp.
    this.state.mobs.clear();
    this.mobAI.clear();
    this.state.loot.clear();
    this.state.markers.clear();
    this.markerIds = [];
    this.floorStartAt = this.now;
    this.nextMobSpawnAt = this.now;
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

  /** The map payload clients render (geometry + props + the descent exit). */
  private mapPayload() {
    return {
      tile: this.map.tile,
      width: this.map.width,
      height: this.map.height,
      grid: this.map.grid,
      props: this.map.props,
      exit: this.map.exit,
    };
  }

  /**
   * Descent channel: while any living hero stands on the exit, charge a short
   * timer; when it fills, the whole party drops to the next floor. Stepping off
   * cancels it. Co-op-friendly — anyone can initiate, nobody has to clear first.
   */
  private updateDescent(dt: number) {
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
    this.descendProgress += dt;
    if (this.descendProgress >= DESCEND_CHANNEL_TIME) {
      // Tell clients to fade to black, then swap floors under cover of it so the
      // reposition is unseen. enterFloor resets the channel + ramp.
      this.descending = true;
      this.broadcast("descend");
      this.clock.setTimeout(() => {
        this.enterFloor(this.state.depth + 1);
        this.descending = false;
      }, DESCEND_FADE_MS);
    }
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
          this.killMob(id, mob);
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
    // Deeper floors field tougher mobs (HP scales with depth; damage is scaled
    // at hit time in updateMob).
    const hp = scaleMobHp(MOB_MAX_HP, this.state.depth);
    mob.hp = hp;
    mob.maxHp = hp;
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
          const base = scaleMobDamage(MOB_DAMAGE, this.state.depth);
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

      // Dead: count down to respawn; no movement or pickups meanwhile.
      if (player.hp <= 0) {
        if (c.respawnAt === 0) {
          // First tick dead → leave a tombstone where they fell.
          c.respawnAt = this.now + RESPAWN_DELAY;
          this.placeDeathMarker(player.x, player.y, player.color);
        } else if (this.now >= c.respawnAt) {
          this.respawn(player, c);
        }
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
    // higher the target and the faster the top-ups.
    if (this.state.mobs.size < targetMobCount(heat, this.state.depth) && this.now >= this.nextMobSpawnAt) {
      this.spawnMob();
      this.nextMobSpawnAt = this.now + spawnInterval(heat);
    }

    // Let the party descend by holding the exit.
    this.updateDescent(dt);
  }

  private respawn(player: Player, c: Combat) {
    const spawn = this.map.spawns[Math.floor(Math.random() * this.map.spawns.length)];
    player.x = spawn.x;
    player.y = spawn.y;
    player.hp = player.maxHp;
    // Buffs lapse on death; the carried heal potion is kept.
    player.attackBuff = 0;
    player.defenseBuff = 0;
    player.weapon = "";
    c.attackMult = 1;
    c.defenseReduce = 0;
    c.knockback = 0;
    c.respawnAt = 0;
  }

  /** True if a box of half-size r centered at (x, y) overlaps a wall or prop tile. */
  private collides(x: number, y: number, r: number): boolean {
    return tileCollides(this.collision, this.map.width, this.map.height, TILE, x, y, r);
  }
}
