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
| **M6** | Breakable crates + vault key — smash crates for loot/score; guaranteed key per floor instantly unlocks the vault | [#18](https://github.com/tekknoschtev/dungeon-crawler-game/pull/18), [#21](https://github.com/tekknoschtev/dungeon-crawler-game/pull/21) |
| **M7** | Floor variety — three named archetypes (warren/standard/hall) picked per floor from seeded RNG | [#22](https://github.com/tekknoschtev/dungeon-crawler-game/pull/22) |
| **M8** | Quick Play matchmaking — public room pool + share links; lobby shows Quick Play / New Private Room / Join by Code | [#23](https://github.com/tekknoschtev/dungeon-crawler-game/pull/23) |
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

## Comeback toolkit — deep-floor relief valves

Playtesting surfaced a death spiral on deep floors (~F10+): mob damage scales
`+10%/floor` (`DEPTH_DAMAGE_SCALE`) against a flat 100 HP, population sits near
the `PRESSURE_TARGET_HARD_CAP` of 30, and `RESPAWN_DELAYS` ramps to 18s while
`heat` keeps climbing — so the first death tends to cascade into a wipe and you
can't thin a room long enough to reach the ladder. The curve itself is *fun*
(short runs, real stakes); what's missing is **burst** — earned tools that let a
skilled/coordinated party manufacture breathing room without flattening the ramp.

Build **one at a time**, re-playtesting L12 between each (spawn-lull alone may
relieve more than expected). Tune timid — four relief valves at full strength
could make deep floors go soft. Possible future: gate each behind a server toggle
so they can be A/B'd / mixed-and-matched.

- **M9 — Spawn lull (build first).** A mob's death suppresses its slot's refill
  for a few seconds, and each kill extends the suppression. Chip one mob → no
  relief; rout a cluster at once → the floor goes quiet for several seconds.
  Re-uses the existing pressure spawner (`PRESSURE_SPAWN_INTERVAL_*`); the
  cheapest item and highest-leverage — makes killing feel like progress again and
  turns AoE/clustering into a deliberate pressure-relief tactic. A second payoff
  for knockback weapons and the M10 bomb. *Starting knobs:* per-kill
  refill-suppression ~2–3s, extended/stacked by simultaneous kills. (Possible
  later: name the moment a "rout" and hang a score combo on it — resist for now.)

- **M10 — Collectible bomb** (Tiny Town tile `0105`). Crates gain a chance to drop
  a bomb the player carries and places with the **E key** (+ a contextual mobile
  button that appears *only* while a bomb is held). On a short fuse it deals a
  local blast (radius damage + knockback — **hurts the placer too** if they're
  still inside) *and* stuns every mob on the map. Two halves on purpose: the
  map-wide stun is the *relief* (freeze the swarm to reposition / revive / bolt
  for the stairs); the local blast is the *skill/risk* (bait a cluster, then step
  out of the radius — the stun covers your retreat). **Deliberate exception** to
  two locked decisions — "loot stays immediate-use" and "no new buttons" — taken
  because a comeback tool's value is agency (aimed/timed beats auto-trigger); the
  contextual, transient mobile button keeps the HUD honest, and `MAX_HEAL_CHARGES`
  is precedent for a stockpiled count. *Starting knobs:* crate drop ~15–20%
  **biased deeper** (rubber-band: bombs show up when you need them), carry cap ~2,
  blast radius ~45px, fuse ~1.2s, map-wide stun ~2.5s.

- **M11 — Exit pulse.** Starting the descent channel (`DESCEND_CHANNEL_TIME`)
  makes the ladder emit a knockback/stagger pulse that shoves nearby mobs back, so
  racing to the stairs is a viable escape *under fire* — not something you can only
  do once a room is already clear. The reliable escape the rare bomb can't
  guarantee; descent is already the intended pressure reset (`enterFloor`), this
  makes it reachable.

- **M12 — Co-revive reprieve.** A revive grants a brief shared invuln (~1.5s) to
  reviver *and* revived, plus a small knockback pulse to clear the immediate space.
  Stops the "revived straight back into the swarm" instant re-down and rewards the
  healer's risk — the clearest mechanical incentive to play grouped. Builds on the
  existing revive (`REVIVE_RANGE`, `REVIVE_HP_PCT`). Ship alongside M11 as a co-op
  polish pass.

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
