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

- **Arcade** — no logins, no persistence. A run *is* the session; restart = fresh floor 1.
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
| — | Mobile HUD placement fix (stat HUD off the touch controls) | [#14](https://github.com/tekknoschtev/dungeon-crawler-game/pull/14) |

Earlier systems already in place (not re-listed as backlog): CC0 art pass
(Kenney Tiny Dungeon) + pseudo-2.5D wall autotiler, camera follow, lobby hero +
color select, floor variation (visual tile variants + collidable furniture
props), death markers, passive HP regen, and the loot rebalance (heals common;
attack/defense rarer but longer/stronger). See the code / `CLAUDE.md` for where
each lives.

## Next

- **M6 — Breakable crates + vault key** *(server + client)* — props marked
  breakable (crates/barrels) can be attacked; on death they vanish, award a small
  score bonus (no new item type — direct points, coin pickups deferred), and have
  a chance to drop a **vault key** that instantly unlocks the floor chest
  (bypassing the countdown timer, but awarding the same prize as if the timer had
  run out). Key drop: rare enough to be a jackpot, not an expectation — one key
  possible per floor, ~20–30% chance any floor has one at all. Instant pickup +
  instant unlock for this milestone; carrying the key to the door is a later
  refinement. Crates can also drop potions so bashing feels worthwhile even
  without a key.
- **M7 — Floor variety** *(server, no new art)* — vary the generator knobs per
  floor into named presets (e.g. "Warren" = many small cluttered rooms, "Hall" =
  few big open rooms) and shrink the default toward the 2–3 min traversal target.
  Knobs in `map.ts`: `MAX_ROOMS` / `ROOM_MIN` / `ROOM_MAX` / `PROP_CHANCE` /
  `MAP_W` / `MAP_H`.
- **M8 — Quick Play matchmaking** *(server + lobby)* — mark code-created rooms
  **private**; add a **public** path + a **Quick Play** button
  (`joinOrCreate`) alongside Create-Private + Join-by-Code. Late joiners spawn on
  the party's current floor. Touchpoints: `index.ts` `filterBy`, `lobby.ts`.
- **Ops — Automate prod deploy** — CI already builds + tests on every push to
  `main` and every PR; extend it to **continuous deployment** so a merge to
  `main` rolls out to the Proxmox / Cloudflare-tunnel box automatically (today's
  manual pull → setup → build → restart loop is in [`deploy.md`](deploy.md);
  mechanism TBD). Bake a version stamp (e.g. git SHA / tag) into the build and
  emit it on server start + as a client-visible value so it's easy to confirm the
  latest build is actually running in prod.

## Backlog (unscheduled)

Grouped by where the work mostly lives. Tuning lives in
`server/src/rooms/tuning.ts`; client-only items are pure render/UX and need no
new synced state.

**Gameplay / loot**
- **Permanent weapon changes** — a way to make an equipped weapon stick rather
  than lapse with the timed buff.
- **Closeable doors** — doors a player can shut to make a safe recover/pause
  space (server-authoritative map/door state).

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

**Ops / telemetry**
- **Owner telemetry** — log the run-end `"gameover"` summary server-side (no PII)
  for owner metrics; the score-screen payload *is* the analytics object.
- **Player/session dashboards** — Influx/Grafana visualizing concurrent players,
  games played, etc. Builds on owner telemetry.

## Deferred

- **Score-screen polish** — the standing owner ask; revisit after the milestones
  above.
- **Key-carrying to door** — M6 uses instant unlock on pickup; eventually the
  player who picks up the key should carry it to the vault door to open it,
  creating a co-op escort moment. Deferred until M8 matchmaking is in so there
  are reliable co-op runs to design around.
