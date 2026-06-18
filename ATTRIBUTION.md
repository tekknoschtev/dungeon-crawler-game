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
- Used for: dungeon floor/wall tiles and the hero sprite. We ship the packed
  spritesheet `Tilemap/tilemap_packed.png` (16×16 tiles, 12 columns, no spacing)
  as `client/public/assets/tiny-dungeon/tilemap_packed.png`. Frames in use:
  #48 (floor), #40 (wall), #96 (knight/hero, tinted per player).
- Modifications: none (shipped the packed sheet as-is; raw pack extracted under
  the gitignored `assets-src/tiny-dungeon/`).
- Date added: 2026-06-16

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
