# Asset Attribution

We track every third-party asset here, including its source and license —
even for CC0/public-domain assets that don't legally require credit. Keeping
this current means we can never get caught flat-footed on licensing.

## Current status

Milestone 2 (Phase 1) introduced our first real art — see the Tiny Dungeon entry
below. All on-screen art (floor, wall, hero) now comes from the sprite sheet;
the local player is identified by their yellow name label rather than a drawn ring.

### Kenney — Tiny Dungeon (1.0)
- Source URL: https://kenney.nl/assets/tiny-dungeon
- Author / creator: Kenney (www.kenney.nl)
- License: CC0 1.0 (public domain — free for any use, no attribution required)
- License URL: https://creativecommons.org/publicdomain/zero/1.0/
- Used for: dungeon floor/wall tiles, the hero sprite, mobs, loot, floor
  decoration, and death markers. We ship the packed spritesheet
  `Tilemap/tilemap_packed.png` (16×16 tiles, 12 columns, no spacing) as
  `client/public/assets/tiny-dungeon/tilemap_packed.png`. Frames in use:
  #48 (floor), plus the wall autotile set (#4/#5/#13/#15/#26/#30/#40/#57/#58/#59
  and inner corners #18/#25/#27), #96 (knight/hero, tinted per player),
  #108 (slime mob), #103/#115 (sword/potion loot). Floor decoration (added
  2026-06-19): #49 (speckle floor) and #42 (paved-stone floor) as client-side
  texture variation, plus solid collidable props #63/#75 (crate stacks), #73
  (barrel), #74 (anvil), #82 (keg) placed server-side on room edges. Death
  markers reuse #64 (gravestone), tinted to the fallen hero's color.
- Modifications: none (shipped the packed sheet as-is; raw pack extracted under
  the gitignored `assets-src/tiny-dungeon/`).
- Date added: 2026-06-16 (floor decoration + death markers: 2026-06-19)

### Original — steel shield icon (loot)
- Source URL: n/a (created for this project)
- Author / creator: this project (hand-drawn to match the Tiny Dungeon style)
- License: CC0 1.0 (we release it to the public domain)
- License URL: https://creativecommons.org/publicdomain/zero/1.0/
- Used for: the "defense" loot drop icon (Tiny Dungeon has no shield tile). A
  16×16 sprite at `client/public/assets/tiny-dungeon/shield.png`, drawn using
  Tiny Dungeon's own palette (outline `#3f2631`, steel `#c0cbdc/#8b9bb4/#52607c`,
  blue boss `#0099db`) so it reads as native pack art.
- Modifications: original work.
- Date added: 2026-06-18

## Planned sources (Milestone 2)

The plan is to pull top-down dungeon art from **Kenney** (https://kenney.nl),
whose packs are released under **CC0 1.0** (public domain — free for any use,
including commercial, no attribution required). Likely packs:

- Kenney — "Tiny Dungeon" (16×16 top-down dungeon tiles + characters)
- Kenney — "Roguelike/RPG pack"
- Kenney — UI packs for inventory/HUD

When we add any asset, append an entry below in this format:

```
### <asset / pack name>
- Source URL:
- Author / creator:
- License: (e.g. CC0 1.0, CC-BY 4.0)
- License URL:
- Used for:
- Modifications: (none / describe)
- Date added:
```

> Note: if we ever use a **CC-BY** asset, attribution becomes *required* — the
> credit must appear both here and somewhere user-visible (e.g. a credits
> screen). CC0 assets we still log here for our own records.
