// The server endpoint. Override at build/deploy time with VITE_SERVER_URL.
// Otherwise we connect to the Colyseus server on the SAME host the page was
// loaded from (port 2567) — so it works whether you open the game on this
// machine (localhost) or from another computer on the LAN (e.g. 192.168.x.x).
export const SERVER_URL =
  (import.meta.env.VITE_SERVER_URL as string | undefined) ??
  `ws://${location.hostname || "localhost"}:2567`;

export const ROOM_NAME = "dungeon";
export const ROOM_NAME_PUBLIC = "dungeon-public";

// Must match the server's TILE constant (native art tile size). The grid
// itself is sent by the server; this is used to size the hero sprite.
export const TILE = 16;

// Logical canvas size, independent of TILE. Scale.FIT stretches this to the
// window, and the camera zooms in (see GameScene CAMERA_ZOOM) so 16px tiles
// read at a chunky size while the world stays larger than the viewport.
export const VIEW_W = 800;
export const VIEW_H = 608;
