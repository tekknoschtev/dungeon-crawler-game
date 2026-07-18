# M15 depth biomes — derived-asset gameplan

The work plan for producing the biome tile kits. Scope/design of M15 itself
lives in [`roadmap.md`](roadmap.md); this doc is *how the art gets made*.
Inspection findings (2026-07-17): no CC0 pack on hand supplies a second
style-matched wall kit, so every non-stone biome derives one from Tiny
Dungeon's — a palette remap plus a rule-placed pixel detail pass, shipped as
real PNGs. Prototype evidence: `assets-src/biome_mock2.py` / `.png`.

## What one kit is

19 tiles of 16×16, replacing Tiny Dungeon's kit roles:

| Role | Frames | Count |
|---|---|---|
| Wall: face / back / edges / corners / skinny / cap | 40, 26, 13, 15, 4, 5, 57, 59, 58, 30 | 10 |
| Wall: inner corners | 25, 27, 18 | 3 |
| Floor: base / speckle / paved | 48, 49, 42 | 3 |
| Floor: baked top-shadow pair | 50, 51 | 2 |
| Void / rock | 0 | 1 |

Plus two per-biome *code* constants (no art): the client's `ROOF_TINT` and the
dark-floor backdrop color.

Out of scope per kit (stay shared across biomes, revisit later if wanted):
torch #125, crate/prop frames, the descent ladder, death markers, all
mobs/heroes/loot.

## Delivery mechanism: sheet clones (key simplification)

Each biome ships as a **full clone of `tilemap_packed.png` with only the 19
kit tiles replaced** (`client/public/assets/tiny-dungeon/tilemap_<biome>.png`,
~15 KB each). The client picks the *texture key* by biome and every frame
index stays identical — no frame-remap tables, and heroes/mobs/loot render
unchanged from whichever sheet is active. The autotiler, floor decor, and
torch code need zero changes.

## The pipeline (`assets-src/biomes/`)

One script + one palette file per biome, all in the gitignored `assets-src/`
(same home as the existing crop/preview helpers):

1. **`build_biomes.py`** — for each biome:
   - extract the 19 source tiles, compute their **union palette** (~10–14
     colors — the stone face alone is a 3-color ramp);
   - apply the biome's palette map (explicit `src hex → dst hex` dict; no hue
     math — round 1 of the mock proved blind rotation fails);
   - run the biome's **detail pass** (rule-placed, restrained: moss only on
     brick undersides, ≤2 ember cracks per face, a few floor tufts — round 2
     proved placement rules beat scatter);
   - composite into the sheet clone.
2. **`preview_biomes.py`** — renders the review contact sheet per biome:
   a mock room, plus the same room with **mobs + loot glows placed on the
   floor** (the readability gate), plus a darkened strip approximating
   dark/torchlit lighting. Reviewed in-session; iterate the palette dict
   until approved.
3. **Hand-polish (optional, last)** — once a palette is approved, an Aseprite
   pass over the kit tiles in the generated sheet. **Discipline: script-first
   until approval, hand edits only after — regeneration overwrites them.** If
   a kit gets hand edits, note it in `ATTRIBUTION.md` and treat the PNG as
   source of truth from then on.

Every shipped sheet gets an `ATTRIBUTION.md` entry: Kenney Tiny Dungeon
(CC0), *modified* — palette remap + detail pass, tooling in `assets-src/`.

## The three kits

Known same-hue collision to dodge per biome (checked at the readability gate):

| Kit | Bands | Palette direction | Detail pass | Watch out |
|---|---|---|---|---|
| **Overgrown** | 5–9 | gray-green stone; turf/dirt floor (Tiny Town floors also usable) | moss on brick undersides, floor tufts | green **slime** on turf — keep turf darker/yellower |
| **Crypt** | 10–14 | bone-pale stone, parchment floor | pale chips, sparse cracks | pale **ghost** on bone — keep floor warmer/darker |
| **Ember** | 15+ | charcoal basalt, ash floor, near-black void | glowing mortar cracks, rare floor embers | red **imp**/crates on ember — keep floor brown-ash, cracks sparse |

## Sequencing — one kit end-to-end first

Ship **pipeline + Overgrown** as the first PR, with the band table falling
back to stone for bands whose kit doesn't exist yet. That validates the whole
chain (build → review gates → in-game under all three lighting modes → prod)
on the cheapest kit — Tiny Town gives its floors/props for free — before the
other two are made. Crypt and Ember follow as small PRs each.

The biome *plumbing* (server: band → biome name in the `"map"` payload like
`lighting`; client: texture-key swap + per-biome roof tint/backdrop) rides
with the first PR.

## Estimates & review gates

| Item | Estimate |
|---|---|
| Pipeline (build + preview scripts; ~60% already prototyped) | 1 focused session |
| Overgrown kit: palette + detail iteration + gates + plumbing PR | 1 session |
| Crypt, Ember (pipeline mature by then) | ~½ session each |
| Optional hand-polish per kit | open-ended, deferred |

Gates each kit must pass before shipping:
1. **Contact sheet** — owner approves the look (walls read as the same game).
2. **Readability** — every mob kind + loot glow pops against the new floor.
3. **Lighting** — kit reads correctly on dark + torchlit floors (use the
   `DUNGEON_LIGHTING` dev override).
4. **In-game smoke test** — a real floor at the kit's band, all three floor
   archetypes.
