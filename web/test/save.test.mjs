import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  KEY, BROKEN_KEY, VERSION, MAX_PROGRESS, freshSave, loadSave, writeSave, saveStatus, exportSave, importSave, migrate,
  spend, packState, unpackState, getProgress, putProgress, clearProgress, recordSolve, solvedCount,
} from "../game/save.js";
import { buildPack } from "../game/pack.js";
import { par } from "../game/rules.js";

const pack = buildPack(JSON.parse(readFileSync(new URL("./fixtures/pack-small.json", import.meta.url), "utf8")));

const fake = (init = {}) => {
  const m = new Map(Object.entries(init));
  return { m, getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => void m.set(k, String(v)), removeItem: (k) => void m.delete(k) };
};
const throwing = () => ({
  getItem() { throw new Error("blocked"); },
  setItem() { throw new Error("blocked"); },
});

const twill = (over = {}) => ({ id: "t-15", name: "T", w: 15, h: 15, tier: "twill", kind: "pack", rating: { probes: 0 }, ...over });

test("freshSave has the schema of the design", () => {
  const s = freshSave();
  assert.deepEqual(s, {
    v: 1, skeins: 5, solved: {}, progress: {}, daily: { last: null, streak: 0, best: 0 }, ach: {},
    stats: { parStars: 0, threeStars: 0, hints: 0, checks: 0 }, shared: {}, settings: {},
  });
  assert.equal(VERSION, 1);
});

test("load: missing key gives a fresh save", () => {
  const st = fake();
  const s = loadSave(st);
  assert.deepEqual(s, freshSave());
  assert.deepEqual(saveStatus(s), { readOnly: false, broken: false, unavailable: false, note: null });
  assert.equal(st.m.size, 0);
});

test("write then load round-trips", () => {
  const st = fake();
  const s = freshSave();
  s.skeins = 17;
  s.solved["cup-5"] = { stars: 3, best: 41, first: "2026-10-12" };
  assert.equal(writeSave(s, st), true);
  assert.deepEqual(loadSave(st), s);
});

test("a v1 save without shared (earlier build) loads with shared {}", () => {
  const old = freshSave();
  delete old.shared;
  const s = loadSave(fake({ [KEY]: JSON.stringify(old) }));
  assert.deepEqual(s.shared, {});
});

test("a corrupt value gives a fresh save and is kept under hugi-game-broken", () => {
  const st = fake({ [KEY]: "{not json" });
  const s = loadSave(st);
  assert.deepEqual(s, freshSave());
  assert.equal(st.getItem(BROKEN_KEY), "{not json");
  assert.equal(saveStatus(s).broken, true);
  assert.ok(saveStatus(s).note);
  // the first copy stays
  const st2 = fake({ [KEY]: "second", [BROKEN_KEY]: "first" });
  loadSave(st2);
  assert.equal(st2.getItem(BROKEN_KEY), "first");
});

test("wrong types and a missing version count as corrupt", () => {
  for (const bad of ['{"v":1,"skeins":"9","solved":{}}', '{"skeins":5,"solved":{}}', "[]", "7", "null", '{"v":1.5,"skeins":5,"solved":{}}']) {
    const st = fake({ [KEY]: bad });
    assert.deepEqual(loadSave(st), freshSave(), bad);
    assert.equal(st.getItem(BROKEN_KEY), bad);
  }
});

test("storage that throws: fresh save, says it cannot save, write returns false", () => {
  const s = loadSave(throwing());
  assert.deepEqual(s, freshSave());
  assert.equal(saveStatus(s).unavailable, true);
  assert.equal(writeSave(s, throwing()), false);
  assert.equal(loadSave(null).skeins, 5);
  const ok = freshSave();
  assert.equal(writeSave(ok, throwing()), false);
  assert.equal(saveStatus(ok).unavailable, true);
  // a throwing BROKEN write must not stop the load
  const st = { getItem: (k) => (k === KEY ? "oops" : null), setItem() { throw new Error("full"); } };
  assert.deepEqual(loadSave(st), freshSave());
});

test("a newer v opens read-only and is never written", () => {
  const future = { ...freshSave(), v: 2, skeins: 40, extra: { anything: true } };
  const st = fake({ [KEY]: JSON.stringify(future) });
  const s = loadSave(st);
  assert.equal(s.skeins, 40);
  assert.equal(saveStatus(s).readOnly, true);
  assert.ok(saveStatus(s).note);
  s.skeins = 1;
  assert.equal(writeSave(s, st), false);
  assert.equal(JSON.parse(st.getItem(KEY)).skeins, 40);
  assert.equal(st.getItem(BROKEN_KEY), null);
  // a newer save this version cannot read at all
  const odd = fake({ [KEY]: '{"v":3,"skeins":{"new":"shape"}}' });
  const s2 = loadSave(odd);
  assert.equal(saveStatus(s2).readOnly, true);
  assert.equal(odd.getItem(BROKEN_KEY), null);
  assert.equal(writeSave(s2, odd), false);
});

test("migrations run in order", () => {
  const migrations = { 0: (s) => ({ ...s, coins: s.coins ?? 0 }), 1: (s) => ({ ...s, shared: {} }) };
  const out = migrate({ v: 0, skeins: 5 }, migrations, 2);
  assert.deepEqual(out, { v: 2, skeins: 5, coins: 0, shared: {} });
  assert.throws(() => migrate({ v: 0 }, {}, 1), /No migration/);
  const input = { v: 0, a: 1 };
  migrate(input, { 0: (s) => ((s.a = 2), s) }, 1);
  assert.equal(input.a, 1); // the step works on a copy
  assert.deepEqual(migrate(freshSave()), freshSave());
});

test("export and import round-trip a populated v1 save", () => {
  const s = freshSave();
  s.skeins = 17;
  s.solved["cup-5"] = { stars: 3, best: 41, first: "2026-10-12", par: true };
  putProgress(s, "pets-15", { state: new Uint8Array([0, 1, 2, 1, 0, 2]), seconds: 95, helped: false }, 1760270400000);
  s.daily = { last: "2026-10-12", streak: 3, best: 5 };
  s.ach = { first: "2026-10-12" };
  s.stats = { parStars: 4, threeStars: 2, hints: 3, checks: 1 };
  s.shared["s-9f3a12c4"] = { w: 15, h: 15, bits: "AAoA", title: "Rabbit å", author: "Ann", unique: true, stars: 2, best: 301, first: "2026-10-12", at: 1760270400000 };
  s.settings = { sound: false, name: "x" };
  const text = exportSave(s);
  assert.match(text, /\n  "v": 1,/);
  assert.deepEqual(importSave(text), s);
  assert.deepEqual(importSave(exportSave(freshSave())), freshSave());
});

test("import rejects wrong types and never lets non-numbers into skeins or stars", () => {
  const base = () => JSON.parse(exportSave(freshSave()));
  const bad = [
    (s) => (s.skeins = "99"),
    (s) => (s.skeins = -1),
    (s) => (s.skeins = 1.5),
    (s) => (s.skeins = null),
    (s) => (s.skeins = 1e30),
    (s) => (s.solved = []),
    (s) => (s.solved.x = { stars: "3", best: 1, first: "2026-10-12" }),
    (s) => (s.solved.x = { stars: 4, best: 1, first: "2026-10-12" }),
    (s) => (s.solved.x = { stars: 0, best: 1, first: "2026-10-12" }),
    (s) => (s.solved.x = { stars: 2, best: "1", first: "2026-10-12" }),
    (s) => (s.solved.x = { stars: 2, best: 1, first: "yesterday" }),
    (s) => (s.solved.x = null),
    (s) => (s.stats.hints = "3"),
    (s) => (s.stats = []),
    (s) => (s.daily.streak = "3"),
    (s) => (s.daily.last = 20261012),
    (s) => (s.ach.first = true),
    (s) => (s.progress.p = { cells: "A A", seconds: 1, helped: false, at: 1 }),
    (s) => (s.progress.p = { cells: "AAA", seconds: "1", helped: false, at: 1 }),
    (s) => (s.progress.p = { cells: "AAA", seconds: 1, helped: "no", at: 1 }),
    (s) => (s.shared.p = { w: 0, h: 5, bits: "A", title: "", author: "", unique: true, stars: 0, best: null, first: null, at: 1 }),
    (s) => (s.shared.p = { w: 5, h: 5, bits: "A", title: "x".repeat(41), author: "", unique: true, stars: 0, best: null, first: null, at: 1 }),
    (s) => (s.settings.a = { nested: 1 }),
    (s) => (s.v = "1"),
    (s) => delete s.skeins,
    (s) => delete s.solved,
  ];
  for (const [i, f] of bad.entries()) {
    const s = base();
    f(s);
    assert.ok("error" in importSave(JSON.stringify(s)), `case ${i}: ${JSON.stringify(s).slice(0, 120)}`);
  }
  for (const t of ["", "nope", "[]", "null", "42", '"x"', "{}"]) assert.ok("error" in importSave(t), t);
  assert.ok("error" in importSave(JSON.stringify({ ...base(), v: 2 })));
  assert.ok("error" in importSave('{"v":1,"skeins":5,"solved":{"__proto__":{"stars":3,"best":1,"first":"2026-10-12"}}}'));
});

test("import drops fields it does not know and cannot pollute prototypes", () => {
  const s = JSON.parse(exportSave(freshSave()));
  s.evil = { a: 1 };
  s.solved.x = { stars: 2, best: 9, first: "2026-10-12", extra: "y" };
  const out = importSave(JSON.stringify(s));
  assert.equal(out.evil, undefined);
  assert.deepEqual(out.solved.x, { stars: 2, best: 9, first: "2026-10-12" });
  assert.equal({}.stars, undefined);
});

test("import trims progress to 10 and shared to 100 entries, oldest first", () => {
  const s = JSON.parse(exportSave(freshSave()));
  for (let i = 0; i < 14; i++) s.progress[`p${i}`] = { cells: "AAAA", seconds: i, helped: false, at: 1000 + i };
  for (let i = 0; i < 103; i++) s.shared[`s${i}`] = { w: 5, h: 5, bits: "AAAA", title: "", author: "", unique: true, stars: 0, best: null, first: null, at: 1000 + i };
  const out = importSave(JSON.stringify(s));
  assert.equal(Object.keys(out.progress).length, 10);
  assert.ok(out.progress.p13 && !out.progress.p3 && out.progress.p4);
  assert.equal(Object.keys(out.shared).length, 100);
  assert.ok(!out.shared.s2 && out.shared.s3);
});

test("solvedCount", () => {
  const s = freshSave();
  assert.equal(solvedCount(s), 0);
  s.solved.a = { stars: 1, best: 1, first: "2026-10-12" };
  assert.equal(solvedCount(s), 1);
});

test("packState and unpackState: 2 bits per cell", () => {
  const state = Uint8Array.from([0, 1, 2, 1, 2, 2, 0, 1, 1]);
  const text = packState(state);
  assert.match(text, /^[A-Za-z0-9_-]+$/);
  assert.deepEqual(unpackState(9, text), state);
  // cell i is in bits 2*(i&3) of byte i>>2: [0,1,2,1] = 0 | 1<<2 | 2<<4 | 1<<6 = 0x64
  assert.equal(packState(Uint8Array.from([0, 1, 2, 1])), "ZA");
  assert.equal(packState(new Uint8Array(0)), "");
  const big = Uint8Array.from({ length: 2500 }, (_, i) => i % 3);
  assert.deepEqual(unpackState(2500, packState(big)), big);
  assert.equal(packState(new Uint8Array(2500)).length, Math.ceil((625 * 4) / 3));
  assert.deepEqual(unpackState(4, "_w"), Uint8Array.from([0, 0, 0, 0])); // 0xff: all 3s read as unknown
  assert.throws(() => unpackState(4, "!!"));
});

test("progress: get, put, clear", () => {
  const s = freshSave();
  assert.equal(getProgress(s, "a"), null);
  const state = Uint8Array.from([1, 0, 2, 0, 1]);
  putProgress(s, "a", { state, seconds: 12, helped: true }, 5);
  assert.deepEqual(getProgress(s, "a", 5), { state, seconds: 12, helped: true });
  assert.equal(getProgress(s, "a").state.length, 8); // padded to the last byte without n
  assert.equal(s.progress.a.at, 5);
  putProgress(s, "a", { state, seconds: 20, helped: true }, 9);
  assert.equal(Object.keys(s.progress).length, 1);
  assert.equal(getProgress(s, "a", 5).seconds, 20);
  clearProgress(s, "a");
  assert.equal(getProgress(s, "a"), null);
  s.progress.bad = { cells: "!!", seconds: 1, helped: false, at: 1 };
  assert.equal(getProgress(s, "bad", 4), null);
  assert.equal(getProgress(s, "__proto__"), null);
});

test("progress keeps at most 10 entries; the oldest at goes first", () => {
  const s = freshSave();
  const state = new Uint8Array(4);
  for (let i = 0; i < 12; i++) putProgress(s, `p${i}`, { state, seconds: i, helped: false }, 100 + i);
  assert.equal(Object.keys(s.progress).length, MAX_PROGRESS);
  assert.ok(!s.progress.p0 && !s.progress.p1 && s.progress.p2 && s.progress.p11);
  putProgress(s, "p2", { state, seconds: 1, helped: false }, 500); // refreshed, so p3 is now the oldest
  putProgress(s, "new", { state, seconds: 1, helped: false }, 501);
  assert.ok(s.progress.p2 && !s.progress.p3 && s.progress.new);
  assert.equal(Object.keys(s.progress).length, 10);
});

test("spend", () => {
  const s = freshSave();
  assert.equal(spend(s, 2), true);
  assert.equal(s.skeins, 3);
  assert.equal(spend(s, 4), false);
  assert.equal(s.skeins, 3);
  assert.equal(spend(s, -1), false);
  assert.equal(spend(s, 1.5), false);
  assert.equal(spend(s, "1"), false);
  assert.equal(spend(s, 1, "hint"), true);
  assert.equal(spend(s, 1, "check"), true);
  assert.deepEqual([s.stats.hints, s.stats.checks, s.skeins], [1, 1, 1]);
  assert.equal(spend(s, 5, "hint"), false);
  assert.equal(s.stats.hints, 1);
});

test("recordSolve: first Twill solve with 3 stars earns 6 (plus First stitch and Unaided)", () => {
  const s = freshSave();
  const p = twill();
  assert.equal(par(p), 330);
  const r = recordSolve(s, { puzzle: p, seconds: 300, helped: false, day: "2026-10-12" });
  assert.deepEqual(r, { stars: 3, bestStars: 3, earned: 6, bonus: 10, newAch: ["first", "unaided"] });
  assert.equal(s.skeins, 5 + 6 + 10);
  assert.deepEqual(s.solved["t-15"], { stars: 3, best: 300, first: "2026-10-12", par: true });
  assert.deepEqual(s.ach, { first: "2026-10-12", unaided: "2026-10-12" });
  assert.deepEqual(s.stats, { parStars: 1, threeStars: 1, hints: 0, checks: 0 });
});

test("recordSolve: a replay pays the extra stars only and keeps the best", () => {
  const s = freshSave();
  const p = twill();
  assert.equal(recordSolve(s, { puzzle: p, seconds: 500, helped: true, day: "2026-10-12" }).earned, 3 + 1);
  const skeins = s.skeins;
  let r = recordSolve(s, { puzzle: p, seconds: 400, helped: false, day: "2026-10-13" });
  assert.deepEqual([r.stars, r.earned, r.bonus], [2, 1, 5]); // Unaided now
  assert.equal(s.skeins, skeins + 1 + 5);
  r = recordSolve(s, { puzzle: p, seconds: 600, helped: true, day: "2026-10-14" });
  assert.deepEqual([r.stars, r.bestStars, r.earned, r.newAch], [1, 2, 0, []]);
  assert.deepEqual(s.solved["t-15"], { stars: 2, best: 400, first: "2026-10-12" });
  recordSolve(s, { puzzle: p, seconds: 100, helped: false, day: "2026-10-15" });
  assert.equal(s.solved["t-15"].stars, 3);
  assert.deepEqual(s.stats, { parStars: 1, threeStars: 1, hints: 0, checks: 0 });
  recordSolve(s, { puzzle: p, seconds: 90, helped: false, day: "2026-10-16" });
  assert.equal(s.stats.parStars, 1); // counted once per puzzle
  assert.equal(s.stats.threeStars, 1);
});

test("recordSolve: the daily pays 5 + streak once a day and keeps the streak", () => {
  const s = freshSave();
  const d = (id) => ({ ...twill({ id }), kind: "daily" });
  let r = recordSolve(s, { puzzle: d("d1"), seconds: 100, helped: true, day: "2026-10-12" });
  assert.equal(r.earned, 6);
  assert.deepEqual(s.daily, { last: "2026-10-12", streak: 1, best: 1 });
  r = recordSolve(s, { puzzle: d("d1"), seconds: 90, helped: true, day: "2026-10-12" });
  assert.equal(r.earned, 0);
  assert.equal(s.daily.streak, 1);
  r = recordSolve(s, { puzzle: d("d2"), seconds: 100, helped: true, day: "2026-10-13" });
  assert.equal(r.earned, 7);
  assert.equal(s.daily.streak, 2);
  r = recordSolve(s, { puzzle: d("d3"), seconds: 100, helped: true, day: "2026-10-15" }); // a gap
  assert.deepEqual([r.earned, s.daily.streak, s.daily.best], [6, 1, 2]);
});

test("recordSolve: a streak of 7 earns A week of thought; the earned cap is 10", () => {
  const s = freshSave();
  let last;
  for (let i = 0; i < 7; i++) {
    last = recordSolve(s, { puzzle: { ...twill({ id: `d${i}` }), kind: "daily" }, seconds: 999, helped: true, day: `2026-10-${String(12 + i).padStart(2, "0")}` });
  }
  assert.equal(last.earned, 10);
  assert.ok(last.newAch.includes("week"));
  assert.equal(s.daily.best, 7);
});

test("recordSolve: Quilter needs the pack; Brisk after 10 par stars", () => {
  const s = freshSave();
  const [a, b, c] = pack.puzzles.slice(0, 3);
  recordSolve(s, { puzzle: a, seconds: 50, helped: true, day: "2026-10-12", pack });
  recordSolve(s, { puzzle: b, seconds: 50, helped: true, day: "2026-10-12", pack });
  const r = recordSolve(s, { puzzle: c, seconds: 50, helped: true, day: "2026-10-12", pack });
  assert.deepEqual(r.newAch, ["quilt"]);

  const t = freshSave();
  let res;
  for (let i = 0; i < 10; i++) res = recordSolve(t, { puzzle: twill({ id: `p${i}` }), seconds: 10, helped: true, day: "2026-10-12" });
  assert.ok(res.newAch.includes("brisk"));
});

test("recordSolve: a shared puzzle pays 0, stores stars, earns A gift once", () => {
  const s = freshSave();
  const p = { id: "s-9f3a12c4", name: "Rabbit", title: "Rabbit", author: "Ann", w: 15, h: 15, bits: "AAoA", tier: "twill", kind: "shared", rating: { probes: 0 }, unique: true };
  let r = recordSolve(s, { puzzle: p, seconds: 301, helped: false, day: "2026-10-12", now: 7 });
  assert.deepEqual(r, { stars: 3, bestStars: 3, earned: 0, bonus: 10, newAch: ["first", "own"] });
  assert.equal(s.skeins, 15);
  assert.deepEqual(s.solved, {});
  assert.deepEqual(s.shared["s-9f3a12c4"], { w: 15, h: 15, bits: "AAoA", title: "Rabbit", author: "Ann", unique: true, stars: 3, best: 301, first: "2026-10-12", at: 7 });
  assert.deepEqual(s.stats, { parStars: 0, threeStars: 0, hints: 0, checks: 0 });
  r = recordSolve(s, { puzzle: p, seconds: 280, helped: true, day: "2026-10-13", now: 9 });
  assert.deepEqual([r.earned, r.bonus, r.stars, r.bestStars], [0, 0, 2, 3]);
  assert.equal(s.shared["s-9f3a12c4"].best, 280);
  assert.equal(s.shared["s-9f3a12c4"].first, "2026-10-12");
  // the result is a valid save
  assert.deepEqual(importSave(exportSave(s)), s);
});

test("recordSolve: a recorded save survives write and load", () => {
  const st = fake();
  const s = loadSave(st);
  recordSolve(s, { puzzle: pack.puzzles[0], seconds: 40, helped: false, day: "2026-10-12", pack });
  writeSave(s, st);
  assert.deepEqual(loadSave(st), s);
  assert.equal(loadSave(st).solved["cup-5"].stars, 3);
});
