import path from "path";
import express from "express";
import { Server, WebSocketTransport } from "colyseus";
import { DungeonRoom } from "./rooms/DungeonRoom";

const PORT = Number(process.env.PORT) || 2567;

// In production the server also serves the built Phaser client, so the whole
// game lives behind one origin / one port — which is what the Cloudflare tunnel
// fronts (HTTP for the page + WebSocket upgrade for Colyseus, same host).
// Compiled to server/dist/index.js, so the client build is two levels up.
// In dev the client runs under Vite (:5173) and this folder simply won't exist,
// which is harmless — express.static just 404s and the page is loaded from Vite.
const clientDist = path.resolve(__dirname, "../../client/dist");

const gameServer = new Server({
  transport: new WebSocketTransport(),
  // Colyseus runs this on its own Express app *before* it binds the /matchmake
  // routes, so static files and matchmaking coexist (static misses fall through
  // to next()). No catch-all route: the client is a single page at "/" and
  // carries the room code in ?room=, so there are no client-side paths to
  // rewrite — and a catch-all would shadow /matchmake.
  express: (app) => {
    app.use(express.static(clientDist));
  },
});

// Register our room under the name the client joins ("dungeon").
// filterBy(["code"]) makes matchmaking route `client.join("dungeon", { code })`
// to the room that was created with that exact code.
// maxRooms is a valid Colyseus runtime option but absent from the 0.17 TS types
gameServer.define("dungeon", DungeonRoom, { maxRooms: 100 } as { code?: string }).filterBy(["code"]);

gameServer.listen(PORT);
console.log(`⚔️  Dungeon server listening on :${PORT} (serving client from ${clientDist})`);
