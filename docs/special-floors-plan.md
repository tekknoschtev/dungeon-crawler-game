# Special floors — making the built biomes real

The depth-band biomes (stone / overgrown / crypt / ember) are fully live. The
three **special** kits — **frost, goldvault, flesh** — have shipped art *and*,
since the biome-floorplans milestone, distinct floorplans... yet a player can
still only reach them through the `DUNGEON_BIOME` dev override. This plan gives
each one a **trigger** and a **mechanic** so it becomes a real, chosen,
memorable floor rather than "a normal floor with a new skin."

Owner framing: unique, uncommon, *different* — not just harder. Scope/status
tracking stays in [`roadmap.md`](roadmap.md). The date-keyed event scaffolding
that flesh's trigger leans on lives in [`daily-dungeon-plan.md`](daily-dungeon-plan.md).

## Design principles (the invariants)

1. **Deterministic per (seed, biome).** A special floor's presence, position,
   and contents are a pure function of the seed — every co-op client agrees and
   a daily seed reproduces it exactly. Same rule the floorplans already follow.
2. **Chosen, not inflicted.** Where a special floor is a *treat* (goldvault) or
   *strange* (flesh), the party opts in — a world object they walk to, never a
   forced "gotcha." And a choice must carry a **cost**, or it isn't a choice.
3. **Different, not harder.** Special floors change *how* you play, not the
   damage numbers. (Aspirational for flesh — expect "harder until learned.")
4. **No new HUD.** Triggers are world objects and movement changes, never new
   buttons — the mobile HUD stays minimal (locked design rule).
5. **Reuse what exists.** Goldvault's treasure spawns, the M14 codex, M11
   knockback, the pressure clock — special floors lean on shipped systems.

---

## Goldvault — the strange stairway

**The smallest, highest-payoff of the three.** Goldvault is nearly turnkey:
beyond art + the treasury floorplan, it *already* spawns `GOLDVAULT_TREASURE_COUNT`
pure-score treasure pickups (coins/sacks via `rollTreasure`) — see
`server/src/rooms/DungeonRoom.ts` (`if (this.map.biome === "goldvault")`),
currently dormant only because `biomeForDepth` never returns goldvault. Trigger
it and you have a complete treasure-vault floor: dense smashable crates *and*
scattered score-loot, riding the existing loot/haul machinery.

- **The trigger — a strange stairway.** An uncommon second exit appears on some
  floors (seeded presence + position), visually distinct from the normal
  descent. Taking it detours the party into a goldvault treasure floor; a return
  exit sends them **back to the same floor** to descend normally. The vault is
  *additive* bonus content, not a branch you can get lost in and not a
  replacement for the normal floor's descent.
- **Entry = gather-to-enter.** A **quorum** of the party must stand in the
  stairway zone; once quorum is met a short **countdown** runs, then the whole
  room transitions into the vault together. This scales challenge with party
  size for free: solo you're already "gathered" (a small treat); in a group,
  converging on one tile mid-floor *is* the cost — traversal, mob exposure, and
  social negotiation. Quorum-plus-countdown (not unanimity) is deliberate: it
  stops a single AFK / dead / holdout player from hard-blocking the vault
  forever, turning an open-ended standoff into "get in the circle in 5 seconds
  or miss it."
- **The cost — a hotter return.** The pressure clock **keeps ramping** while the
  party is in the vault, so the floor they return to has had time to flood. The
  price is paid on the way *out*, not in — a clean risk shape that reuses the
  existing pressure system instead of inventing a penalty.
- **Determinism.** Stairway presence + location are seeded; the treasure spawn
  is already grid/seed-deterministic.

**Resolved + BUILT** (the open questions below were settled with the owner and
shipped; kept here as the record of *why*):

- **Quorum = "all but one"** of the living party, `max(1, living - 1)`. Never the
  whole party, so a lone AFK/dead/holdout hero can't veto it — they're the "one".
  Solo and duo are trivially met; a four-hero party genuinely has to converge.
- **Countdown = 3s**, and it *resets* (not pauses) the instant quorum breaks, so
  a party can always back out by stepping off.
- **The whole room transitions**, gathered or not — the run has exactly one
  shared floor, and stranding a hero on an abandoned one would break that
  outright. The countdown is the window to object by stepping in, or just come.
- **Vault mobs: depth-scaled, lighter count.** HP/damage scale with the current
  depth (they're a real threat), but the population uses its own target with no
  per-depth bonus (`vaultMobTarget`, 4→8) so it reads as a smash-and-grab. The
  price of the detour is the flooded return, not a second pressure cooker inside.
- **Vault loot: treasure + one immediately-openable reward chest.** No key hunt,
  no timed unlock (a 90s wait fights the in-and-out rhythm) — it arrives unlocked
  and a single swing cracks it, paying a fatter jackpot (`vaultChestPoints`) and a
  unique gilded trophy from a hand-picked pool (`VAULT_RELICS`) instead of the
  procedural M4 relic.
- **Rarity ~1 in 4** floors, never floor 1 (the on-ramp teaches the normal descent
  first). `DUNGEON_STAIRWAY=always` forces it for testing.
- **The floor's normal vault is simply left behind** when you detour. The return
  regenerates the floor — deterministic from (seed, depth), so it's the identical
  place — which re-arms a fresh M4 vault. The stairway itself is *spent* on the
  return, so the vault can't be farmed in a loop.
- **Determinism:** presence + position are drawn from a dedicated RNG stream
  (`seed ^ hash("stairway")`), the same trick the biome quirks use, so adding the
  feature could not shift a single pre-existing layout or lighting roll
  (regression-pinned in `map.test.ts`).

---

## Frost — sliding

**A self-contained physics feature that self-reinforces with the floorplan you
already built.** Frost rolls the `glacial` preset — big open halls — and sliding
in open space feels *good* (momentum, drift, speed) while sliding in tight
warrens would feel awful. Frost also has **no chasms** (those are ember's), so
the worst a slide does is bonk a wall, not drop you in a pit. It's the perfect
biome to debut the mechanic.

- **The mechanic.** Frost floors add momentum + friction to the movement
  integrator in the server sim: you accelerate, drift, and decelerate slowly.
  **Players *and* mobs slide** (an equalizer, and often funny). You can **attack
  mid-slide**, and knockback flings you — weapon knockback *and* the M11
  exit-pulse — across the ice. (Exit-pulse knockback on ice will send mobs
  sailing across the room; that's emergent from systems already shipped.)
- **Server-authoritative + deterministic.** Physics live in the
  `DungeonRoom.update()` movement step and must stay deterministic (fixed
  timestep) so co-op clients agree.
- **The trigger (open).** Less defined than goldvault's. Because frost is
  *different, not harder* and non-punishing, an **unchosen rare seeded roll** is
  acceptable here (an "oh, ice" floor is a delight, not a gotcha — unlike flesh).
  Alternatively it could get its own opt-in path. **Decide.**

**Open questions**
- Trigger mechanism (rare seeded roll vs. an opt-in path).
- Mob slide amount — full physics or damped? Full is funnier and fairer.
- Mobile feel: momentum on a virtual joystick can read as floaty/unresponsive —
  the opposite of tight arcade feel. Friction constant + accel curve are the
  knobs; this needs **hands-on playtest tuning**, not a guessed value.
- Does sliding make holding position to channel the descent harder — feature or
  annoyance? Interaction ordering with existing knockback/shove resolution.

---

## Flesh — corruption + unique mobs

**The biggest lift of the three, and best done last** — it's a content project
(new mob art + AI + loot), not a knob. Flesh should be *more than cosmetic*: the
grotesque floor gets **flesh-only mobs and flesh-only loot**, and reads as
**different, not harder** (accept that new behaviors read as harder until
learned — a healthy mastery curve).

- **The reward hook (nearly free).** Flesh-only mobs and loot become **M14 codex
  entries collectable *only* on flesh days** — a concrete reason to show up:
  complete the collection. Reuses the shipped codex; flesh day just adds shelves.
- **The trigger — NOT random floors** (owner call). Primary use is a **monthly
  world-corruption event**: the whole day's dungeon is flesh, via the date-keyed
  event system shared with the daily dungeon (see
  [`daily-dungeon-plan.md`](daily-dungeon-plan.md)). Optionally a rare flesh
  floor *inside* the daily dungeon. This is why flesh's trigger lives on the
  event scaffolding rather than as a random roll.
- **Scope is bounded by "event-only."** Flesh mobs only have to work for event
  days — they don't need to be balanced across every depth of every run.

**Open questions (the real design work)**
- What flesh mobs *do* — behaviors that demand different tactics without more
  lethality: split-on-hit swarms, ambushers that don't chase, slow-but-tanky
  walls, corrupt/transform effects. To be designed.
- Flesh loot / rewards beyond codex entries.
- Exact monthly rule (first of the month? a fixed date? a rotating corruption?).
- Does flesh apply to the whole run that day, or specific floors.

---

## Phasing

1. ~~**Goldvault strange stairway**~~ — **SHIPPED.** The trigger,
   gather-to-enter, and vault-return plumbing are built; the treasury floorplan
   and treasure scatter light up for free, exactly as predicted.
2. **Frost sliding** — self-contained physics; needs a trigger decision and real
   playtest tuning. Mid-size.
3. **Flesh** — content project (mobs / AI / loot) that also *depends on* the
   daily-dungeon event scaffolding. Do after the daily plan's event system
   exists and after 1–2 prove the special-floor plumbing.

## Verification (per feature)

- Force each biome with the `DUNGEON_BIOME` override; confirm the mechanic in a
  live co-op playtest (gather-to-enter timing; slide feel; flesh mob behaviors).
- Seeded-determinism unit tests where there's new seeded state (stairway
  placement; sliding must be reproducible across clients).
- Codex-entry checks for flesh (only-on-flesh-day collectables actually record).
