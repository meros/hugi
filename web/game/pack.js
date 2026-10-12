// The pack: loading, the daily puzzle, tier locks and the next puzzle. Pure apart from loadPack's fetch.

import { unpackBits, cluesOf } from "../grid.js?v=dev";
import { dayNumber, localDay, DAILY_OPENS_AFTER } from "./rules.js?v=dev";

/** @typedef {{id: string, name: string, w: number, h: number, bits: string, solution: Uint8Array, rows: number[][], cols: number[][],
 *   thread: number, tier: string|null, rating: Object, note?: string, kind: "pack"|"daily"|"shared"}} Puzzle */

// The daily step: 37 is coprime with a pool of 60, so day -> pool index is a permutation and
// consecutive days are far apart. A pool whose size shares a factor with 37 would repeat early.
const DAILY_STEP = 37;

function hydrate(p, kind) {
  const solution = unpackBits(p.w, p.h, p.bits);
  return { ...p, solution, ...cluesOf(p.w, p.h, solution), kind };
}

// The pack JSON to a Pack: every puzzle gets its solution, clues and kind, and byId finds any of them.
export function buildPack(json) {
  const puzzles = json.puzzles.map((p) => hydrate(p, "pack"));
  const daily = (json.daily ?? []).map((p) => hydrate(p, "daily"));
  const byId = new Map([...puzzles, ...daily].map((p) => [p.id, p]));
  return { version: json.version, credits: json.credits, tiers: json.tiers, puzzles, daily, byId };
}

// `?pack=<path>` in the page URL loads another pack (a small fixture for the e2e tests and for
// screen work); the default is the shipped pack.json.
export async function loadPack() {
  const override = typeof location === "undefined" ? null : new URLSearchParams(location.search).get("pack");
  const url = override && /^[\w./-]+\.json$/.test(override) && !override.includes("..") ? override : "pack.json?v=dev";
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return buildPack(await res.json());
}

// The puzzle of a local calendar day. date is a Date or "YYYY-MM-DD".
export function dailyFor(pack, date = new Date()) {
  const day = typeof date === "string" ? date : localDay(date);
  const n = pack.daily.length;
  const puzzle = n ? pack.daily[(((dayNumber(day) * DAILY_STEP) % n) + n) % n] : null;
  return { puzzle, day };
}

const isSolved = (save, p) => Object.hasOwn(save.solved, p.id);

// The daily opens after the first campaign puzzles are solved.
export const dailyOpen = (pack, save) => pack.puzzles.filter((p) => isSolved(save, p)).length >= DAILY_OPENS_AFTER;

// {open, solved: in this tier, total: in this tier, need: the tier's `opens`, have: solved in the previous tier}.
export function tierState(pack, save, tierId) {
  const at = pack.tiers.findIndex((t) => t.id === tierId);
  if (at < 0) throw new Error(`Unknown tier ${tierId}`);
  const count = (id) => pack.puzzles.filter((p) => p.tier === id && isSolved(save, p)).length;
  const need = pack.tiers[at].opens;
  const have = at === 0 ? 0 : count(pack.tiers[at - 1].id);
  return {
    open: at === 0 || have >= need,
    solved: count(tierId),
    total: pack.puzzles.filter((p) => p.tier === tierId).length,
    need,
    have,
  };
}

// The next unsolved puzzle of an open tier after afterId in campaign order, wrapping round; null when none.
export function nextPuzzle(pack, save, afterId) {
  const open = new Map(pack.tiers.map((t) => [t.id, tierState(pack, save, t.id).open]));
  const from = pack.puzzles.findIndex((p) => p.id === afterId);
  const n = pack.puzzles.length;
  for (let k = 1; k <= n; k++) {
    const p = pack.puzzles[(from + k + n) % n];
    if (p.id !== afterId && open.get(p.tier) && !isSolved(save, p)) return p;
  }
  return null;
}

// A puzzle shared from the Maker (§5b) lives in shared.js; pack.js keeps the export for its callers.
export { sharedPuzzle } from "./shared.js?v=dev";
