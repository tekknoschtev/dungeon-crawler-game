import { Server, WebSocketTransport } from "colyseus";
import { DungeonRoom } from "./rooms/DungeonRoom";

const PORT = Number(process.env.PORT) || 2567;

const gameServer = new Server({
  transport: new WebSocketTransport(),
});

// Register our room under the name the client joins ("dungeon").
gameServer.define("dungeon", DungeonRoom);

gameServer.listen(PORT);
console.log(`⚔️  Dungeon server listening on ws://localhost:${PORT}`);
