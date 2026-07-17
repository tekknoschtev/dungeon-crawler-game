/**
 * Local codex + personal bests (M14) — the browser's memory of every run.
 *
 * Pure client-side localStorage, per the refined arcade rule (docs/roadmap.md):
 * no accounts, no server state — the browser remembering is in bounds. Two
 * layers live under one versioned key:
 *
 *  - **bests**: high score, deepest floor, runs played — the lobby line and the
 *    score screen's "new personal best" flash.
 *  - **lifetime codex**: every weapon ever wielded, mob kind ever slain, and
 *    named relic ever claimed — what makes a first-ever discovery ("NEW" in the
 *    M13 panel) mean something across runs.
 *
 * localStorage can be unavailable (private mode, disabled). Every access is
 * wrapped: reads fall back to a fresh codex and writes are dropped silently —
 * the game must never break because the browser won't remember.
 */

const KEY = "dungeon.codex.v1";

// A relic collection can't grow unbounded across hundreds of runs; keep the
// newest CAP names (weapons/kinds are naturally capped by the tuning tables).
const RELIC_CAP = 100;

export interface Codex {
  v: 1;
  bestScore: number;
  deepestFloor: number;
  runs: number; // total runs ended (wipe or voluntary exit)
  weapons: string[]; // distinct weapons ever wielded, first-discovered order
  kinds: string[]; // distinct mob kinds ever slain, first-discovered order
  relics: string[]; // named relics ever claimed (newest RELIC_CAP kept)
}

/** What one finished run contributes (assembled by the score screen). */
export interface RunEnd {
  score: number;
  floor: number;
  weapons: string[];
  kinds: string[];
  relics: string[];
}

export interface RunRecordResult {
  // The codex as it stood BEFORE this run merged in — the score screen compares
  // the run against this to badge first-ever discoveries.
  prev: Codex;
  newBestScore: boolean;
  newDeepestFloor: boolean;
}

const fresh = (): Codex => ({
  v: 1,
  bestScore: 0,
  deepestFloor: 0,
  runs: 0,
  weapons: [],
  kinds: [],
  relics: [],
});

export function loadCodex(): Codex {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return fresh();
    const data = JSON.parse(raw) as Partial<Codex>;
    if (data.v !== 1) return fresh(); // unknown future shape — start over
    // Merge over a fresh default so a hand-edited/partial blob can't crash us.
    const base = fresh();
    return {
      ...base,
      ...data,
      weapons: Array.isArray(data.weapons) ? data.weapons : [],
      kinds: Array.isArray(data.kinds) ? data.kinds : [],
      relics: Array.isArray(data.relics) ? data.relics : [],
    };
  } catch {
    return fresh();
  }
}

/** Append items not already present, preserving first-discovered order. */
function mergeDistinct(into: string[], add: string[]): string[] {
  const out = [...into];
  for (const item of add) {
    if (item && !out.includes(item)) out.push(item);
  }
  return out;
}

/**
 * Fold a finished run into the stored codex and report what it broke through.
 * "New best" flashes only fire from the second run on — a first run's score is
 * trivially a record, and announcing it would cheapen the real ones.
 */
export function recordRunEnd(run: RunEnd): RunRecordResult {
  const prev = loadCodex();
  const next: Codex = {
    v: 1,
    bestScore: Math.max(prev.bestScore, run.score),
    deepestFloor: Math.max(prev.deepestFloor, run.floor),
    runs: prev.runs + 1,
    weapons: mergeDistinct(prev.weapons, run.weapons),
    kinds: mergeDistinct(prev.kinds, run.kinds),
    relics: mergeDistinct(prev.relics, run.relics).slice(-RELIC_CAP),
  };
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* storage unavailable/full — the run still renders, it just isn't remembered */
  }
  return {
    prev,
    newBestScore: prev.runs > 0 && run.score > prev.bestScore,
    newDeepestFloor: prev.runs > 0 && run.floor > prev.deepestFloor,
  };
}
