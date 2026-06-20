// Single source of truth for the hero's lobby-selectable appearance — colors and
// body sprites. The server is authoritative (it validates the lobby's pick), so
// the canonical lists live here; the client lobby imports them directly rather
// than keeping a hand-synced mirror. Keep this file dependency-free (plain
// `export const`s, no Phaser/Node imports) so the client's Vite bundle can pull
// it in across the package boundary.

// Distinct hero colors used for round-robin assignment when a player doesn't pick
// (or picks something unrecognised).
export const COLORS = ["#ff5d73", "#4ec9ff", "#ffd65c", "#7cf36b", "#c08bff", "#ff9f45"];

// "No color" — white is Phaser's no-op tint, so the hero renders in the sprite's
// natural palette. Selectable in the lobby, but deliberately kept out of COLORS
// so the round-robin fallback only ever hands out distinct hues.
export const NO_COLOR = "#ffffff";

// What the lobby offers and the server accepts: the distinct hues plus "no color".
export const SELECTABLE_COLORS = [...COLORS, NO_COLOR];

// Selectable hero bodies — Tiny Dungeon sheet frames (the humanoid characters at
// #84–88 and #96–100), tinted by the chosen color.
export const HERO_SPRITES = [84, 85, 86, 87, 88, 96, 97, 98, 99, 100];

// 96 (the armored knight) is the default for an unrecognised/absent pick.
export const DEFAULT_HERO_SPRITE = 96;
