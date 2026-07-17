# Roadmap — Arcade Co-op Dive

The **single source of truth** for what's built and what's next: milestones,
locked design decisions, and the categorized backlog. Update *this* file when
scope changes. (Supersedes the old milestone list in `CLAUDE.md`, the scratch
notes that used to live in this file, and the out-of-repo design plan.)

Ops/hosting lives separately in [`deploy.md`](deploy.md).

## North star

Mobile-first, drop-in **co-op dive**. The loop:

> **Staying** on a floor floods you with targets — mob pressure ramps with
> *time on the floor* and resets on descend. **Descending** raises a score
> *multiplier* on points you *earn* (deeper = deadlier, so racing down with
> nothing banked is self-defeating). A time-gated **vault chest** rewards
> lingering with depth-scaled mega-points + a heal/buff + a flavor **relic**. A
> **party wipe** ends the run → score screen → restart fresh at floor 1.

## Locked design decisions

- **Arcade** — no login wall, no accounts, no PII, no auth to manage. A run *is*
  the session; restart = fresh floor 1. *Refined 2026-07-17:* this guards
  drop-in friction and ops burden, not memory itself — persistence up to
  **local browser storage** (bests/codex) and **anonymous claimed-nickname
  scores** (a daily-seed leaderboard DB with nothing sensitive in it) is in
  bounds. Cross-device profiles / logins / meta-progression stay out.
- **Mobile-first** — the HUD stays minimal. No inventory, no loadout screens, no new buttons (protect the uncluttered HUD).
- **No "clear the floor."** Pressure ramps with time-on-floor and resets on descend; you choose when to leave.
- **Loot stays immediate-use**, with a score tally layered on top. The "collect / stash / deploy weapons" inventory idea was dropped (clashes with mobile minimalism).
- **Depth multiplies points *earned*, never awarded for arriving** — that's what makes racing self-correct.
- **Respawns** — click-to-respawn after a ramping unlock delay (burns a life), *or* a teammate revives you with a heal potion (contextual, no new button, free). Lives are a run resource: start 3, cap 6, **+1 per descent**. Whole party down with no lives → game over.
- **Chest** — reward scales with depth: mega-points (party-split, un-banked) + heal/long buff + a named relic (flavor only, score-screen trophy) for the opener.
- **Floors** — target ~2–3 min each; structural variety comes from generator knobs, no new art.

## Shipped

| Milestone | What | PR |
|---|---|---|
| **M1** | Descent spine + pressure ramp | [#10](https://github.com/tekknoschtev/dungeon-crawler-game/pull/10) |
| **M2** | Run stakes — downed / self-respawn / revive / lives / wipe / restart | [#11](https://github.com/tekknoschtev/dungeon-crawler-game/pull/11) |
| **M3** | Scoring + score screen — heat multiplier, bank-on-descend, per-player table | [#12](https://github.com/tekknoschtev/dungeon-crawler-game/pull/12) |
| **M4** | Vault chest + named relics — timed door, party points + opener heal/buff/relic | [#13](https://github.com/tekknoschtev/dungeon-crawler-game/pull/13) |
| **M5** | Mob variety — depth-gated bestiary; per-kind stats feed pressure + scoring | [#15](https://github.com/tekknoschtev/dungeon-crawler-game/pull/15) |
| **M6** | Breakable crates + vault key — smash crates for loot/score; guaranteed key per floor instantly unlocks the vault | [#18](https://github.com/tekknoschtev/dungeon-crawler-game/pull/18), [#21](https://github.com/tekknoschtev/dungeon-crawler-game/pull/21) |
| **M7** | Floor variety — three named archetypes (warren/standard/hall) picked per floor from seeded RNG | [#22](https://github.com/tekknoschtev/dungeon-crawler-game/pull/22) |
| **M8** | Quick Play matchmaking — public room pool + share links; lobby shows Quick Play / New Private Room / Join by Code | [#23](https://github.com/tekknoschtev/dungeon-crawler-game/pull/23) |
| **M9** | Spawn lull — a kill holds off the pressure refill (stacking, capped), so routing a cluster quiets the floor; killing *en masse* becomes a relief tactic | [#26](https://github.com/tekknoschtev/dungeon-crawler-game/pull/26) |
| **M10** | Collectible bomb — crate-dropped (rubber-banded deeper); place with E / contextual mobile button → local blast (hurts the placer) + map-wide stun | [#27](https://github.com/tekknoschtev/dungeon-crawler-game/pull/27) |
| **M11** | Exit pulse — channeling the descent wards the ladder (knockback + stagger pulses), so racing to the stairs works *under fire* | [#29](https://github.com/tekknoschtev/dungeon-crawler-game/pull/29) |
| — | Floor-lighting arc — dark floors (hero-light vision bubble), torchlit floors + secrets in the shadows, co-op vision (per-hero tint + downed distress beacon) | [#31](https://github.com/tekknoschtev/dungeon-crawler-game/pull/31), [#32](https://github.com/tekknoschtev/dungeon-crawler-game/pull/32), [#33](https://github.com/tekknoschtev/dungeon-crawler-game/pull/33) |
| — | Mobile HUD placement fix (stat HUD off the touch controls) | [#14](https://github.com/tekknoschtev/dungeon-crawler-game/pull/14) |

Earlier systems already in place (not re-listed as backlog): CC0 art pass
(Kenney Tiny Dungeon) + pseudo-2.5D wall autotiler, camera follow, lobby hero +
color select, floor variation (visual tile variants + collidable furniture
props), death markers, passive HP regen, and the loot rebalance (heals common;
attack/defense rarer but longer/stronger). See the code / `CLAUDE.md` for where
each lives.

## Next

- **Ops — Automate prod deploy** — CI already builds + tests on every push to
  `main` and every PR; extend it to **continuous deployment** so a merge to
  `main` rolls out to the Proxmox / Cloudflare-tunnel box automatically (today's
  manual pull → setup → build → restart loop is in [`deploy.md`](deploy.md);
  mechanism TBD). Bake a version stamp (e.g. git SHA / tag) into the build and
  emit it on server start + as a client-visible value so it's easy to confirm the
  latest build is actually running in prod.

### Engagement arc (M13–M15) — planned 2026-07-17

The theme: depth is currently only a number — nothing marks the journey. These
make descending feel like going *somewhere* and give runs a memory. Build order
M13 → M14 (M14's "NEW" badges hang off M13's panel); M15 is independent.

- **M13 — Run-end discoveries panel.** The score screen becomes the run's
  museum: the relics claimed (they're procedurally-named trophies and nothing
  displays them prominently today), weapons wielded, a bestiary tally of kinds
  slain, floors survived, crates smashed. Server side: accumulate per-player run
  tallies in the existing non-synced `Combat` record (kills by kind, weapons
  held, loot by rarity, chests opened) and ship them **once in the `"gameover"`
  message payload** — no new `@type` state, zero per-tick cost (relics are
  already synced). Client side: score-screen layout work, mobile-first. This
  absorbs the long-deferred **score-screen polish** owner ask.

- **M14 — Local codex + personal bests (client-only).** `localStorage`
  (versioned key, per-browser by design — in bounds per the refined arcade
  rule). Two layers: **bests** (high score, deepest floor, runs played) and a
  **lifetime codex** (weapons ever held, mob kinds ever slain, best relic
  rarity + named-relic collection). Surfaces: a "Best: … · Deepest: floor …"
  line in the lobby, "NEW BEST" flashes on the score screen, and **NEW** badges
  in M13's panel when a run logs a first-ever discovery ("you've never held a
  warhammer" is a descend motivator). No server changes; the minimal in-run HUD
  is untouched — lobby and score screen only.

- **M15 — Depth biomes.** Every ~4–5 floors the dungeon *becomes a different
  place*: new floor/wall/prop art per depth band, layered on the existing
  archetype × lighting axes. **Real alternate tilesets, not tints of the
  current art** (owner call, 2026-07-17). Sourcing direction: Kenney's other
  "Tiny" packs — same 16×16 / 12-column packed-sheet format and flat style as
  Tiny Dungeon; Tiny Town is already shipped (vault key) and has
  grass/dirt/brick terrain, Tiny Battle / Tiny Ski cover sand and snow/ice.
  **Verify before committing to a band list**: the pseudo-2.5D wall autotiler
  needs face/side/shadow roles per biome, and the non-dungeon packs' wall tiles
  may need adaptation — inspect the actual sheets (raw packs live under the
  gitignored `assets-src/`) and pick bands from what the art supports. Server:
  derive biome from depth band in `map.ts`, send it in the `"map"` message
  (exactly like `lighting`); biome may also pick the prop/crate frame set.
  Client: a per-biome frame-map table (role → sheet + frame) feeding the
  existing autotiler. Log every new pack in `ATTRIBUTION.md`. Follow-ons
  (unscheduled): biome-flavored mob-mix nudges, descend flavor text.

## Comeback toolkit — deep-floor relief valves

Playtesting surfaced a death spiral on deep floors (~F10+): mob damage scales
`+10%/floor` (`DEPTH_DAMAGE_SCALE`) against a flat 100 HP, population sits near
the `PRESSURE_TARGET_HARD_CAP` of 30, and `RESPAWN_DELAYS` ramps to 18s while
`heat` keeps climbing — so the first death tends to cascade into a wipe and you
can't thin a room long enough to reach the ladder. The curve itself is *fun*
(short runs, real stakes); what's missing is **burst** — earned tools that let a
skilled/coordinated party manufacture breathing room without flattening the ramp.

Build **one at a time**, re-playtesting L12 between each. Tune timid — four relief
valves at full strength could make deep floors go soft. Possible future: gate each
behind a server toggle so they can be A/B'd / mixed-and-matched.

**Shipped:** **M9 — Spawn lull** ([#26](https://github.com/tekknoschtev/dungeon-crawler-game/pull/26)),
**M10 — Collectible bomb** ([#27](https://github.com/tekknoschtev/dungeon-crawler-game/pull/27)),
and **M11 — Exit pulse** ([#29](https://github.com/tekknoschtev/dungeon-crawler-game/pull/29));
see the [Shipped](#shipped) table. Bomb kills route through `killMob`, so they
feed the spawn lull for free — a cluster detonation quiets the floor afterward.
Remaining:

- **M12 — Co-revive reprieve.** A revive grants a brief shared invuln (~1.5s) to
  reviver *and* revived, plus a small knockback pulse to clear the immediate space.
  Stops the "revived straight back into the swarm" instant re-down and rewards the
  healer's risk — the clearest mechanical incentive to play grouped. Builds on the
  existing revive (`REVIVE_RANGE`, `REVIVE_HP_PCT`).

## Backlog (unscheduled)

Grouped by where the work mostly lives. Tuning lives in
`server/src/rooms/tuning.ts`; client-only items are pure render/UX and need no
new synced state.

**Level Design**
- **Massive levels** - Levels that feel so punishingly large that it's a challenge to get to the exit before the heat is full.  Maybe lots of corridors.  This probably will need some dials to make it fun and not just tedious.

**Gameplay / loot**
- **Permanent weapon changes** — a way to make an equipped weapon stick rather
  than lapse with the timed buff.
- **Closeable doors** — doors a player can shut to make a safe recover/pause
  space (server-authoritative map/door state).
- **Descent to same location** — when descending, all players start in the same
  location.
- **Bomb mechanics** — difficult to escape the bomb blast radius before it pops:
  increase fuse time, and increase stun time. Current mechanics don't provide
  the pressure relief that a bomb might imply.

**Mobs**
- **More behaviors** — ranged / wall-phasing kinds (M5 shipped stat-only variety).
- **"Hunter" elite** — a relentless elite past a heat threshold, as the clearest
  possible "leave now" signal.

**Client / UX**
- **Mob attack telegraph** — a wind-up flash/lunge *before* a mob hits (the
  server already knows attack timing; surface it). A hit-reaction strike anim
  already exists — this is the anticipatory tell.
- **Sound effects** — hits, pickups, level/door events. CC0 only, logged in
  `ATTRIBUTION.md`.
- **Prevent held-attack auto-fire** — stop holding the attack/space key from
  continuously swinging.

**Meta / retention** *(secondary to M13/M14 — build after the local layer lands)*
- **Daily seed + anonymous leaderboard** — the generator is already fully
  seeded, so "today's dungeon" is just seed = date hash surfaced as a lobby
  option. Leaderboard = arcade-cabinet identity: a **claimed nickname** (no
  auth, no email, no PII — impersonation is exactly as serious as it was on a
  Galaga machine) posted with score/depth/date to a small server-side DB.
  Within the refined arcade rule (see locked decisions); pairs with the
  owner-telemetry item below, since the run-end summary is the score row.

**Ops / telemetry**
- **Owner telemetry** — log the run-end `"gameover"` summary server-side (no PII)
  for owner metrics; the score-screen payload *is* the analytics object.
- **Player/session dashboards** — Influx/Grafana visualizing concurrent players,
  games played, etc. Builds on owner telemetry.

## Deferred

- **Score-screen polish** — the standing owner ask; **absorbed into M13** (the
  discoveries panel is the polish pass).
- **Key-carrying to door** — M6 uses instant unlock on pickup; eventually the
  player who picks up the key should carry it to the vault door to open it,
  creating a co-op escort moment. Deferred until M8 matchmaking is in so there
  are reliable co-op runs to design around.
