# Biome floorplans — generator gameplan

The art made each biome *look* like a different place ([`biome-art-plan.md`](biome-art-plan.md));
this makes each one *shaped* like a different place. Owner call: "that's what
will really sell it." Scope/status tracking stays in [`roadmap.md`](roadmap.md).

## Design rules (the invariants)

1. **Geometry becomes a pure function of `(seed, biome)`.** Today it's a pure
   function of seed alone; this plan deliberately breaks that — floors 5+
   change shape by band — but determinism per (seed, biome) is absolute:
   every co-op client and every re-run gets the identical dungeon.
2. **Stone is the untouched baseline.** Floors 1–4 keep today's exact layouts,
   seed-for-seed (regression-pinned). New players see nothing different.
3. **Quirks draw from a second RNG** (`mulberry32(seed ^ hash(biome))`), so
   the main draw stream — room placement, corridor flips, the lighting roll —
   is byte-identical to today. A biome quirk can never change which seeds
   roll dark or torchlit.
4. **Placement code stays generic.** Quirks run after room carving and before
   vault/exit/spawn/prop placement, so everything downstream (sealed vault,
   reachability flood-fill, crate spawns) just works on the quirked grid.
5. **Connectivity is provable.** Every quirk either only *opens* floor
   (breaches, niches, bulges — can't disconnect anything) or adds walls with
   a containment guarantee (chasms keep a ≥2-tile floor ring). The test suite
   flood-fills many seeds per biome to enforce it.

## Per-biome floorplan identities

Preset weights replace today's uniform archetype roll (still exactly one RNG
draw; stone keeps the legacy uniform mapping bit-for-bit):

| Biome | warren | standard | hall | catacombs* | Quirk |
|---|---|---|---|---|---|
| stone | ⅓ | ⅓ | ⅓ | — | none (baseline) |
| overgrown | 45 | 35 | 20 | — | **root breaches** |
| crypt | 10 | 25 | 15 | **50** | **burial niches** |
| ember | 15 | 35 | 50 | — | **scorched chasms** |
| frost | 10 | 25 | 65† | — | (big glacial halls are the quirk) |
| goldvault | 0 | 20 | 80‡ | — | crate-rich treasury (+ symmetry stretch) |
| flesh | 70 | 20 | 10 | — | **organic bulges** |

\* **catacombs** — a new preset: small rooms (4–6 tiles), few of them (~8),
long L-corridors between. The niche quirk decorates those corridors.
† frost hall variant bumps room sizes (glacial chambers; the art's ice slicks
scatter more in the open).
‡ goldvault hall variant bumps `propChance` hard — a treasury is *full* of
crates to smash (which also feeds the key hunt + treasure mood).

### The quirks, concretely

**Root breaches (overgrown)** — open 4–8 wall tiles that sit between two
floor spaces (wall with floor on opposite sides), like roots burst through:

```
██████████        ████ █████       Loopier floors: more escape
   room ██  ─►       room ██       routes, kite-friendly — fits
██████████        ██████ ███       the band where bats/spiders swarm.
```

**Burial niches (crypt)** — along straight corridor walls, carve 1-tile
alcoves at intervals (alternating sides). Ambush pockets + crate homes:

```
█████████████        ███ ███ █████
  corridor      ─►     corridor
█████████████        █████ ███ ███
```

**Scorched chasms (ember)** — in rooms ≥7×7, re-add a 2×3-ish wall blob in
the middle (renders as ember's near-black void = a collapse/lava pit). Big
rooms become arenas with obstacles to fight around; blobs are ≥2 wide so the
nub-pruner leaves them intact, with a guaranteed ≥2-tile floor ring:

```
██████████        ██████████
█        █        █        █
█  room  █   ─►   █  ▓▓▓   █     ▓ = wall/void blob
█        █        █  ▓▓▓   █
██████████        ██████████
```

**Organic bulges (flesh)** — floor-adjacent walls get a small chance to melt
open (bulge-only erosion: only opens floor, so connectivity is safe), then
the nub-pruner smooths the mess. Rooms stop being rectangles — the warren
becomes a digestive tract. Pairs with the wall-eating blotch art.

## What this changes (and doesn't)

- **Client: zero changes.** The grid is server-sent; the client renders
  whatever arrives.
- The "same seed, same layout at any depth" doc/test pins update to the new
  invariant: same seed **within a band** ⇒ identical; stone pins legacy.
- Special-floor biomes get their floorplans now, ready for whenever trigger
  design lands — testable today via `DUNGEON_BIOME`.

## Phasing (each PR playtestable via `DUNGEON_BIOME` + screenshots)

1. **PR A — plumbing + weights (~1 session).** Biome resolved *before*
   carving, quirk-RNG scaffold, weight table, catacombs preset + frost/gold
   hall variants, test-pin updates. Every biome immediately gets a distinct
   structural fingerprint.
2. **PR B — floor-opening quirks (~1 session).** Root breaches, burial
   niches, organic bulges (all connectivity-safe by construction) + per-quirk
   unit tests + flood-fill sweeps.
3. **PR C — chasms + treasury (~1 session).** Ember chasms (the one
   wall-adding quirk, with its containment tests) and the goldvault crate
   bump. **Stretch (own decision):** mirrored-symmetric goldvault layouts —
   flashiest, riskiest; only if the treasury still feels plain without it.

Verification per PR: unit tests (determinism, connectivity, quirk bounds,
stone regression) + in-game screenshot sweep per biome × archetype, plus one
full auto-played descent 1→6 to prove band transitions stay clean.
