// The game exports of the WebAssembly solver (web/src/lib.rs): the shape of their JSON, and a
// hint replay from an empty board. Needs web/hugi_web.wasm: run web/build.sh first.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { instantiate } from "../hugi.js";

const hugi = await instantiate(await WebAssembly.compile(readFileSync(new URL("../hugi_web.wasm", import.meta.url))));
const read = (name) => readFileSync(new URL(`../../puzzles/${name}.txt`, import.meta.url), "utf8");

// A 2x3 board: row 0 is 3, row 1 is 1; the player has filled (0,0) and marked (1,1).
const BOARD = "rows\n3\n1\ncols\n2\n1\n1\nstate\n#??\n?.?";

test("hint: a line move names the line and its forced cells", () => {
  // Rows 0, columns 0 and 1 all force every open cell; column 0 has the fewest open cells.
  assert.deepEqual(hugi.hint(BOARD), { kind: "line", axis: "col", index: 0, open: 1, cells: [[1, 0, 1]] });
});

test("hint: solved, contradiction and none", () => {
  assert.deepEqual(hugi.hint("rows\n1\n1\ncols\n1\n1\nstate\n#.\n.#"), { kind: "solved" });
  assert.deepEqual(hugi.hint("rows\n0\n1\ncols\n1\n0\nstate\n?#\n??"), { kind: "contradiction", axis: "row", index: 0 });
  assert.deepEqual(hugi.hint("rows\n1\n1\ncols\n1\n1\nstate\n??\n??"), { kind: "none" });
});

test("hint: a probe move when no line decides anything", () => {
  const text = read("hugi");
  const { rows, cols } = hugi.clues(text);
  const state = rows.map(() => "?".repeat(cols.length));
  // Follow line moves until the first probe.
  for (let i = 0; i < 1000; i++) {
    const move = hugi.hint(`${text}\nstate\n${state.join("\n")}`);
    if (move.kind === "probe") {
      assert.equal(move.cell.length, 2);
      assert.ok(move.value === 0 || move.value === 1);
      assert.ok(["row", "col"].includes(move.axis));
      assert.ok(move.steps >= 1);
      return;
    }
    assert.equal(move.kind, "line");
    for (const [r, c, v] of move.cells) state[r] = state[r].slice(0, c) + (v ? "#" : ".") + state[r].slice(c + 1);
  }
  assert.fail("no probe move");
});

test("hint: errors are JSON", () => {
  assert.match(hugi.hint("rows\n3\ncols\n1\n1\n1\n").error, /state/);
  assert.match(hugi.hint("rows\n3\ncols\n1\n1\n1\nstate\n##").error, /state must be/);
  assert.match(hugi.hint("rows\n3\ncols\n1\n1\n1\nstate\n#x#").error, /bad state character/);
});

test("lineStatus: open, impossible and done", () => {
  assert.deepEqual(hugi.lineStatus(BOARD), { rows: [0, 0], cols: [0, 0, 0] });
  // Row 0 asks for 3 and has a mark between two filled cells; row 1 and columns 0 and 2 are done.
  assert.deepEqual(hugi.lineStatus("rows\n3\n1\ncols\n2\n1\n1\nstate\n#.#\n#??"), { rows: [1, 2], cols: [2, 0, 2] });
});

test("rate: the rating of the repository puzzles", () => {
  assert.deepEqual(hugi.rate(read("hugi")), { moves: 41, probes: 1, max_steps: 4, sum_steps: 4, search: false, effort: 46, tier: "brocade" });
  const heart = hugi.rate(read("heart"));
  assert.deepEqual([heart.moves, heart.probes, heart.tier], [38, 0, "twill"]);
  const rings = hugi.rate(read("rings"));
  assert.deepEqual([rings.search, rings.tier], [true, null]);
  assert.deepEqual(Object.keys(heart), ["moves", "probes", "max_steps", "sum_steps", "search", "effort", "tier"]);
});

test("rate: bad clues give an error", () => {
  assert.match(hugi.rate("rows\n3\ncols\n1\n").error, /fill/);
});

test("hint replay solves the heart from an empty board", () => {
  const text = read("heart");
  const { rows, cols } = hugi.clues(text);
  const state = rows.map(() => Array(cols.length).fill("?"));
  for (let step = 0; ; step++) {
    assert.ok(step < 500, "the replay does not end");
    const move = hugi.hint(`${text}\nstate\n${state.map((r) => r.join("")).join("\n")}`);
    if (move.kind === "solved") break;
    assert.ok(move.kind === "line" || move.kind === "probe", move.kind);
    const cells = move.kind === "line" ? move.cells : [[...move.cell, move.value]];
    for (const [r, c, v] of cells) state[r][c] = v ? "#" : ".";
  }
  const filled = state.map((r) => r.map((x) => (x === "#" ? 1 : 0)));
  const got = filled.map((r, i) => runsOf(r));
  assert.deepEqual(got, rows);
});

function runsOf(cells) {
  const out = [];
  let k = 0;
  for (const x of [...cells, 0]) {
    if (x) k++;
    else if (k) (out.push(k), (k = 0));
  }
  return out;
}
