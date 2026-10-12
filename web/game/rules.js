// The rules of the game: prices, par, stars, rewards, streaks and achievements. Pure: no DOM, no storage.

/** @typedef {{id: string, w: number, h: number, tier: string|null, kind: "pack"|"daily"|"shared", rating?: {probes?: number}}} RulePuzzle */

export const PRICES = { nudge: 1, cell: 2, line: 5, track: 1, mistakes: 3 };
export const START_SKEINS = 5;
export const ACHIEVEMENT_REWARD = 5;
export const DAILY_OPENS_AFTER = 5; // campaign puzzles solved before the daily opens

// Skeins for the first solve of a pack puzzle, before the stars.
export const TIER_BASE = { tabby: 2, twill: 3, satin: 4, brocade: 6, tapestry: 8 };

// Seconds per cell for par. First guesses: calibrate after 10 played puzzles per tier.
export const SECONDS_PER_CELL = { tabby: 2.0, twill: 1.4, satin: 1.2, brocade: 1.1, tapestry: 1.0 };
const DEFAULT_SPC = SECONDS_PER_CELL.twill; // a shared puzzle without a tier

// Par in seconds: max(60, cells * spc + 20 * probes) rounded up to 30 s.
export function par(puzzle) {
  const spc = SECONDS_PER_CELL[puzzle.tier] ?? DEFAULT_SPC;
  const probes = puzzle.rating?.probes ?? 0;
  const raw = Math.round((puzzle.w * puzzle.h * spc + 20 * probes) * 1e6) / 1e6; // 225 * 1.4 must not tip over 315
  return Math.max(60, Math.ceil(raw / 30) * 30);
}

// One star for the solve, one for no help, one for within par.
export function stars({ seconds, helped, par: limit }) {
  return /** @type {1|2|3} */ (1 + (helped ? 0 : 1) + (seconds <= limit ? 1 : 0));
}

// Skeins for one solve. streak is the daily streak after this solve; 0 means the daily was already solved today.
export function reward({ puzzle, stars: n, prevStars = 0, streak = 0 }) {
  if (puzzle.kind === "shared") return 0;
  if (puzzle.kind === "daily") return streak > 0 ? 5 + Math.min(streak, 5) : 0;
  if (!prevStars) return (TIER_BASE[puzzle.tier] ?? 0) + n;
  return Math.max(0, n - prevStars);
}

// Days are local calendar days, "YYYY-MM-DD". Day numbers come from y/m/d, never from 24 h differences,
// so a day with 23 or 25 hours counts once.
let clock = () => new Date();
export const setClock = (fn) => void (clock = fn ?? (() => new Date()));

export function localDay(date = clock()) {
  const p = (n, len = 2) => String(n).padStart(len, "0");
  return `${p(date.getFullYear(), 4)}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
}

export const today = () => localDay(clock());

// Days since 2026-10-01 (negative before it).
export function dayNumber(day) {
  const [y, m, d] = day.split("-").map(Number);
  return Math.round((Date.UTC(y, m - 1, d) - Date.UTC(2026, 9, 1)) / 86400000);
}

// The daily streak after solving the daily of `day`: one more after yesterday, else 1.
export function streakAfter(daily, day) {
  return daily.last && dayNumber(day) === dayNumber(daily.last) + 1 ? daily.streak + 1 : 1;
}

// The streak to show on the daily card: it is over when neither today nor yesterday was solved.
export function activeStreak(daily, day) {
  if (!daily.last) return 0;
  const gap = dayNumber(day) - dayNumber(daily.last);
  return gap === 0 || gap === 1 ? daily.streak : 0;
}

export const ACHIEVEMENTS = [
  { id: "first", name: "First stitch", text: "Solve a puzzle." },
  { id: "unaided", name: "Unaided", text: "Solve a puzzle of 15×15 or larger without help." },
  { id: "brisk", name: "Brisk", text: "Earn the par star on 10 puzzles." },
  { id: "quilt", name: "Quilter", text: "Solve every puzzle in one tier." },
  { id: "week", name: "A week of thought", text: "Keep a daily streak of 7." },
  { id: "hugi", name: "Faster than action", text: "Solve a Tapestry puzzle within par and without help." },
  { id: "fine", name: "Fine work", text: "Earn three stars on 25 puzzles." },
  { id: "own", name: "A gift", text: "Solve a puzzle someone shared with you." },
];

// The ids not yet in save.ach that the save earns now. Call it after the solve is recorded in the save.
// solveEvent: {puzzle, stars, helped, pack?}. Without pack, "quilt" cannot be judged and is skipped.
// A shared puzzle counts for First stitch and A gift only: anyone can make a trivial one.
export function earnedAchievements(save, { puzzle, stars: n, helped, pack = null }) {
  const shared = puzzle.kind === "shared";
  const tierDone = () => {
    if (!pack || shared || !puzzle.tier) return false;
    const tier = pack.puzzles.filter((p) => p.tier === puzzle.tier);
    return tier.length > 0 && tier.every((p) => save.solved[p.id]);
  };
  const met = {
    first: true,
    unaided: !shared && !helped && Math.max(puzzle.w, puzzle.h) >= 15,
    brisk: save.stats.parStars >= 10,
    quilt: tierDone(),
    week: save.daily.streak >= 7,
    hugi: !shared && puzzle.tier === "tapestry" && n === 3,
    fine: save.stats.threeStars >= 25,
    own: shared,
  };
  return ACHIEVEMENTS.filter((a) => met[a.id] && !save.ach[a.id]).map((a) => a.id);
}
