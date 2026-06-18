import { startLobby } from "./lobby";

// The lobby renders the create/join menu, connects to a room, then boots the
// Phaser game (see lobby.ts). The game scenes pick the connected room up from
// the registry.
startLobby();
