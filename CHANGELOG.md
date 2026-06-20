# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This is a co-op browser dungeon crawler; entries are grouped by player-visible
change rather than by package.

## [Unreleased]

### Added
- Hero **body** selection in the lobby — pick one of 10 Tiny Dungeon character
  sprites (#84–88, #96–100) alongside the existing color picker, for lots of
  hero variation. Synced as `Player.sprite`, validated server-side against an
  allowlist (`isAllowedSprite`). Arrows cycle body and color; keyboard
  Left/Right = body, Up/Down = color.

## Previously shipped

### Added
- Floor decoration, server-placed collidable furniture props, and per-hero
  death markers (tombstones tinted to the fallen hero's color). (#5)
- Pick your hero color in the lobby, with a live tinted preview. (#4)
- Mob attack telegraph — visual wind-up/strike feedback when mobs attack. (#3)
- Join / leave / death toasts. (#2)

### Changed
- Loot rebalance: potion-heavy drops, longer/stronger buffs, passive HP
  regen. (#1)
