import test from "node:test";
import assert from "node:assert/strict";
import {
  par, stars, reward, PRICES, START_SKEINS, ACHIEVEMENTS, earnedAchievements,
  dayNumber, localDay, streakAfter, activeStreak, setClock, today,
} from "../game/rules.js";
import { freshSave } from "../game/save.js";

const pz = (w, h, tier, extra = {}) => ({ id: `${tier}-${w}`, w, h, tier, kind: "pack", rating: { probes: 0 }, ...extra });

test("prices and start", () => {
  assert.deepEqual(PRICES, { nudge: 1, cell: 2, line: 5, track: 1, mistakes: 3 });
  assert.equal(START_SKEINS, 5);
});

test("par", () => {
  assert.equal(par(pz(5, 5, "tabby")), 60);
  assert.equal(par(pz(15, 15, "twill")), 330);
  assert.equal(par(pz(10, 10, "tabby")), 210);
  assert.equal(par(pz(20, 20, "satin")), 480);
  assert.equal(par(pz(30, 30, "brocade")), 990);
  assert.equal(par(pz(50, 50, "tapestry")), 2520); // 42 minutes
  assert.equal(par(pz(10, 10, "brocade", { rating: { probes: 8 } })), 270); // 110 + 160 = 270
  assert.equal(par(pz(5, 5, "tabby", { rating: undefined })), 60);
});

test("par rounds up to 30 s and never tips over on float noise", () => {
  assert.equal(par(pz(50, 1, "satin")), 60); // 50 * 1.2 = 60 exactly
  assert.equal(par(pz(25, 5, "tapestry")), 150); // 125 -> 150
  assert.equal(par(pz(30, 1, "tapestry")), 60);
  assert.equal(par(pz(31, 3, "tapestry")), 120); // 93 -> 120
});

test("stars", () => {
  assert.equal(stars({ seconds: 100, helped: false, par: 330 }), 3);
  assert.equal(stars({ seconds: 330, helped: false, par: 330 }), 3);
  assert.equal(stars({ seconds: 331, helped: false, par: 330 }), 2);
  assert.equal(stars({ seconds: 100, helped: true, par: 330 }), 2);
  assert.equal(stars({ seconds: 400, helped: true, par: 330 }), 1);
});

test("reward: first solve is tier base plus stars", () => {
  const twill = pz(15, 15, "twill");
  assert.equal(reward({ puzzle: twill, stars: 3, prevStars: 0 }), 6);
  assert.equal(reward({ puzzle: pz(5, 5, "tabby"), stars: 1 }), 3);
  assert.equal(reward({ puzzle: pz(50, 50, "tapestry"), stars: 2, prevStars: undefined }), 10);
  assert.equal(reward({ puzzle: pz(30, 30, "brocade"), stars: 3 }), 9);
  assert.equal(reward({ puzzle: pz(20, 20, "satin"), stars: 1 }), 5);
});

test("reward: a replay pays only the extra stars", () => {
  const twill = pz(15, 15, "twill");
  assert.equal(reward({ puzzle: twill, stars: 3, prevStars: 1 }), 2);
  assert.equal(reward({ puzzle: twill, stars: 2, prevStars: 2 }), 0);
  assert.equal(reward({ puzzle: twill, stars: 1, prevStars: 3 }), 0);
});

test("reward: daily and shared", () => {
  const daily = pz(15, 15, "twill", { kind: "daily" });
  assert.equal(reward({ puzzle: daily, stars: 3, streak: 1 }), 6);
  assert.equal(reward({ puzzle: daily, stars: 3, streak: 5 }), 10);
  assert.equal(reward({ puzzle: daily, stars: 3, streak: 40 }), 10);
  assert.equal(reward({ puzzle: daily, stars: 3, streak: 0 }), 0);
  assert.equal(reward({ puzzle: pz(15, 15, "twill", { kind: "shared" }), stars: 3 }), 0);
});

test("days are local calendar days, DST safe", () => {
  assert.equal(dayNumber("2026-10-01"), 0);
  assert.equal(dayNumber("2026-10-31"), 30);
  assert.equal(dayNumber("2026-09-30"), -1);
  for (const [a, b] of [["2026-10-24", "2026-10-25"], ["2026-10-25", "2026-10-26"], ["2027-03-27", "2027-03-28"], ["2027-03-28", "2027-03-29"], ["2026-12-31", "2027-01-01"]]) {
    assert.equal(dayNumber(b) - dayNumber(a), 1, `${a} to ${b}`);
  }
  assert.equal(localDay(new Date(2027, 2, 28, 0, 30)), "2027-03-28");
  assert.equal(localDay(new Date(2026, 9, 25, 23, 59)), "2026-10-25");
  assert.equal(localDay(new Date(2026, 0, 5)), "2026-01-05");
});

test("today uses the injected clock", () => {
  setClock(() => new Date(2026, 9, 12, 8));
  assert.equal(today(), "2026-10-12");
  setClock();
  assert.match(today(), /^\d{4}-\d{2}-\d{2}$/);
});

test("streak: one more after yesterday, a gap restarts at 1", () => {
  assert.equal(streakAfter({ last: null, streak: 0 }, "2026-10-12"), 1);
  assert.equal(streakAfter({ last: "2026-10-11", streak: 3 }, "2026-10-12"), 4);
  assert.equal(streakAfter({ last: "2026-10-10", streak: 3 }, "2026-10-12"), 1);
  assert.equal(streakAfter({ last: "2026-10-24", streak: 2 }, "2026-10-25"), 3); // fall-back day
  assert.equal(streakAfter({ last: "2027-03-27", streak: 2 }, "2027-03-28"), 3); // spring-forward day
  assert.equal(streakAfter({ last: "2026-12-31", streak: 6 }, "2027-01-01"), 7);
});

test("activeStreak: over when neither today nor yesterday was solved", () => {
  const d = { last: "2026-10-11", streak: 4, best: 4 };
  assert.equal(activeStreak(d, "2026-10-11"), 4);
  assert.equal(activeStreak(d, "2026-10-12"), 4);
  assert.equal(activeStreak(d, "2026-10-13"), 0);
  assert.equal(activeStreak({ last: null, streak: 0, best: 0 }, "2026-10-13"), 0);
});

test("achievements table", () => {
  assert.deepEqual(ACHIEVEMENTS.map((a) => a.id), ["first", "unaided", "brisk", "quilt", "week", "hugi", "fine", "own"]);
  assert.equal(ACHIEVEMENTS.find((a) => a.id === "own").name, "A gift");
  for (const a of ACHIEVEMENTS) assert.ok(a.name && a.text);
});

test("earnedAchievements", () => {
  const ev = (puzzle, over = {}) => ({ puzzle, stars: 2, helped: false, ...over });
  const s = freshSave();
  assert.deepEqual(earnedAchievements(s, ev(pz(5, 5, "tabby"))), ["first"]);
  assert.deepEqual(earnedAchievements(s, ev(pz(15, 15, "twill"))), ["first", "unaided"]);
  assert.deepEqual(earnedAchievements(s, ev(pz(15, 15, "twill"), { helped: true })), ["first"]);
  assert.deepEqual(earnedAchievements(s, ev(pz(21, 7, "brocade"))), ["first", "unaided"]);
  s.ach.first = "2026-10-12";
  assert.deepEqual(earnedAchievements(s, ev(pz(5, 5, "tabby"))), []);
  s.stats.parStars = 10;
  s.daily.streak = 7;
  s.stats.threeStars = 25;
  assert.deepEqual(earnedAchievements(s, ev(pz(5, 5, "tabby"))), ["brisk", "week", "fine"]);
  assert.deepEqual(earnedAchievements(s, ev(pz(50, 50, "tapestry"), { stars: 3 })), ["unaided", "brisk", "week", "hugi", "fine"]);
  assert.ok(!earnedAchievements(s, ev(pz(50, 50, "tapestry"), { stars: 2 })).includes("hugi"));
});

test("achievements: Quilter needs the pack, A gift needs a shared puzzle", () => {
  const pack = { puzzles: [pz(5, 5, "tabby", { id: "a" }), pz(5, 5, "tabby", { id: "b" }), pz(6, 6, "twill", { id: "c" })] };
  const s = freshSave();
  s.ach.first = "x";
  const a = { ...pack.puzzles[0] };
  s.solved.a = { stars: 1, best: 1, first: "x" };
  assert.deepEqual(earnedAchievements(s, { puzzle: a, stars: 1, helped: true, pack }), []);
  s.solved.b = { stars: 1, best: 1, first: "x" };
  assert.deepEqual(earnedAchievements(s, { puzzle: a, stars: 1, helped: true, pack }), ["quilt"]);
  assert.deepEqual(earnedAchievements(s, { puzzle: a, stars: 1, helped: true }), []); // no pack: skipped
  const shared = pz(15, 15, "twill", { kind: "shared", id: "s-1" });
  assert.deepEqual(earnedAchievements(s, { puzzle: shared, stars: 3, helped: false, pack }), ["own"]);
});
