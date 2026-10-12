// The hint policy and the engine, against the real solver. Needs web/hugi_web.wasm: run web/build.sh first.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { instantiate } from "../hugi.js";
import { Engine, lineStatus } from "../game/engine.js";
import { wrongCells, badLines, runHint } from "../game/hints.js";

const module = await WebAssembly.compile(readFileSync(new URL("../hugi_web.wasm", import.meta.url)));
const hugi = await instantiate(module);
const read = (name) => readFileSync(new URL(`../../puzzles/${name}.txt`, import.meta.url), "utf8");

// A game puzzle from a file of the repository; its solution is the first one the solver finds.
function load(name, extra = {}) {
  const text = read(name);
  const { rows, cols } = hugi.clues(text);
  const [picture] = hugi.solve(text, 2).solutions;
  const solution = Uint8Array.from(picture.join("").split(""), (ch) => (ch === "#" ? 1 : 0));
  return { id: name, w: cols.length, h: rows.length, rows, cols, solution, ...extra };
}

const local = new Engine(module, { Worker: null });
const empty = (puzzle) => new Uint8Array(puzzle.w * puzzle.h);
const apply = (state, set) => set.forEach(({ i, v }) => (state[i] = v));
const nowhere = { hint: () => assert.fail("the solver must not be asked") };

test("a wrong cell is reported before any move", async () => {
  const heart = load("heart");
  const state = empty(heart);
  const a = heart.solution.indexOf(0);
  const b = heart.solution.indexOf(0, a + 1);
  const c = heart.solution.indexOf(1);
  state[a] = 1; // filled where the picture is empty
  state[b] = 1;
  state[c] = 2; // marked where the picture is filled
  assert.deepEqual(wrongCells(heart, state), [a, b, c]);
  for (const kind of ["nudge", "cell"]) {
    const r = await runHint(kind, { puzzle: heart, state, engine: nowhere, lastWrong: [b, 7, a] });
    assert.equal(r.message, "This cell is wrong.");
    assert.deepEqual(r.set, []);
    assert.deepEqual(r.highlight, { lines: [], cells: [{ i: a, style: "wrong" }] });
  }
  const first = await runHint("nudge", { puzzle: heart, state, engine: nowhere, lastWrong: [] });
  assert.deepEqual(first.highlight.cells, [{ i: a, style: "wrong" }]);
  const newest = await runHint("nudge", { puzzle: heart, state, engine: nowhere, lastWrong: [a, 7, b] });
  assert.deepEqual(newest.highlight.cells, [{ i: b, style: "wrong" }]);
});

test("cell on the heart from empty sets a cell the solution agrees with", async () => {
  const heart = load("heart");
  const r = await runHint("cell", { puzzle: heart, state: empty(heart), engine: local });
  assert.equal(r.set.length, 1);
  const [{ i, v }] = r.set;
  assert.equal(v === 1, heart.solution[i] === 1);
  assert.deepEqual(r.highlight.cells, [{ i, style: "hint" }]);
  assert.match(r.message, /^(Row|Column) \d+ decides this cell: it is (filled|empty)\.$/);
});

test("nudge names a line or a cell and sets nothing", async () => {
  const heart = load("heart");
  const r = await runHint("nudge", { puzzle: heart, state: empty(heart), engine: local });
  assert.deepEqual(r.set, []);
  assert.match(r.message, /^(Row|Column) \d+ has a sure move\.$/);
  assert.equal(r.highlight.lines.length, 1);
});

test("probe moves: both ways message, and the proved value is set", async () => {
  const puzzle = load("hugi");
  const state = empty(puzzle);
  let probe = null;
  for (let k = 0; k < 1000 && !probe; k++) {
    const move = await local.hint(puzzle, state);
    if (move.kind === "probe") probe = move;
    else apply(state, (await runHint("cell", { puzzle, state, engine: local })).set);
  }
  assert.ok(probe, "no probe move on the hugi puzzle");
  const nudge = await runHint("nudge", { puzzle, state, engine: local });
  assert.equal(nudge.message, "Try this cell both ways: one of them breaks a line.");
  assert.equal(nudge.highlight.cells.length, 1);
  const cell = await runHint("cell", { puzzle, state, engine: local });
  const i = probe.cell[0] * puzzle.w + probe.cell[1];
  assert.deepEqual(cell.set, [{ i, v: probe.value ? 1 : 2 }]);
  assert.equal(puzzle.solution[i], probe.value);
  assert.match(cell.message, /^(Filled|Empty), this cell would leave (row|column) \d+ impossible\. So it (is filled|stays empty)\.$/);
});

test("track and mistakes match wrongCells", async () => {
  const heart = load("heart");
  const state = empty(heart);
  const ok = await runHint("track", { puzzle: heart, state, engine: nowhere });
  assert.equal(ok.message, "Yes, nothing you placed is wrong.");
  assert.deepEqual((await runHint("mistakes", { puzzle: heart, state, engine: nowhere })).message, "No cell is wrong.");
  state[heart.solution.indexOf(0)] = 1;
  assert.equal((await runHint("track", { puzzle: heart, state, engine: nowhere })).message, "No: something you placed is wrong.");
  const one = await runHint("mistakes", { puzzle: heart, state, engine: nowhere });
  assert.equal(one.message, "1 cell is wrong.");
  state[heart.solution.indexOf(1)] = 2;
  const two = await runHint("mistakes", { puzzle: heart, state, engine: nowhere });
  assert.equal(two.message, "2 cells are wrong.");
  assert.deepEqual(two.highlight.cells, wrongCells(heart, state).map((i) => ({ i, style: "wrong" })));
  assert.deepEqual(two.set, []);
});

test("reveal a line sets every cell of it from the solution", async () => {
  const heart = load("heart");
  const row = await runHint("line", { puzzle: heart, state: empty(heart), engine: nowhere, pick: { axis: "row", index: 4 } });
  assert.equal(row.set.length, heart.w);
  assert.ok(row.set.every(({ i, v }) => Math.floor(i / heart.w) === 4 && v === (heart.solution[i] ? 1 : 2)));
  assert.equal(row.message, "Row 5 is set.");
  assert.deepEqual(row.highlight.lines, [{ axis: "row", index: 4 }]);
  const col = await runHint("line", { puzzle: heart, state: empty(heart), engine: nowhere, pick: { axis: "col", index: 0 } });
  assert.deepEqual(col.set.map(({ i }) => i), Array.from({ length: heart.h }, (_, y) => y * heart.w));
  assert.match((await runHint("line", { puzzle: heart, state: empty(heart), engine: nowhere })).message, /Pick/);
});

test("solved boards and boards that cannot be completed", async () => {
  const smile = load("smile");
  const state = Uint8Array.from(smile.solution, (v) => (v ? 1 : 2));
  assert.deepEqual(wrongCells(smile, state), []);
  const done = await runHint("nudge", { puzzle: smile, state, engine: local });
  assert.deepEqual(done.set, []);
  assert.match(done.message, /solved/);
  const multi = load("smile", { multi: true });
  const broken = empty(multi);
  broken[0] = 1; // the first row of the smile starts with empty cells
  const r = await runHint("nudge", { puzzle: multi, state: broken, engine: local });
  assert.match(r.message, /cannot be completed|sure move/);
});

for (const name of ["heart", "house", "smile"]) {
  test(`the hint-only replay solves ${name}`, async () => {
    const puzzle = load(name);
    const state = empty(puzzle);
    for (let step = 0; ; step++) {
      assert.ok(step < puzzle.w * puzzle.h * 2, "the replay does not end");
      const r = await runHint("cell", { puzzle, state, engine: local });
      if (!r.set.length) {
        assert.match(r.message, /solved/);
        break;
      }
      assert.equal(r.set.length, 1);
      assert.equal(r.set[0].v === 1, puzzle.solution[r.set[0].i] === 1, `step ${step} sets a wrong cell`);
      apply(state, r.set);
      assert.deepEqual(wrongCells(puzzle, state), []);
    }
    assert.deepEqual(wrongCells(puzzle, state), []);
    assert.ok(state.every((v, i) => (v === 1) === (puzzle.solution[i] === 1)));
    const status = lineStatus(hugi, puzzle, state);
    assert.ok([...status.rows, ...status.cols].every((s) => s === 2));
  });
}

test("several solutions: no wrong cells, no reveal, hints stay true", async () => {
  const rings = load("rings", { multi: true });
  const state = empty(rings);
  assert.deepEqual(wrongCells(rings, state), []);
  assert.deepEqual(badLines(rings, state), []);
  state[rings.solution.indexOf(0)] = 1; // would be wrong against the stored picture, but any solution counts
  assert.deepEqual(wrongCells(rings, state), []);
  assert.match((await runHint("line", { puzzle: rings, state, engine: nowhere, pick: { axis: "row", index: 0 } })).message, /not available/);

  const [a, b] = hugi.solve(read("rings"), 2).solutions;
  const board = empty(rings);
  for (let step = 0; ; step++) {
    assert.ok(step < 2000, "the replay does not end");
    const r = await runHint("cell", { puzzle: rings, state: board, engine: local });
    if (!r.set.length) {
      assert.match(r.message, /needs a guess|solved/);
      break;
    }
    // A line or probe move holds in every solution.
    for (const { i, v } of r.set) for (const pic of [a, b]) assert.equal(v === 1, pic[Math.floor(i / rings.w)][i % rings.w] === "#");
    apply(board, r.set);
  }

  const wrong = empty(rings);
  wrong.fill(2);
  wrong[0] = 1;
  const lines = badLines(rings, wrong);
  assert.ok(lines.length > 0);
  const track = await runHint("track", { puzzle: rings, state: wrong, engine: nowhere });
  assert.match(track.message, /^No: a finished/);
  const mistakes = await runHint("mistakes", { puzzle: rings, state: wrong, engine: nowhere });
  assert.deepEqual(mistakes.highlight.lines, lines);
  assert.deepEqual(mistakes.highlight.cells, []);
});

// A stand-in for Worker: answers with the real solver, or never, and counts its own life.
function fakeWorkers(behaviour) {
  const made = [];
  class FakeWorker {
    constructor(url, options) {
      this.url = url;
      this.options = options;
      this.messages = [];
      this.ended = false;
      this.onmessage = null;
      made.push(this);
    }
    postMessage(data) {
      this.messages.push(data);
      if (data.op === "init") return;
      const answer = behaviour(this, data);
      if (answer) queueMicrotask(() => this.onmessage?.({ data: { id: data.id, ...answer } }));
    }
    terminate() {
      this.ended = true;
    }
  }
  return { FakeWorker, made };
}

const real = (_, { op, text, engine }) => ({ result: op === "solve" ? hugi.solve(text, engine) : op === "hint" ? hugi.hint(text) : hugi.rate(text) });

test("Engine on a worker: one module worker, init once, answers by id", async () => {
  const { FakeWorker, made } = fakeWorkers(real);
  const engine = new Engine(module, { Worker: FakeWorker });
  const heart = load("heart");
  const [move, rating, unique] = await Promise.all([engine.hint(heart, empty(heart)), engine.rate(heart), engine.unique(heart)]);
  assert.equal(move.kind, "line");
  assert.equal(rating.tier, "twill");
  assert.equal(unique, true);
  assert.equal(made.length, 1);
  assert.equal(made[0].url, "game/worker.js?v=dev");
  assert.deepEqual(made[0].options, { type: "module" });
  assert.deepEqual(made[0].messages.map((m) => m.op), ["init", "hint", "rate", "solve"]);
  assert.equal(made[0].messages[0].module, module);
  assert.equal(made[0].messages[3].engine, 2);
  assert.equal(await engine.unique(load("rings", { multi: true })), false);
});

test("Engine: a timeout ends the worker, starts a new one and still answers", async () => {
  let silent = true;
  const { FakeWorker, made } = fakeWorkers((w, data) => (silent ? null : real(w, data)));
  const engine = new Engine(module, { Worker: FakeWorker, timeout: 20 });
  const heart = load("heart");
  assert.deepEqual(await engine.rate(heart), { timeout: true });
  assert.equal(made.length, 2);
  assert.equal(made[0].ended, true);
  assert.equal(made[1].ended, false);
  assert.equal(made[1].messages[0].op, "init");
  assert.equal(await engine.unique(heart), null);
  assert.equal(made.length, 3);
  await assert.rejects(engine.hint(heart, empty(heart)), /too long/);
  silent = false;
  assert.equal((await engine.rate(heart)).tier, "twill");
  assert.equal(made.length, 4);
});

test("Engine: an error answer rejects, a late answer is ignored, a worker error replaces the worker", async () => {
  let mode = "error";
  const { FakeWorker, made } = fakeWorkers((w, data) => (mode === "error" ? { error: "boom" } : mode === "late" ? null : real(w, data)));
  const engine = new Engine(module, { Worker: FakeWorker, timeout: 20 });
  const heart = load("heart");
  await assert.rejects(engine.rate(heart), /boom/);
  mode = "late";
  const first = engine.rate(heart);
  const stale = made[0].messages.at(-1).id;
  assert.deepEqual(await first, { timeout: true });
  made[0].onmessage({ data: { id: stale, result: { tier: "late" } } }); // no job: ignored
  mode = "real";
  const pending = engine.hint(heart, empty(heart));
  made.at(-1).onerror();
  await assert.rejects(pending, /failed/);
  assert.equal(made.at(-1).ended, false);
  assert.equal((await engine.rate(heart)).tier, "twill");
});

test("Engine without Worker runs on the main thread", async () => {
  const heart = load("heart");
  assert.equal((await local.rate(heart)).tier, "twill");
  assert.equal((await local.hint(heart, empty(heart))).kind, "line");
  assert.equal(await local.unique(heart), true);
  assert.equal(await local.unique(load("rings")), false);
  const broken = new Engine(module, { Worker: class { constructor() { throw new Error("no workers here"); } } });
  assert.equal((await broken.rate(heart)).tier, "twill");
  await assert.rejects(local.hint({ ...heart, rows: [[3]] }, empty(heart)));
});

test("lineStatus reads the board on the given instance", () => {
  const heart = load("heart");
  const state = empty(heart);
  assert.ok([...lineStatus(hugi, heart, state).rows].every((s) => s === 0 || s === 2));
  state.fill(1);
  assert.ok(lineStatus(hugi, heart, state).rows.includes(1));
});
