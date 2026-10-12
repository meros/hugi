// The pack (web/pack.json): shape, uniqueness, stored ratings, and the hint replay.
// Needs web/hugi_web.wasm from web/build.sh with the `hint` and `rate` exports (WP1).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { instantiate } from "../hugi.js";
import { cluesOf, cluesText, stateText, unpackBits } from "../grid.js";

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const pack = JSON.parse(readFileSync(here("../pack.json"), "utf8"));
const hugi = await instantiate(await WebAssembly.compile(readFileSync(here("../hugi_web.wasm"))));

const TIER_IDS = ["tabby", "twill", "satin", "brocade", "tapestry"];
const MAX_SIDE = { tabby: 10, twill: 15, satin: 20, brocade: 30, tapestry: 50 };
const all = [...pack.puzzles, ...pack.daily];

const solutionOf = (p) => unpackBits(p.w, p.h, p.bits);
const textOf = (p) => cluesText(cluesOf(p.w, p.h, solutionOf(p)));

test("shape: 150 campaign puzzles, 30 per tier in order, 60 daily", () => {
  assert.equal(pack.version, 1);
  assert.match(pack.credits, /Material Icons by Google \(Apache License 2\.0\)/);
  assert.deepEqual(pack.tiers.map((t) => t.id), TIER_IDS);
  assert.deepEqual(pack.tiers.map((t) => t.opens), [0, 20, 20, 20, 20]);
  assert.equal(pack.puzzles.length, 150);
  assert.equal(pack.daily.length, 60);
  TIER_IDS.forEach((id, k) => {
    const slice = pack.puzzles.slice(k * 30, k * 30 + 30);
    assert.ok(slice.every((p) => p.tier === id), `tier ${id} is not 30 in a row`);
  });
});

test("every puzzle decodes, sizes match, ids and names are unique", () => {
  const ids = new Set();
  for (const p of all) {
    assert.ok(!ids.has(p.id), `duplicate id ${p.id}`);
    ids.add(p.id);
    assert.match(p.id, /^(d-)?[a-z0-9]+(-[a-z0-9]+)*-\d+$/);
    assert.ok(p.id.endsWith("-" + Math.max(p.w, p.h)), `${p.id}: id size`);
    assert.ok(p.thread >= 1 && p.thread <= 5, `${p.id}: thread`);
    assert.ok(Math.max(p.w, p.h) <= MAX_SIDE[p.tier], `${p.id}: too big for ${p.tier}`);
    const cells = solutionOf(p);
    const filled = cells.reduce((a, b) => a + b, 0);
    assert.ok(filled > 0 && filled < p.w * p.h, `${p.id}: empty or full`);
    // no stray bits past the last cell
    const bin = Buffer.from(p.bits.replace(/-/g, "+").replace(/_/g, "/"), "base64");
    assert.equal(bin.length, Math.ceil((p.w * p.h) / 8), `${p.id}: bits length`);
    const tail = (p.w * p.h) % 8;
    if (tail) assert.equal(bin[bin.length - 1] >> tail, 0, `${p.id}: padding bits set`);
  }
  // no picture twice: names are the icons here (a name belongs to one icon)
  const names = all.map((p) => p.name);
  assert.equal(new Set(names).size, names.length, "a picture appears twice");
});

test("the first three 5x5 puzzles carry a coach note", () => {
  const noted = pack.puzzles.filter((p) => p.note);
  assert.equal(noted.length, 3);
  assert.ok(noted.every((p) => p.w === 5 && p.tier === "tabby"));
});

test("every puzzle has one solution (engine 0)", () => {
  for (const p of all) {
    const r = hugi.solve(textOf(p), 0);
    assert.equal(r.unique, true, `${p.id}: unique is ${r.unique}`);
  }
});

test("every rate gives the stored tier and rating", () => {
  for (const p of all) {
    const r = hugi.rate(textOf(p));
    assert.equal(r.error, undefined, `${p.id}: ${r.error}`);
    assert.equal(r.search, false, `${p.id}: needs a guess`);
    assert.equal(r.tier, p.tier, `${p.id}: tier`);
    for (const k of ["moves", "probes", "max_steps", "sum_steps", "effort"]) {
      assert.equal(r[k], p.rating[k], `${p.id}: rating.${k}`);
    }
  }
});

test("hint replay: the hints alone solve every puzzle", () => {
  for (const p of all) {
    const sol = solutionOf(p);
    const clues = textOf(p);
    const state = new Uint8Array(p.w * p.h); // 0 unknown, 1 filled, 2 marked
    const set = (r, c, v) => {
      const want = v ? 1 : 2;
      const i = r * p.w + c;
      assert.ok(state[i] === 0 || state[i] === want, `${p.id}: hint contradicts itself at ${r},${c}`);
      assert.equal(sol[i], v, `${p.id}: hint says ${v} at ${r},${c}, the solution says ${sol[i]}`);
      state[i] = want;
    };
    let steps = 0;
    for (;;) {
      const m = hugi.hint(clues + stateText(p.w, p.h, state));
      if (m.kind === "solved") break;
      assert.ok(m.kind === "line" || m.kind === "probe", `${p.id}: hint gave ${JSON.stringify(m)}`);
      if (m.kind === "line") for (const [r, c, v] of m.cells) set(r, c, v);
      else set(m.cell[0], m.cell[1], m.value);
      assert.ok(++steps <= p.w * p.h, `${p.id}: replay does not finish`);
    }
    for (let i = 0; i < state.length; i++) assert.equal(state[i] === 1 ? 1 : 0, sol[i], `${p.id}: cell ${i}`);
  }
});

test("the daily rotation: 37 is coprime with 60, so 60 days cover the pool", () => {
  const seen = new Set();
  for (let d = 0; d < 60; d++) seen.add((d * 37) % 60);
  assert.equal(seen.size, 60);
});

test("dailyFor picks daily[(dayNumber * 37) % 60] (WP4, skipped until web/game/pack.js exists)", async (t) => {
  if (!existsSync(here("../game/pack.js"))) return t.skip("web/game/pack.js not written yet");
  const { dailyFor } = await import("../game/pack.js");
  const p = { ...pack, daily: pack.daily };
  const start = new Date(2026, 9, 1);
  for (let d = 0; d < 60; d++) {
    const date = new Date(2026, 9, 1 + d);
    const got = dailyFor(p, date);
    assert.equal(got.puzzle.id, pack.daily[(d * 37) % 60].id, `day ${d}`);
  }
  assert.equal(dailyFor(p, start).puzzle.id, pack.daily[0].id);
});
