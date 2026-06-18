import { Server, WebSocketTransport } from "colyseus";
import { DungeonRoom } from "./rooms/DungeonRoom";

const PORT = Number(process.env.PORT) || 2567;

const gameServer = new Server({
  transport: new WebSocketTransport(),
});

// Register our room under the name the client joins ("dungeon").
// filterBy(["code"]) makes matchmaking route `client.join("dungeon", { code })`
// to the room that was created with that exact code.
gameServer.define("dungeon", DungeonRoom).filterBy(["code"]);

gameServer.listen(PORT);
console.log(`⚔️  Dungeon server listening on ws://localhost:${PORT}`);
