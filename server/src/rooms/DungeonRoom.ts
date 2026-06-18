import { Room, Client } from "colyseus";
import { DungeonState, Player } from "./schema/DungeonState";
import { loadMap, LoadedMap, TILE } from "./map";

/** Per-player input held server-side only (never trusted blindly). */
interface InputState {
  up: boolean;
  down: boolean;
  left: boolean;
  right: boolean;
}

// Tuned for 16px tiles (≈5 tiles/sec). Radius keeps the hero's collision box
// comfortably narrower than a 1-tile corridor so it can slip through gaps.
const PLAYER_SPEED = 80; // pixels per second
const PLAYER_RADIUS = 5; // collision half-size in pixels

// Distinct hero colors handed out round-robin as players join.
const COLORS = ["#ff5d73", "#4ec9ff", "#ffd65c", "#7cf36b", "#c08bff", "#ff9f45"];

export class DungeonRoom extends Room<{ state: DungeonState }> {
  maxClients = 4;

  private map!: LoadedMap;
  private inputs = new Map<string, InputState>();
  private colorIndex = 0;

  onCreate() {
    this.state = new DungeonState();

    // One random seed per room drives the whole layout. Stored in state so the
    // exact dungeon is reproducible and (later) shareable by code.
    this.state.seed = (Math.random() * 0x100000000) >>> 0;
    this.map = loadMap(this.state.seed);

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

    // Fixed-step authoritative simulation. The callback receives delta in ms.
    this.setSimulationInterval((deltaMs) => this.update(deltaMs));

    console.log("DungeonRoom created:", this.roomId);
  }

  onJoin(client: Client, options: { name?: string } = {}) {
    const player = new Player();
    const spawn = this.map.spawns[this.clients.length % this.map.spawns.length];
    player.x = spawn.x;
    player.y = spawn.y;
    player.color = COLORS[this.colorIndex % COLORS.length];
    this.colorIndex++;
    player.name = (options.name && options.name.trim().slice(0, 16)) || `Hero ${this.clients.length}`;

    this.state.players.set(client.sessionId, player);
    this.inputs.set(client.sessionId, { up: false, down: false, left: false, right: false });

    // Send the map to this client (server is the source of truth for geometry).
    client.send("map", { tile: this.map.tile, width: this.map.width, height: this.map.height, grid: this.map.grid });

    console.log(`${player.name} joined (${client.sessionId}). Players: ${this.clients.length}`);
  }

  onLeave(client: Client) {
    this.state.players.delete(client.sessionId);
    this.inputs.delete(client.sessionId);
    console.log(`Left: ${client.sessionId}. Players: ${this.clients.length}`);
  }

  private update(deltaMs: number) {
    const dt = deltaMs / 1000;
    this.state.players.forEach((player, sessionId) => {
      const input = this.inputs.get(sessionId);
      if (!input) return;

      let dx = (input.right ? 1 : 0) - (input.left ? 1 : 0);
      let dy = (input.down ? 1 : 0) - (input.up ? 1 : 0);
      if (dx === 0 && dy === 0) return;

      // normalize diagonals so they aren't faster
      if (dx !== 0 && dy !== 0) {
        const inv = Math.SQRT1_2;
        dx *= inv;
        dy *= inv;
      }

      const nextX = player.x + dx * PLAYER_SPEED * dt;
      const nextY = player.y + dy * PLAYER_SPEED * dt;

      // Axis-separated collision check gives smooth wall-sliding.
      if (!this.collides(nextX, player.y)) player.x = nextX;
      if (!this.collides(player.x, nextY)) player.y = nextY;
    });
  }

  /** True if a player-sized box centered at (x, y) overlaps any wall tile. */
  private collides(x: number, y: number): boolean {
    const r = PLAYER_RADIUS;
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
