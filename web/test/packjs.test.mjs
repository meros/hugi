import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildPack, dailyFor, tierState, nextPuzzle, dailyOpen, sharedPuzzle, loadPack } from "../game/pack.js";
import { freshSave } from "../game/save.js";

const json = JSON.parse(readFileSync(new URL("./fixtures/pack-small.json", import.meta.url), "utf8"));
const pack = buildPack(json);
const solve = (save, ...ids) => ids.forEach((id) => (save.solved[id] = { stars: 1, best: 10, first: "2026-10-12" }));

test("buildPack decodes solutions, clues, kinds and byId", () => {
  assert.equal(pack.puzzles.length, 6);
  assert.equal(pack.daily.length, 3);
  const cup = pack.byId.get("cup-5");
  assert.equal(cup.kind, "pack");
  assert.equal(cup.solution.length, 25);
  assert.deepEqual(cup.rows, [[5], [1, 1], [1, 1], [3], []]);
  assert.deepEqual(cup.cols, [[3], [1, 1], [1, 1], [1, 1], [3]]);
  assert.equal(pack.byId.get("d-a-5").kind, "daily");
  assert.equal(pack.byId.size, 9);
  assert.equal(cup.note, "Each number is a run of filled cells, in order.");
});

test("dailyFor: fixed dates", () => {
  const ids = (d) => dailyFor(pack, d).puzzle.id;
  assert.equal(dailyFor(pack, new Date(2026, 9, 1, 12)).day, "2026-10-01");
  assert.equal(ids("2026-10-01"), "d-a-5"); // day 0 -> 0
  assert.equal(ids("2026-10-02"), "d-b-5"); // 37 % 3 = 1
  assert.equal(ids("2026-10-03"), "d-c-5");
  assert.equal(ids("2026-10-04"), "d-a-5");
  assert.equal(ids("2026-09-30"), "d-c-5"); // day -1 -> -37 mod 3 = 2
  assert.equal(dailyFor(pack, new Date(2026, 9, 2, 0, 5)).puzzle.id, "d-b-5");
  assert.equal(dailyFor(pack, new Date(2026, 9, 2, 23, 55)).puzzle.id, "d-b-5");
});

test("dailyFor: the 37-step permutation covers a pool of 60 and repeats after 60 days", () => {
  const big = { daily: Array.from({ length: 60 }, (_, i) => ({ id: `d${i}` })) };
  const seen = new Set();
  for (let k = 0; k < 60; k++) seen.add(dailyFor(big, new Date(2026, 9, 1 + k, 12)).puzzle.id);
  assert.equal(seen.size, 60);
  assert.equal(dailyFor(big, "2026-10-01").puzzle.id, dailyFor(big, "2026-11-30").puzzle.id);
  assert.notEqual(dailyFor(big, "2026-10-01").puzzle.id, dailyFor(big, "2026-10-02").puzzle.id);
  assert.equal(dailyFor(big, "2026-10-02").puzzle.id, "d37");
});

test("dailyFor: every day across both DST changes gives a new pool entry in step", () => {
  const big = { daily: Array.from({ length: 60 }, (_, i) => ({ id: `d${i}` })) };
  const idx = (d) => Number(dailyFor(big, d).puzzle.id.slice(1));
  for (const start of [new Date(2026, 9, 23, 12), new Date(2027, 2, 26, 12)]) {
    let prev = idx(start);
    for (let k = 1; k <= 5; k++) {
      const next = idx(new Date(start.getFullYear(), start.getMonth(), start.getDate() + k, 0, 30));
      assert.equal(next, (prev + 37) % 60);
      prev = next;
    }
  }
});

test("dailyFor with an empty pool", () => {
  assert.equal(dailyFor({ daily: [] }, "2026-10-01").puzzle, null);
});

test("tierState and unlock", () => {
  const s = freshSave();
  assert.deepEqual(tierState(pack, s, "tabby"), { open: true, solved: 0, total: 3, need: 0, have: 0 });
  assert.deepEqual(tierState(pack, s, "twill"), { open: false, solved: 0, total: 3, need: 2, have: 0 });
  solve(s, "cup-5");
  assert.equal(tierState(pack, s, "twill").open, false);
  assert.equal(tierState(pack, s, "twill").have, 1);
  solve(s, "heart-5");
  assert.deepEqual(tierState(pack, s, "twill"), { open: true, solved: 0, total: 3, need: 2, have: 2 });
  solve(s, "boat-6", "d-a-5");
  assert.equal(tierState(pack, s, "twill").solved, 1); // a daily does not count
  assert.equal(tierState(pack, s, "tabby").solved, 2);
  assert.throws(() => tierState(pack, s, "nope"));
});

test("dailyOpen after 5 campaign puzzles", () => {
  const s = freshSave();
  solve(s, "cup-5", "heart-5", "tree-5", "boat-6", "d-a-5");
  assert.equal(dailyOpen(pack, s), false);
  solve(s, "moon-6");
  assert.equal(dailyOpen(pack, s), true);
});

test("nextPuzzle: next unsolved in an open tier", () => {
  const s = freshSave();
  assert.equal(nextPuzzle(pack, s, "cup-5").id, "heart-5");
  assert.equal(nextPuzzle(pack, s, null).id, "cup-5");
  solve(s, "heart-5");
  assert.equal(nextPuzzle(pack, s, "cup-5").id, "tree-5");
  solve(s, "cup-5", "tree-5");
  assert.equal(nextPuzzle(pack, s, "tree-5").id, "boat-6"); // twill opened
});

test("nextPuzzle: skips locked tiers, wraps round, null when none", () => {
  const s = freshSave();
  solve(s, "heart-5");
  assert.equal(nextPuzzle(pack, s, "heart-5").id, "tree-5");
  assert.equal(nextPuzzle(pack, s, "tree-5").id, "cup-5"); // wrapped; twill is locked
  solve(s, "cup-5", "tree-5", "boat-6", "moon-6", "key-6");
  assert.equal(nextPuzzle(pack, s, "key-6"), null);
});

test("sharedPuzzle is a stub until WP9", () => {
  assert.equal(sharedPuzzle("#solve:5x5:AAAA", { unique: true }), null);
});

test("loadPack fetches pack.json and builds the pack", async () => {
  const real = globalThis.fetch;
  let url;
  globalThis.fetch = async (u) => ((url = u), { ok: true, status: 200, json: async () => json });
  try {
    const p = await loadPack();
    assert.equal(url, "pack.json?v=dev");
    assert.equal(p.puzzles.length, 6);
    globalThis.fetch = async () => ({ ok: false, status: 404 });
    await assert.rejects(loadPack(), /404/);
  } finally {
    globalThis.fetch = real;
  }
});
