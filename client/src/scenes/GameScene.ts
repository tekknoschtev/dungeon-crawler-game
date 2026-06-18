import Phaser from "phaser";
import { Room, getStateCallbacks } from "@colyseus/sdk";
import { VIEW_W, VIEW_H, TILE } from "../config";
import { MoveIntent, MOVE_INTENT_KEY } from "./UIScene";

// Tiny Dungeon art (Kenney, CC0). The packed sheet is 16x16 tiles, 12 columns,
// no spacing, so a tile's frame index = row * 12 + column. See ATTRIBUTION.md.
const TILES_KEY = "tiles";
const TILE_SRC = 16; // source tile size in px (we scale up to the world TILE)
const FRAME_FLOOR = 48; // plain stone floor (flat; seeded variation comes later)
const FRAME_VOID = 0; // brown "rock/void" behind walls (deep interior)
const FRAME_HERO = 96; // armored knight; tinted per player to tell heroes apart

// Pseudo-2.5D wall autotiling. Lifted directly from Kenney's own Tiny Dungeon
// sample map (Tiled/sampleMap.tmx): for each wall tile we look at which of its
// 4 orthogonal neighbors are FLOOR and pick the brick face/edge/corner tile
// Kenney used for that situation — giving angled walls with brick fronts, dark
// framing, skinny side walls, and brown rock receding behind. No flips needed.
// Neighbor bitmask: North=8, East=4, South=2, West=1.
const N = 8, E = 4, S = 2, W = 1;
const WALL_AUTOTILE: Record<number, number> = {
  [W]: 15, //               floor west  → right-facing edge
  [S]: 40, //               floor south → full brick FACE (front)
  [S | W]: 57, //           floor S+W   → bottom-left corner
  [E]: 13, //               floor east  → left-facing edge
  [E | W]: 58, //           floor E+W   → skinny vertical wall
  [E | S]: 59, //           floor E+S   → bottom-right corner
  [E | S | W]: 30, //       floor on 3 sides (open north)
  [N]: 26, //               floor north → back/top edge
  [N | W]: 4, //            floor N+W   → top-left corner
  [N | E]: 5, //            floor N+E   → top-right corner
  // Thin walls and stubs (floor to the north): use the framed back-edge tile so
  // they get a dark top border instead of a bare, frameless brick face. (Kenney's
  // own flat-top #37 / notched pillar #41 read as stairs/crenellations here.)
  [N | S]: 26, //           floor N+S   → thin horizontal wall
  [N | S | W]: 26,
  [N | E | W]: 26,
  [N | E | S]: 26,
  [N | E | S | W]: 26,
};

// Inner (concave) corners: a wall with no orthogonal floor but floor on a
// diagonal still needs brick wrapping that corner, else it shows a void notch.
// Diagonal bitmask: NW=8, NE=4, SE=2, SW=1 (from Kenney's sample map).
const DNW = 8, DNE = 4, DSE = 2, DSW = 1;
const WALL_INNER_CORNER: Record<number, number> = {
  [DNW]: 27,
  [DNE]: 25,
  [DSE]: 13,
  [DSW]: 15,
  [DSE | DSW]: 18,
};

// A soft shadow strip grounds the floor directly south of a wall.
const WALL_SHADOW_COLOR = 0x000000;
const WALL_SHADOW_ALPHA = 0.32;
const WALL_SHADOW_H = 5; // px (in source/world tile space)

// Camera zoom so native 16px tiles render at a chunky-but-roomy size (≈32px
// on screen). The world is much larger than the viewport, so the camera
// follows the local hero.
const CAMERA_ZOOM = 2;
const CAMERA_LERP = 0.12; // how snappily the camera catches up to the hero

// Name labels live in world space but are counter-scaled by 1/zoom so they
// render at their native pixel size (crisp) instead of being magnified 3x.
const LABEL_OFFSET = 10; // world px above the hero's center

// World tiles/hero sit low; HUD (status text) sits on top.
const HUD_DEPTH = 1000;

/** Shape of a player as decoded on the client (mirrors the server schema). */
interface PlayerView {
  x: number;
  y: number;
  name: string;
  color: string;
}

interface MapMessage {
  tile: number;
  width: number;
  height: number;
  grid: number[][];
}

/** Per-player visual entity on the client. */
interface Entity {
  sprite: Phaser.GameObjects.Image;
  label: Phaser.GameObjects.Text;
  target: { x: number; y: number };
}

interface InputState {
  up: boolean;
  down: boolean;
  left: boolean;
  right: boolean;
}

export class GameScene extends Phaser.Scene {
  private room?: Room;
  private entities = new Map<string, Entity>();

  private mapLayer!: Phaser.GameObjects.Container;
  private statusText!: Phaser.GameObjects.Text;

  private keys!: {
    up: Phaser.Input.Keyboard.Key;
    down: Phaser.Input.Keyboard.Key;
    left: Phaser.Input.Keyboard.Key;
    right: Phaser.Input.Keyboard.Key;
    w: Phaser.Input.Keyboard.Key;
    a: Phaser.Input.Keyboard.Key;
    s: Phaser.Input.Keyboard.Key;
    d: Phaser.Input.Keyboard.Key;
  };
  private lastSent: InputState = { up: false, down: false, left: false, right: false };

  constructor() {
    super("game");
  }

  preload() {
    this.load.spritesheet(TILES_KEY, "/assets/tiny-dungeon/tilemap_packed.png", {
      frameWidth: TILE_SRC,
      frameHeight: TILE_SRC,
    });
  }

  create() {
    this.mapLayer = this.add.container(0, 0).setDepth(0);

    this.statusText = this.add
      .text(VIEW_W / 2, VIEW_H / 2, "Connecting…", {
        fontFamily: "monospace",
        fontSize: "16px",
        color: "#8a91a3",
      })
      .setOrigin(0.5)
      .setScrollFactor(0) // HUD: pinned to the screen, not the world
      .setDepth(HUD_DEPTH);
    this.centerStatus();

    // The canvas fills the window, so re-center the HUD on resize.
    this.scale.on(Phaser.Scale.Events.RESIZE, this.onResize, this);

    const kb = this.input.keyboard!;
    this.keys = {
      up: kb.addKey(Phaser.Input.Keyboard.KeyCodes.UP),
      down: kb.addKey(Phaser.Input.Keyboard.KeyCodes.DOWN),
      left: kb.addKey(Phaser.Input.Keyboard.KeyCodes.LEFT),
      right: kb.addKey(Phaser.Input.Keyboard.KeyCodes.RIGHT),
      w: kb.addKey(Phaser.Input.Keyboard.KeyCodes.W),
      a: kb.addKey(Phaser.Input.Keyboard.KeyCodes.A),
      s: kb.addKey(Phaser.Input.Keyboard.KeyCodes.S),
      d: kb.addKey(Phaser.Input.Keyboard.KeyCodes.D),
    };

    // Parallel scene that feeds touch movement into the registry (mobile).
    this.scene.launch("ui");

    this.setupRoom();
  }

  /**
   * Render the room the lobby already connected (stashed in the registry). The
   * lobby owns matchmaking (create / join-by-code); this scene just renders the
   * resulting room's state.
   */
  private setupRoom() {
    const room = this.registry.get("room") as Room | undefined;
    if (!room) {
      this.statusText.setText("No room to join.\nReload to return to the menu.");
      this.statusText.setAlign("center");
      return;
    }
    this.room = room;
    this.statusText.setVisible(false);

    this.room.onMessage<MapMessage>("map", (data) => this.buildMap(data));

    const $ = getStateCallbacks(this.room);
    const players = $(this.room.state as { players: Map<string, PlayerView> }).players;

    players.onAdd((player: PlayerView, sessionId: string) => {
      this.addEntity(player, sessionId, sessionId === this.room!.sessionId);
      $(player).onChange(() => {
        const e = this.entities.get(sessionId);
        if (e) {
          e.target.x = player.x;
          e.target.y = player.y;
        }
      });
    });

    players.onRemove((_player: PlayerView, sessionId: string) => {
      const e = this.entities.get(sessionId);
      if (e) {
        e.sprite.destroy();
        e.label.destroy();
        this.entities.delete(sessionId);
      }
    });

    this.room.onError((code, message) => {
      console.error("Room error:", code, message);
    });

    this.room.onLeave(() => {
      this.statusText.setText("Disconnected.\nReload to rejoin.");
      this.statusText.setAlign("center").setVisible(true);
    });

    // Now that the map handler (and the rest) are wired, ask the server for the
    // map. Doing this here — after boot — avoids missing the one-time payload.
    this.room.send("ready");
  }

  private addEntity(player: PlayerView, sessionId: string, isLocal: boolean) {
    const colorNum = Phaser.Display.Color.HexStringToColor(player.color).color;

    const sprite = this.add
      .image(player.x, player.y, TILES_KEY, FRAME_HERO)
      .setDisplaySize(TILE, TILE)
      .setTint(colorNum)
      .setDepth(10);

    const label = this.add
      .text(player.x, player.y - LABEL_OFFSET, player.name, {
        fontFamily: "monospace",
        fontSize: "11px",
        color: isLocal ? "#ffe066" : "#d7dbe6",
      })
      .setOrigin(0.5, 1)
      .setScale(1 / CAMERA_ZOOM)
      .setDepth(20);

    this.entities.set(sessionId, {
      sprite,
      label,
      target: { x: player.x, y: player.y },
    });

    // The camera follows the local hero through the world.
    if (isLocal) {
      const cam = this.cameras.main;
      cam.setZoom(CAMERA_ZOOM);
      cam.startFollow(sprite, true, CAMERA_LERP, CAMERA_LERP);
      this.centerStatus(); // zoom changed; keep the HUD text crisp + centered
    }
  }

  private onResize() {
    this.centerStatus();
  }

  /** Keep the status/HUD text centered and at native size despite camera zoom. */
  private centerStatus() {
    const cam = this.cameras.main;
    this.statusText.setPosition(cam.width / 2, cam.height / 2).setScale(1 / cam.zoom);
  }

  private buildMap(data: MapMessage) {
    this.mapLayer.removeAll(true);
    const t = data.tile;

    const worldW = data.width * t;
    const worldH = data.height * t;

    // The world is bigger than the viewport now; bound the camera to it so it
    // never scrolls past the dungeon edges.
    this.cameras.main.setBounds(0, 0, worldW, worldH);

    const grid = data.grid;
    const isWall = (gx: number, gy: number) =>
      gx < 0 || gy < 0 || gx >= data.width || gy >= data.height || grid[gy][gx] === 1;

    for (let y = 0; y < data.height; y++) {
      for (let x = 0; x < data.width; x++) {
        if (!isWall(x, y)) {
          // Floor.
          this.addCell(x * t, y * t, t, FRAME_FLOOR);
          // Shadow the floor just south of a wall, so walls feel like they have height.
          if (isWall(x, y - 1)) {
            const shadow = this.add
              .rectangle(x * t, y * t, t, WALL_SHADOW_H, WALL_SHADOW_COLOR, WALL_SHADOW_ALPHA)
              .setOrigin(0);
            this.mapLayer.add(shadow);
          }
          continue;
        }

        // Wall: pick the brick face/edge/corner tile from Kenney's autotile by
        // which orthogonal neighbors are floor.
        const mask =
          (isWall(x, y - 1) ? 0 : N) |
          (isWall(x + 1, y) ? 0 : E) |
          (isWall(x, y + 1) ? 0 : S) |
          (isWall(x - 1, y) ? 0 : W);
        let frame: number;
        if (mask !== 0) {
          frame = WALL_AUTOTILE[mask];
        } else {
          // No orthogonal floor: a concave corner (floor only on a diagonal)
          // gets a wrapped brick tile; otherwise it's deep rock = brown void.
          const diag =
            (isWall(x - 1, y - 1) ? 0 : DNW) |
            (isWall(x + 1, y - 1) ? 0 : DNE) |
            (isWall(x + 1, y + 1) ? 0 : DSE) |
            (isWall(x - 1, y + 1) ? 0 : DSW);
          frame = WALL_INNER_CORNER[diag] ?? FRAME_VOID;
        }
        this.addCell(x * t, y * t, t, frame);
      }
    }
  }

  /** Add one map tile image to the map layer and return it. */
  private addCell(px: number, py: number, t: number, frame: number) {
    const cell = this.add
      .image(px, py, TILES_KEY, frame)
      .setOrigin(0)
      .setDisplaySize(t, t);
    this.mapLayer.add(cell);
    return cell;
  }

  update(_time: number, delta: number) {
    this.sendInput();

    // Smoothly interpolate every entity toward its authoritative position.
    // Frame-rate independent lerp factor.
    const k = 1 - Math.pow(0.001, delta / 1000);
    this.entities.forEach((e) => {
      e.sprite.x = Phaser.Math.Linear(e.sprite.x, e.target.x, k);
      e.sprite.y = Phaser.Math.Linear(e.sprite.y, e.target.y, k);
      e.label.x = e.sprite.x;
      e.label.y = e.sprite.y - LABEL_OFFSET;
    });
  }

  private sendInput() {
    if (!this.room) return;
    // Touch joystick intent (from UIScene) is OR'd with the keyboard so either
    // input source can drive the hero.
    const move = this.registry.get(MOVE_INTENT_KEY) as MoveIntent | undefined;
    const state: InputState = {
      up: this.keys.up.isDown || this.keys.w.isDown || !!move?.up,
      down: this.keys.down.isDown || this.keys.s.isDown || !!move?.down,
      left: this.keys.left.isDown || this.keys.a.isDown || !!move?.left,
      right: this.keys.right.isDown || this.keys.d.isDown || !!move?.right,
    };
    const last = this.lastSent;
    if (
      state.up !== last.up ||
      state.down !== last.down ||
      state.left !== last.left ||
      state.right !== last.right
    ) {
      this.room.send("input", state);
      this.lastSent = state;
    }
  }
}
