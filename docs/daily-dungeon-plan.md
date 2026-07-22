# Daily dungeon — a shared-goal challenge

A **daily challenge** to bring players back and funnel them into the regular
private/public game. Everyone who opts in plays the **same seed** for the day and
pushes toward a shared community goal: *how deep can we collectively get?*

Owner framing: the daily is **bait** — a unique, low-friction, shareable hook
that gets people in the door; the game they stay for is the private/public dive.
It does not need deep systems to earn its keep. Scope/status:
[`roadmap.md`](roadmap.md).

## The rejected shape (and why)

The tempting version — **one persistent room everyone piles into**, cleared
floors going quiet, the mob-free corridor left behind — was explored and
dropped. It fails on three fronts:

- **Scaling.** A single Colyseus room syncs full state to every client every
  tick. 50–200 players in one room is a different, scarier architecture than the
  ~4-player co-op it's built for (bandwidth, sim cost, mobile patch size).
- **"Clear the floor" is a locked *don't*.** Cleared-floor-goes-safe reintroduces
  exactly the floor-clearing loop the design deliberately dropped, and it fights
  the time-based pressure ramp.
- **Re-traversal tedium.** Frontier at floor 30, you die → walk 29 empty floors
  to rejoin. Nobody does that twice.

## The shape we're building

**Distributed progress, normal rooms.** Play stays in ordinary **4-player rooms**
seeded to the daily seed; the *shared* thing is a server-tracked **community
frontier** — the deepest floor reached on today's seed — not co-presence in one
instance. You lose the spectacle of seeing a hundred other players; you keep the
fantasy of a community cracking one dungeon, at a fraction of the risk and cost.

### Settled decisions

- **4-player rooms unchanged**; progress is separated from the room.
- **No "clear the floor"** — the locked pressure rule stays; the daily is the
  normal loop on a fixed seed, not a new ruleset.
- **Monotonic community frontier.** The day's deepest floor only moves *down*,
  banked for the day. This is also the **anti-grief primitive**: if progress
  can't be un-banked, an anonymous troll's worst move is being unhelpful.
- **Eastern rollover** (DST caveat below).
- **Lightweight DB (SQLite).** One row per run-end; single-writer is a non-issue
  at this write rate.
- **Retention / funnel, not a deep mode.**

## MVP — the whole play for now

The smallest thing that tests *"does a daily bring people back?"*:

- **Seed = hash(today, Eastern).** Reuses the seed-injection path built for the
  `DUNGEON_SEED` dev override — a `dungeon-daily` room type (or join option) pins
  `baseSeed` to the date instead of random.
- **Lobby option** "Daily Dungeon" alongside Quick Play / New Private Room / Join
  (the lobby, not the HUD — respects the minimal-HUD rule).
- **On run-end (`gameover`)**, write one row: date, deepest floor, score, claimed
  nickname (anonymous, no PII), timestamp.
- **Show the community record** in the lobby ("Today: the community reached floor
  31"), optionally a top-N board.
- **Shareable result** — "how deep did *you* get on today's dungeon?"

That's roughly *"pin the seed + one table + one number on a screen."* No rejoin,
no start-at-frontier, no new run rules — and given the daily's job is to funnel
people into the real game, that may be all it ever needs.

**Built-in advantage:** the server is already authoritative over depth and score,
so leaderboard rows are **server-computed, not client-claimed** — anti-cheat is
free.

## Shared infrastructure (build once, feed three)

The one SQLite table is the substrate for the whole meta layer:

1. **This daily leaderboard.**
2. The backlog **anonymous-nickname leaderboard** (general, not just daily).
3. **Owner telemetry** — the `gameover` payload *is* the score row *is* your
   metrics (concurrent players, depth distribution, run length…).

So the DB work is not single-purpose. Build it once for the daily and the other
two are mostly plumbing.

- **Anonymous nickname:** claimed, no auth/email/PII — within the refined arcade
  rule (impersonation is exactly as serious as it was on a Galaga cabinet).

## v2 — "join the front line" (deferred)

Start a daily run *near* the community frontier instead of floor 1, so every
session joins the push instead of re-walking cleared depth.

- **Why it's clean here:** no persistent gear / meta-progression (locked rule),
  so skipping floors creates **no power gap** — you just have current buffs.
- **The one snag:** difficulty scales with depth (mob damage ~+10%/floor), so
  dropping a fresh party at floor 28 is a meat grinder. Mitigations to design: a
  few-floor running start below the frontier, a starting buff loadout, or more
  generous daily lives. This is why it's v2, not MVP.

## Events & the monthly flesh corruption

The date-keyed logic that picks the daily seed generalizes into a small **event
calendar** — special rulesets on special days. Its first tenant: **monthly flesh
corruption**, where the whole day's world is flesh (see
[`special-floors-plan.md`](special-floors-plan.md) for what flesh *does*). This is
why flesh's trigger lives on the daily scaffolding rather than as a random floor.

## Timezone / rollover

**Eastern** — but Eastern is UTC-5 / UTC-4 depending on DST, so "midnight
Eastern" silently shifts an hour twice a year. Compute the Eastern date properly
(or accept the drift knowingly); don't hardcode a fixed UTC offset and call it
Eastern.

## Cost & scaling (deliberately small)

- **No per-tick cost added** — the daily is a fixed seed + one DB write per
  run-end.
- **Room count is the real lever**, already capped at `maxRooms: 50` (≈200
  concurrent players before you'd touch it). Predictable; no melt / surprise bill.
- **SQLite is right at this scale** — one host, single-writer, low write rate.
  Revisit only if you ever run multiple server processes.

## Open questions

- Exact date→seed derivation (date string → uint32).
- Nickname claim + collision handling (no accounts to dedupe against).
- Board scope: global top-N? personal best? per-day history?
- Does the daily use its own room pool or the public one?
- Whether v2 frontier-start or a simpler "personal best on today's seed" is the
  real retention driver — decide from MVP data.

## Phasing

1. **MVP** — daily seed + one table + community record + share string.
2. **Board / nickname polish** — top-N, claimed nicknames, personal best.
3. **Telemetry views** — reuse the table for owner metrics.
4. **v2 frontier-start** — only if the MVP proves the daily has legs.
5. **Event calendar + monthly flesh** — pairs with the flesh work in
   [`special-floors-plan.md`](special-floors-plan.md).

## Verification

Force a daily seed locally (the `DUNGEON_SEED` path); confirm two clients on the
same date get the identical dungeon; verify a `gameover` writes exactly one row;
check the Eastern rollover flips at the right instant across a DST boundary.
