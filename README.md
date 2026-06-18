# Dungeon Crawler (working title)

A co-op, top-down, real-time dungeon crawler. The whole thing runs in the
browser — easy to share with a link, plays on a phone, no installer.

**Stack**

- **Client:** Phaser 3.90 + TypeScript + Vite
- **Server:** Colyseus 0.17 (authoritative multiplayer) + TypeScript
- The **server is the source of truth** for movement, geometry, and (later)
  combat and loot. Clients send input; the server simulates and broadcasts
  state; clients render and interpolate.

---

## Quick start (first time)

You need **Node.js 18+** installed. From this folder:

```bash
npm run setup     # installs root + server + client dependencies
npm run dev       # starts BOTH the server and the client together
```

Then open **http://localhost:5173** in your browser.
To test co-op, open a **second tab** (or another browser) at the same URL —
you'll see a second hero appear, and you'll both move around the same room in
real time.

Controls: **WASD** or **arrow keys** to move. Your hero has a yellow ring.

> Prefer two terminals? Run `npm run dev:server` in one and
> `npm run dev:client` in another.

---

## What's in here

```
dungeon-crawler-game/
├── server/                 Colyseus authoritative server
│   └── src/
│       ├── index.ts            boots the server on :2567
│       └── rooms/
│           ├── DungeonRoom.ts  join/leave, input, movement simulation
│           ├── map.ts          the dungeon grid (source of truth)
│           └── schema/
│               └── DungeonState.ts   networked state (players)
├── client/                 Phaser browser client
│   └── src/
│       ├── main.ts             Phaser game bootstrap
│       ├── config.ts           server URL, tile size, etc.
│       └── scenes/
│           └── GameScene.ts    connect, render map, render+interpolate players, input
├── ATTRIBUTION.md          asset credits (kept current as we add art)
├── CLAUDE.md               context for Claude Code sessions
└── package.json            setup / dev / build scripts
```

---

## Milestone status

- [x] **M1 — Co-op skeleton.** Two+ players join a shared room and move around
      with synced, server-authoritative positions and wall collision.
      *(Placeholder geometric art — real sprites land in M2.)*
- [ ] **M2 — Looks like a dungeon.** Drop in CC0 tile/character art, a proper
      tilemap, hero facing/animation, camera follow for bigger rooms.
- [ ] **M3 — Mobs + combat.** First enemy type, attacks, HP, death/respawn.
- [ ] **M4 — Loot.** Drops, pickups, a shared/own inventory, rarity tiers.
- [ ] **M5 — Floors.** Multiple levels, a stairs/exit, simple progression.

See `CLAUDE.md` for conventions and the working backlog.

---

## Deploying later

- **Client** is a static site (`npm --prefix client run build` → `client/dist`).
  Host it anywhere (itch.io, Netlify, GitHub Pages). Set `VITE_SERVER_URL` at
  build time to point at your deployed server (use `wss://` in production).
- **Server** is a normal Node process (`npm --prefix server run build` then
  `node server/dist/index.js`). Colyseus has guides for hosting it.
