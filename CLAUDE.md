# CLAUDE.md — project context for Claude Code

This is a **co-op, top-down, real-time dungeon crawler** that runs in the
browser. Lots of loot is a core design goal. Single-player works by simply
joining a room alone.

## Architecture (read before changing networking)

- **Authoritative server.** The Colyseus server (`server/`) owns all game
  truth: positions, map geometry, and — in future milestones — mobs, combat,
  and loot. Never trust client-sent positions; clients send *intent* (input),
  the server simulates and broadcasts state.
- **Client = render + input** (`client/`, Phaser). It renders server state and
  interpolates between snapshots for smoothness. It must not make gameplay
  decisions the server should own.
- **State sync** uses `@colyseus/schema`. Synced fields are declared with
  `@type(...)` in `server/src/rooms/schema/`. The client decodes via
  `getStateCallbacks` (`@colyseus/sdk`). Server and client schema versions must
  stay compatible.
- **Map is server-sent.** The grid lives in `server/src/rooms/map.ts` and is
  pushed to clients via a `"map"` message — the client never hard-codes level
  geometry.

## Pinned versions (don't drift these apart)

- Server: `colyseus` 0.17.x, `@colyseus/schema` 4.x
- Client: `@colyseus/sdk` 0.17.x  ← **must match the server's 0.17 line.**
  (The old `colyseus.js` package tops out at 0.16 and is NOT compatible.)
- `phaser` 3.90.x, `vite`, `typescript`

## Conventions

- TypeScript everywhere, `strict` on.
- Keep new synced state minimal — every `@type` field costs bandwidth each tick.
- Movement/physics belongs in the server simulation loop
  (`DungeonRoom.update()`), not the client.
- Placeholder art is generated in code (`GameScene.makeTextures()`); real
  assets go in `client/public/` and get logged in `ATTRIBUTION.md`.
- Assets must be CC0 or otherwise license-compatible; log every one.

## How to run

```bash
npm run setup   # once
npm run dev     # server (:2567) + client (:5173) together
```

## Backlog (next milestones)

- **M2 — art pass:** swap placeholder shapes for CC0 tiles/characters
  (Kenney), real tilemap, hero facing + walk animation, camera follow.
- **M3 — combat:** one mob type with server-side AI, melee attack, HP,
  death/respawn.
- **M4 — loot:** drops on the floor as state, pickup, inventory, rarity tiers.
- **M5 — floors:** multiple levels + a stairs transition.

When implementing combat and loot, extend `DungeonState` with new schema
collections (e.g. `mobs`, `loot`) and drive them from the server simulation.

## QOL / polish backlog

Surfaced from real co-op playtesting (the game is live and working). Grouped by
where the work mostly lives. Tuning lives in `server/src/rooms/tuning.ts`;
client-only items are pure render/UX and need no new synced state.

- **Join/leave toasts** (client) — toast-style message when a player joins or
  leaves. Drive off the existing `players` MapSchema add/remove callbacks; no
  new server state needed.
- **Mob attack telegraph** (client) — a visual when mobs are attacking (wind-up
  flash / lunge). Server already knows attack timing; surface it to the client
  rather than re-deriving on the client.
- **Hero appearance select** (client + a little server) — pick hero color and/or
  sprite at the lobby. Color can be a synced `@type` on the player; multiple
  hero images depend on the M2 art pass having more than one hero frame.
- **Sound effects** (client) — hits, pickups, level/door events. CC0/license-
  compatible only, logged in `ATTRIBUTION.md` like all assets.
- **Floor variation** (client) — debris / texture variation so floors aren't
  flat. Decorative only; keep it client-side, don't bloat the synced map.
- **Closeable doors** (server) — doors that can be shut to make a safe space to
  recover/pause. Real gameplay + map state — server-authoritative; extend the
  map/door state and simulation.
- **Passive health regen** (server, `tuning.ts`) — slow HP increase over time.
- **Loot drop rebalance** (server, `tuning.ts`) — raise potion drop rate; lower
  attack/defense buff drop rate but increase their effect and/or duration.
