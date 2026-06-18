# Claude Code Handoff — Milestone 2: "A dark dungeon you explore"

**How to use this:** open Claude Code in the project root
(`dungeon-crawler-game/`) and paste this whole file as your prompt, or keep it
in the repo and say "implement HANDOFF_M2.md, phase 1." Work one phase at a
time and stop for me to look after each.

---

## Project snapshot (read `CLAUDE.md` first)

A co-op, top-down, real-time dungeon crawler that runs in the browser. Loot is
a core long-term goal. Single-player = joining a room alone.

- **Client:** Phaser 3.90 + TypeScript + Vite (`client/`)
- **Server:** Colyseus 0.17 authoritative server + TypeScript (`server/`)
- **Authoritative-server rule (non-negotiable):** the server owns all game
  truth (positions, geometry, later combat/loot). Clients send *input*; the
  server simulates in `DungeonRoom.update()` and broadcasts state; the client
  renders and interpolates. Do not move gameplay decisions to the client.
- **Version pin (do not break):** server uses `colyseus` 0.17 / `@colyseus/schema` 4;
  client uses **`@colyseus/sdk`** 0.17 (NOT the old `colyseus.js`, which is 0.16
  and incompatible with a 0.17 server).
- **Run:** `npm run dev` (server :2567 + client :5173). Open a second tab to test co-op.

Key files you'll touch:
- `server/src/rooms/map.ts` — the dungeon grid (currently a hand-made room)
- `server/src/rooms/DungeonRoom.ts` — join/leave, input, movement sim, sends the `"map"` message
- `server/src/rooms/schema/DungeonState.ts` — networked state
- `client/src/scenes/GameScene.ts` — connect, render map, render+interpolate players, input, `makeTextures()` (placeholder art to be replaced)
- `ATTRIBUTION.md` — log every asset you add

---

## The aesthetic target

Dark and gritty, NOT bright and cheery. The reference look: a deep indigo/violet
ambient, a floor grid you can barely make out in the dark, a soft glow hugging
the player, near-black at the edges of vision, and bright **additive** glows on
light sources and loot (e.g. a cyan crystal throwing sparkle).

**Critical:** we are NOT swapping to darker assets. We keep the **Tiny Dungeon**
pack the user likes and make it dark through *rendering* — ambient darkening,
cool tint, a vision/light radius around the player, a vignette, and additive
glow sprites. Brightness is a lighting choice, not a property of the sprites.

The Tiny Dungeon pack (Kenney, **CC0**) was downloaded by the user into the
project's main folder, likely still zipped. Your first job is to locate and
inspect it — do not assume filenames or grid layout.

---

## Phase 1 — Real tiles + a real hero (still bright; just swap the art)

1. Find the Tiny Dungeon archive in the project folder; if zipped, extract it
   (e.g. into `assets-src/tiny-dungeon/`, which should be gitignored).
2. **Inspect it** — list files, open the tilemap PNG, determine the tile pixel
   size (Kenney Tiny Dungeon is 16×16) and which tile indices are floor, wall,
   a player/hero, and a few monster/item tiles. Note them.
3. Copy the needed image(s) into `client/public/assets/tiny-dungeon/` (Vite
   serves `public/` at the web root).
4. In `GameScene`, load the tilemap as a spritesheet (16×16 frames) and replace
   the placeholder `floor`/`wall`/`hero` textures from `makeTextures()` with
   real frames. Keep `makeTextures()` only for things with no art yet (e.g. the
   local-player ring).
5. Pick a Tiny Dungeon character frame for the hero. (Per-player color tinting
   can stay for now to tell heroes apart; we can switch to distinct character
   frames later.)
6. Log the pack in `ATTRIBUTION.md` (CC0, Kenney, source URL, what it's used for).

**Acceptance:** the room renders with real Tiny Dungeon tiles and a real hero
sprite; co-op still works in two tabs. It will look bright — that's expected,
we fix it in Phase 3.

**Checkpoint — stop and let the user look.**

---

## Phase 2 — Camera + a bigger, seeded world to explore

1. **Server:** replace the single hand-made room in `map.ts` with a larger
   layout that has multiple rooms connected by corridors (doorway gaps in
   walls), so there are hallways and rooms to discover. A simple **seeded**
   room-and-corridor generator is ideal (place N non-overlapping rectangular
   rooms, connect them with L-shaped corridors). Use a seedable PRNG (e.g.
   mulberry32) — do not pull in a heavy dependency.
2. Store the **seed** in `DungeonState` (`@type("number") seed`) and generate the
   map from it on `onCreate`, so every client in the room gets the same dungeon.
   Keep sending the resolved grid to clients via the existing `"map"` message
   (clients stay dumb about generation). Make spawn points land on floor inside
   a room.
3. **Client:** the world is now bigger than the viewport. Set camera world
   bounds to the map size and `startFollow` the **local** player's sprite with a
   little lerp. Use a zoom (~2.5–3×) so 16px tiles read at a chunky, readable
   size; `pixelArt: true` is already set, keep rounding crisp.
4. Make sure remote players still render/interpolate correctly when off-screen
   and as they enter view.

**Acceptance:** you spawn in a room, walk through a corridor into another room,
the camera follows you, and you can't see the whole dungeon at once. Two players
in the same room see the same layout.

**Checkpoint — stop and let the user look.**

---

## Phase 3 — Darkness + vision (the gritty mood)

Implement a vision/lighting layer. Recommended approach (no normal maps needed,
predictable results):

1. A full-screen **darkness overlay** at high depth, scrolled with the camera /
   drawn in screen space, filled near-black with a cool tint (deep indigo, e.g.
   around `#0c0a1e`–`#16123a`).
2. Punch a **soft light hole** around the player: render a radial-gradient
   "light" texture into the overlay using an ERASE/destination-out blend (a
   `RenderTexture` works well — fill it dark each frame, then `erase` the radial
   light at the player's screen position). The result is a soft circle of
   visibility that follows the player = fog-of-war + mood in one.
3. Add a subtle **cool ambient tint** to the world (tiles read as silhouettes
   lit by the player), and a **vignette** so screen edges fall to black.
4. Expose the light radius / darkness strength as tunable constants so the user
   can dial the exact feel.

(Alternative if you prefer engine lighting: Phaser's Light2D pipeline with a low
ambient and a point light on the player. Without normal maps it just modulates
brightness by distance, which is acceptable for top-down. The overlay approach
above gives finer art-directed control, so prefer it unless it fights you.)

**Acceptance:** the scene reads dark and moody — faint visible grid, a soft lit
area around the hero, near-black beyond it, edges vignetted. Matches the dark
reference vibe.

**Checkpoint — stop and let the user look.**

---

## Phase 4 — Glow accents (light sources / a teaser loot crystal)

1. Add a soft round **glow** texture used with additive blend
   (`setBlendMode(Phaser.BlendModes.ADD)`).
2. Place a couple of light sources in the world (e.g. torch positions, or a
   single glowing **loot crystal** like the cyan one in the reference) — for now
   these can be decorative, defined in the map/room state. A small particle
   emitter for sparkle is a nice touch.
3. Light sources should also carve a little visibility into the darkness overlay
   (same erase technique, smaller radius) so they glow *through* the dark.

**Acceptance:** at least one atmospheric glowing object visible in the dark,
selling the mood. This sets up real loot drops in a later milestone.

**Checkpoint — done with M2.**

---

## Hard constraints (apply to every phase)

- Keep the **server authoritative**; rendering/lighting is client-only and must
  not change gameplay truth.
- Do **not** reintroduce `colyseus.js` or let server/client Colyseus versions
  drift apart.
- Every asset added → an entry in `ATTRIBUTION.md` (CC0 still gets logged).
- Keep new synced `@type` state minimal (bandwidth per tick).
- TypeScript strict; run `npm --prefix client run build` and the server
  typecheck before declaring a phase done.
- Stop at each checkpoint instead of barreling through all four phases.

## Out of scope for M2 (don't build these yet)

- Create/join-by-code lobby and the entry screen → that's **M3** (the seed added
  in Phase 2 is the forward-compat hook for it).
- Mobs, combat, real loot pickup/inventory, multiple floors → later milestones.
