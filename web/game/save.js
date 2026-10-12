// The save in localStorage["hugi-game"]: schema, migrations, validation, progress and solve records.
// Pure apart from the storage it is given. Every storage access is in try/catch.

import { START_SKEINS, ACHIEVEMENT_REWARD, par, stars, reward, streakAfter, earnedAchievements } from "./rules.js?v=dev";

/**
 * @typedef {{v: number, skeins: number, solved: Object, progress: Object, daily: {last: string|null, streak: number, best: number},
 *   ach: Object, stats: {parStars: number, threeStars: number, hints: number, checks: number}, shared: Object, settings: Object}} Save
 */

export const KEY = "hugi-game";
export const BROKEN_KEY = "hugi-game-broken";
export const VERSION = 1;
export const MAX_PROGRESS = 10;
export const MAX_SHARED = 100;

// MIGRATIONS[v] takes a save of version v and returns one of version v + 1. None yet: v1 is the first.
export const MIGRATIONS = {};

export function freshSave() {
  return {
    v: VERSION,
    skeins: START_SKEINS,
    solved: {},
    progress: {},
    daily: { last: null, streak: 0, best: 0 },
    ach: {},
    stats: { parStars: 0, threeStars: 0, hints: 0, checks: 0 },
    shared: {},
    settings: {},
  };
}

// --- validation: builds a clean copy, so an import can never carry foreign fields or types into the save ---

const fail = (path, what) => {
  throw new Error(`${path} ${what}`);
};
const isObj = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
const isInt = (x, lo, hi = Infinity) => Number.isSafeInteger(x) && x >= lo && x <= hi;
const isSecs = (x) => typeof x === "number" && Number.isFinite(x) && x >= 0;
const isDay = (x) => typeof x === "string" && /^\d{4}-\d{2}-\d{2}$/.test(x);
const isB64 = (x, max) => typeof x === "string" && x.length <= max && /^[A-Za-z0-9_-]*$/.test(x);

const int = (x, path, lo, hi) => (isInt(x, lo, hi) ? x : fail(path, `must be a whole number from ${lo}${hi ? ` to ${hi}` : ""}`));
const secs = (x, path) => (isSecs(x) ? x : fail(path, "must be a number of seconds"));
const day = (x, path) => (isDay(x) ? x : fail(path, "must be a date YYYY-MM-DD"));
const bool = (x, path) => (typeof x === "boolean" ? x : fail(path, "must be true or false"));
const text = (x, path, max) => (typeof x === "string" && x.length <= max ? x : fail(path, `must be text of at most ${max} characters`));

function mapOf(raw, path, each) {
  if (!isObj(raw)) fail(path, "must be an object");
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    if (k === "__proto__" || k.length > 64) fail(path, `has a bad key "${k.slice(0, 20)}"`);
    out[k] = each(v, `${path}.${k}`);
  }
  return out;
}

function entry(raw, path, fields) {
  if (!isObj(raw)) fail(path, "must be an object");
  return fields(raw);
}

// Drops the entries with the oldest `at` until at most `max` remain.
function trimOldest(map, max) {
  const ids = Object.keys(map);
  if (ids.length <= max) return;
  ids.sort((a, b) => map[a].at - map[b].at);
  for (const id of ids.slice(0, ids.length - max)) delete map[id];
}

const orDefault = (raw, key, def, check) => (raw[key] === undefined ? def : check(raw[key], key));

// Validates a parsed save of the current version. Throws an Error with a plain message.
function validate(raw) {
  if (!isObj(raw)) fail("The save", "must be an object");
  const fresh = freshSave();
  const save = {
    v: int(raw.v, "v", 1),
    skeins: int(raw.skeins, "skeins", 0, 1e9),
    solved: mapOf(raw.solved, "solved", (e, p) =>
      entry(e, p, (r) => {
        const out = { stars: int(r.stars, `${p}.stars`, 1, 3), best: secs(r.best, `${p}.best`), first: day(r.first, `${p}.first`) };
        if (r.par !== undefined) out.par = bool(r.par, `${p}.par`);
        return out;
      }),
    ),
    progress: orDefault(raw, "progress", {}, (m, p) =>
      mapOf(m, p, (e, q) =>
        entry(e, q, (r) => ({
          cells: isB64(r.cells, 4000) ? r.cells : fail(`${q}.cells`, "must be base64url text"),
          seconds: secs(r.seconds, `${q}.seconds`),
          helped: bool(r.helped, `${q}.helped`),
          at: secs(r.at, `${q}.at`),
        })),
      ),
    ),
    daily: orDefault(raw, "daily", fresh.daily, (r, p) =>
      entry(r, p, (d) => ({
        last: d.last === null ? null : day(d.last, `${p}.last`),
        streak: int(d.streak, `${p}.streak`, 0, 1e6),
        best: int(d.best, `${p}.best`, 0, 1e6),
      })),
    ),
    ach: orDefault(raw, "ach", {}, (m, p) => mapOf(m, p, day)),
    stats: orDefault(raw, "stats", fresh.stats, (r, p) =>
      entry(r, p, (s) => {
        const out = {};
        for (const k of Object.keys(fresh.stats)) out[k] = s[k] === undefined ? 0 : int(s[k], `${p}.${k}`, 0, 1e9);
        return out;
      }),
    ),
    shared: orDefault(raw, "shared", {}, (m, p) =>
      mapOf(m, p, (e, q) =>
        entry(e, q, (r) => ({
          w: int(r.w, `${q}.w`, 1, 100),
          h: int(r.h, `${q}.h`, 1, 100),
          bits: isB64(r.bits, 2000) ? r.bits : fail(`${q}.bits`, "must be base64url text"),
          title: text(r.title, `${q}.title`, 40),
          author: text(r.author, `${q}.author`, 40),
          unique: bool(r.unique, `${q}.unique`),
          stars: int(r.stars, `${q}.stars`, 0, 3),
          best: r.best === null ? null : secs(r.best, `${q}.best`),
          first: r.first === null ? null : day(r.first, `${q}.first`),
          at: secs(r.at, `${q}.at`),
        })),
      ),
    ),
    settings: orDefault(raw, "settings", {}, (m, p) =>
      mapOf(m, p, (x, q) => (x === null || ["string", "number", "boolean"].includes(typeof x) ? x : fail(q, "must be text, a number or true/false"))),
    ),
  };
  trimOldest(save.progress, MAX_PROGRESS);
  trimOldest(save.shared, MAX_SHARED);
  return save;
}

// Runs the migrations from raw.v up to `target`. Throws when a step is missing.
export function migrate(raw, migrations = MIGRATIONS, target = VERSION) {
  let save = raw;
  while (save.v < target) {
    const step = migrations[save.v];
    if (!step) throw new Error(`No migration from version ${save.v}`);
    const v = save.v;
    save = { ...step(structuredClone(save)), v: v + 1 };
  }
  return save;
}

// Text to a Save: {save} or {error}. A newer version is {save, newer: true} when it reads, else {error}.
function parse(raw) {
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return { error: "The save is not readable JSON." };
  }
  if (!isObj(data) || !isInt(data.v, 1)) return { error: "The save has no version." };
  try {
    if (data.v > VERSION) return { save: validate(data), newer: true };
    return { save: validate(migrate(data)) };
  } catch (e) {
    return { error: e.message };
  }
}

// --- storage ---

const meta = new WeakMap(); // save -> {readOnly, broken, unavailable, note}

function defaultStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function tag(save, m) {
  meta.set(save, { readOnly: false, broken: false, unavailable: false, note: null, ...m });
  return save;
}

// What the page should tell the player: {readOnly, broken, unavailable, note}.
export const saveStatus = (save) => meta.get(save) ?? { readOnly: false, broken: false, unavailable: false, note: null };

export function loadSave(storage = defaultStorage()) {
  let raw = null;
  try {
    raw = storage.getItem(KEY);
  } catch {
    return tag(freshSave(), { unavailable: true, note: "This browser blocks saving, so your progress will be lost when you close the page." });
  }
  if (raw === null || raw === undefined) return tag(freshSave(), {});
  const res = parse(raw);
  if (res.newer) {
    return tag(res.save, { readOnly: true, note: "This save comes from a newer version of Hugi. It is open for reading and will not be changed." });
  }
  if (res.save) return tag(res.save, {});
  try {
    const parsed = JSON.parse(raw);
    if (isObj(parsed) && isInt(parsed.v, VERSION + 1)) {
      return tag(freshSave(), { readOnly: true, note: "This save comes from a newer version of Hugi. It is not changed." });
    }
  } catch {
    // unreadable: keep a copy below
  }
  try {
    if (storage.getItem(BROKEN_KEY) === null) storage.setItem(BROKEN_KEY, raw); // the first copy stays
  } catch {
    // no room for the copy: the fresh save still plays
  }
  return tag(freshSave(), { broken: true, note: "The saved progress could not be read. A copy is kept and you start again." });
}

// True when the save reached storage. A read-only save is never written.
export function writeSave(save, storage = defaultStorage()) {
  const m = saveStatus(save);
  if (m.readOnly) return false;
  try {
    storage.setItem(KEY, JSON.stringify(save));
    return true;
  } catch {
    tag(save, { ...m, unavailable: true, note: "This browser blocks saving, so your progress will be lost when you close the page." });
    return false;
  }
}

export const exportSave = (save) => JSON.stringify(save, null, 2);

export function importSave(text) {
  const res = parse(text);
  if (res.newer) return { error: "This save comes from a newer version of Hugi." };
  return res.save ?? { error: res.error };
}

// The number of solved pictures, for the confirm before a load replaces the save.
export const solvedCount = (save) => Object.keys(save.solved).length;

// --- skeins ---

// Takes `amount` skeins when the player has them. kind "hint" or "check" counts in the stats.
export function spend(save, amount, kind = null) {
  if (!isInt(amount, 0) || save.skeins < amount) return false;
  save.skeins -= amount;
  if (kind === "hint") save.stats.hints++;
  else if (kind === "check") save.stats.checks++;
  return true;
}

// --- board in progress: 2 bits per cell, cell i in bits 2*(i&3) of byte i>>2, base64url ---

export function packState(state) {
  const bytes = new Uint8Array(Math.ceil(state.length / 4));
  for (let i = 0; i < state.length; i++) bytes[i >> 2] |= (state[i] & 3) << (2 * (i & 3));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// n cells. A value of 3 never comes from packState and reads as unknown. Throws on text that is not base64url.
export function unpackState(n, s) {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const v = (bin.charCodeAt(i >> 2) >> (2 * (i & 3))) & 3;
    out[i] = v === 3 ? 0 : v;
  }
  return out;
}

// {state, seconds, helped} or null. n is the cell count (w*h); without it the state has the padding of the last byte.
export function getProgress(save, id, n = null) {
  const p = Object.hasOwn(save.progress, id) ? save.progress[id] : null;
  if (!p) return null;
  try {
    return { state: unpackState(n ?? Math.floor((p.cells.length * 3) / 4) * 4, p.cells), seconds: p.seconds, helped: p.helped };
  } catch {
    return null;
  }
}

export function putProgress(save, id, { state, seconds, helped }, now = Date.now()) {
  save.progress[id] = { cells: packState(state), seconds, helped, at: now };
  trimOldest(save.progress, MAX_PROGRESS);
}

export function clearProgress(save, id) {
  delete save.progress[id];
}

// --- a solve ---

// Records a solve and mutates the save: stars and best time kept, skeins paid, streak, stats, achievements.
// puzzle.kind picks the rules (§4): "shared" pays 0 skeins and goes to save.shared, "daily" pays once a day.
// pack (optional) lets "Quilter" be judged. Returns {stars: of this solve, bestStars, earned: skeins for the
// puzzle, bonus: skeins for the achievements, newAch: ids}. The save's skeins grow by earned + bonus.
export function recordSolve(save, { puzzle, seconds, helped, day, pack = null, now = Date.now() }) {
  const n = stars({ seconds, helped, par: par(puzzle) });
  const parStar = seconds <= par(puzzle);
  let prevStars;
  let bestStars;
  let streak = 0;

  if (puzzle.kind === "shared") {
    const e = (save.shared[puzzle.id] ??= {
      w: puzzle.w,
      h: puzzle.h,
      bits: puzzle.bits ?? "",
      title: String(puzzle.title ?? puzzle.name ?? "").slice(0, 40),
      author: String(puzzle.author ?? "").slice(0, 40),
      unique: puzzle.unique ?? true,
      stars: 0,
      best: null,
      first: null,
      at: now,
    });
    prevStars = e.stars;
    e.stars = bestStars = Math.max(e.stars, n);
    e.best = e.best === null ? seconds : Math.min(e.best, seconds);
    e.first ??= day;
    e.at = now;
    trimOldest(save.shared, MAX_SHARED);
  } else {
    const e = save.solved[puzzle.id];
    prevStars = e?.stars ?? 0;
    const s = (save.solved[puzzle.id] = e ?? { stars: n, best: seconds, first: day });
    s.stars = bestStars = Math.max(s.stars, n);
    s.best = Math.min(s.best, seconds);
    if (parStar && !s.par) {
      s.par = true;
      save.stats.parStars++;
    }
    if (prevStars < 3 && s.stars === 3) save.stats.threeStars++;
    if (puzzle.kind === "daily" && save.daily.last !== day) {
      save.daily.streak = streak = streakAfter(save.daily, day);
      save.daily.best = Math.max(save.daily.best, streak);
      save.daily.last = day;
    }
  }

  const earned = reward({ puzzle, stars: n, prevStars, streak });
  save.skeins += earned;
  const newAch = earnedAchievements(save, { puzzle, stars: n, helped, pack });
  for (const id of newAch) save.ach[id] = day;
  const bonus = newAch.length * ACHIEVEMENT_REWARD;
  save.skeins += bonus;
  return { stars: n, bestStars, earned, bonus, newAch };
}
