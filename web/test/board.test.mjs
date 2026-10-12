// The board's pure parts (the stroke rule of docs/game-design.md §1, the layout) and the undo history of
// the Board class, which runs here against a stub canvas.
import test from "node:test";
import assert from "node:assert/strict";
import { strokePath, applyStroke, boardLayout, Board } from "../game/board.js";

const W = 5;
const at = (r, c) => r * W + c;
// Apply a list of changes to a copy of the state.
const after = (state, changes) => {
  const s = state.slice();
  for (const { i, to } of changes) s[i] = to;
  return Array.from(s);
};

test("strokePath: one cell, a row, a column, both directions", () => {
  assert.deepEqual(strokePath(7, 7, W), [7]);
  assert.deepEqual(strokePath(at(1, 1), at(1, 4), W), [6, 7, 8, 9]);
  assert.deepEqual(strokePath(at(1, 4), at(1, 1), W), [9, 8, 7, 6]);
  assert.deepEqual(strokePath(at(0, 2), at(3, 2), W), [2, 7, 12, 17]);
  assert.deepEqual(strokePath(at(3, 2), at(0, 2), W), [17, 12, 7, 2]);
});

test("strokePath: the axis locks to the row or column of the first cell", () => {
  // Pointer far off the row: the row is kept (a locked axis), the column of the end is ignored.
  assert.deepEqual(strokePath(at(2, 1), at(4, 3), W, "row"), [11, 12, 13]);
  assert.deepEqual(strokePath(at(2, 1), at(4, 3), W, "col"), [11, 16, 21]);
  // Unlocked: the longer distance decides, a tie goes to the row.
  assert.deepEqual(strokePath(at(0, 0), at(1, 3), W), [0, 1, 2, 3]);
  assert.deepEqual(strokePath(at(0, 0), at(3, 1), W), [0, 5, 10, 15]);
  assert.deepEqual(strokePath(at(0, 0), at(2, 2), W), [0, 1, 2]);
});

test("strokePath: a fast drag skips no cell", () => {
  const path = strokePath(at(0, 0), at(0, 29), 30);
  assert.equal(path.length, 30);
  assert.deepEqual(path, Array.from({ length: 30 }, (_, i) => i));
  const down = strokePath(0, 29 * 30, 30, "col");
  assert.equal(down.length, 30);
  assert.ok(down.every((v, k) => v === k * 30));
});

test("applyStroke: start on an empty cell fills empty cells and never overwrites a mark", () => {
  const s = Uint8Array.from([0, 0, 2, 0, 1]);
  const ch = applyStroke(s, [0, 1, 2, 3, 4], 1);
  assert.deepEqual(after(s, ch), [1, 1, 2, 1, 1]);
  assert.deepEqual(ch.map((c) => c.i), [0, 1, 3]);
  assert.ok(ch.every((c) => c.from === 0 && c.to === 1));
});

test("applyStroke: start on a filled cell clears filled cells only", () => {
  const s = Uint8Array.from([1, 1, 2, 0, 1]);
  const ch = applyStroke(s, [0, 1, 2, 3, 4], 1);
  assert.deepEqual(after(s, ch), [0, 0, 2, 0, 0]);
  assert.ok(ch.every((c) => c.from === 1 && c.to === 0));
});

test("applyStroke: a mark in the path is left alone when the start is empty", () => {
  const s = Uint8Array.from([0, 2, 0, 2, 0]);
  assert.deepEqual(after(s, applyStroke(s, [0, 1, 2, 3, 4], 1)), [1, 2, 1, 2, 1]);
});

test("applyStroke: the Mark tool", () => {
  const s = Uint8Array.from([0, 1, 0, 2, 0]);
  // Start empty: marks the empty cells, leaves the filled one.
  assert.deepEqual(after(s, applyStroke(s, [0, 1, 2, 3, 4], "mark")), [2, 1, 2, 2, 2]);
  // Start on a mark: clears the marks, leaves everything else.
  assert.deepEqual(after(s, applyStroke(s, [3, 2, 1, 0], 2)), [0, 1, 0, 0, 0]);
  // Start on a filled cell with the Mark tool: v0 != t, so filled cells become marks.
  const f = Uint8Array.from([1, 0, 1]);
  assert.deepEqual(after(f, applyStroke(f, [0, 1, 2], 2)), [2, 0, 2]);
});

test("applyStroke: the start cell decides, the path order matters, an empty path does nothing", () => {
  const s = Uint8Array.from([1, 0, 0]);
  assert.deepEqual(after(s, applyStroke(s, [0, 1, 2], 1)), [0, 0, 0]);
  assert.deepEqual(after(s, applyStroke(s, [2, 1, 0], 1)), [1, 1, 1]);
  assert.deepEqual(applyStroke(s, [], 1), []);
  assert.deepEqual(Array.from(s), [1, 0, 0], "the state is not mutated");
});

test("applyStroke: axis lock in a full drag, start empty, mark and filled cells on the row", () => {
  // 5x3 board, row 1 is [1 0 2 0 1]. A drag from (1,1) to (2,4) is locked to row 1 (axis "row").
  const s = new Uint8Array(15);
  s.set([1, 0, 2, 0, 1], 5);
  const path = strokePath(at(1, 1), at(2, 4), W, "row");
  assert.deepEqual(path, [6, 7, 8, 9]);
  assert.deepEqual(after(s, applyStroke(s, path, 1)).slice(5, 10), [1, 1, 2, 1, 1]);
});

test("boardLayout: the cell fits the frame, 56 at most, never below the minimum", () => {
  const rows = [[1], [2, 2]];
  const cols = [[1], [3]];
  const wide = boardLayout(rows, cols, 2, 2, 2000, 12);
  assert.equal(wide.cell, 56);
  const g15 = boardLayout(Array(15).fill([3, 3]), Array(15).fill([3, 3]), 15, 15, 400, 12);
  assert.ok(g15.width <= 400, `width ${g15.width}`);
  assert.ok(g15.cell >= 12);
  const big = boardLayout(Array(40).fill([2, 2, 2]), Array(40).fill([2, 2, 2]), 40, 40, 360, 14);
  assert.equal(big.cell, 14, "below the minimum the frame scrolls");
  assert.ok(big.width > 360);
  assert.ok(boardLayout([[]], [[]], 1, 1, 100, 12).left > 0, "an empty clue still has room for its 0");
});

// ── The Board class, on stubs ────────────────────────────────────────────────

function makeBoard() {
  globalThis.document ??= { documentElement: {}, addEventListener() {}, removeEventListener() {} };
  globalThis.getComputedStyle ??= () => ({ getPropertyValue: () => "#123456", paddingLeft: "0", paddingRight: "0" });
  const ctx = new Proxy({}, { get: (_, k) => (k === "measureText" ? () => ({ width: 5 }) : () => {}), set: () => true });
  const attrs = new Map();
  const canvas = {
    style: {},
    getContext: () => ctx,
    addEventListener() {},
    removeEventListener() {},
    setAttribute: (k, v) => attrs.set(k, v),
    getAttribute: (k) => attrs.get(k) ?? null,
    hasAttribute: (k) => attrs.has(k),
    getBoundingClientRect: () => ({ left: 0, top: 0 }),
  };
  const wrap = { clientWidth: 600, scrollLeft: 0, scrollTop: 0 };
  const board = new Board(canvas, wrap);
  const w = 6;
  const h = 4;
  board.load({ id: "t", name: "t", w, h, rows: Array(h).fill([1]), cols: Array(w).fill([1]), solution: new Uint8Array(w * h), thread: 1 });
  return { board, canvas, w };
}

test("Board: setCells is one undo step, undo and redo restore, events carry the changed cells", () => {
  const { board } = makeBoard();
  const seen = [];
  board.addEventListener("stroke", (e) => seen.push(e.detail.changed));
  board.setCells([{ i: 1, v: 1 }, { i: 2, v: 2 }, { i: 3, v: 0 }]); // 3 is already 0: skipped
  assert.deepEqual(Array.from(board.state.slice(0, 4)), [0, 1, 2, 0]);
  assert.deepEqual(seen, [[1, 2]]);
  assert.ok(board.canUndo && !board.canRedo);
  board.undo();
  assert.deepEqual(Array.from(board.state.slice(0, 4)), [0, 0, 0, 0]);
  assert.ok(!board.canUndo && board.canRedo);
  board.redo();
  assert.deepEqual(Array.from(board.state.slice(0, 4)), [0, 1, 2, 0]);
  assert.deepEqual(seen, [[1, 2], [1, 2], [1, 2]]);
  board.setCells([{ i: 1, v: 1 }]);
  assert.equal(seen.length, 3, "a no-op is not a step");
});

test("Board: a new step clears redo; the history keeps 500 steps", () => {
  const { board } = makeBoard();
  board.setCells([{ i: 0, v: 1 }]);
  board.undo();
  board.setCells([{ i: 1, v: 1 }]);
  assert.ok(!board.canRedo);
  board.load(board.puzzle);
  for (let k = 0; k < 520; k++) board.setCells([{ i: k % 24, v: Math.floor(k / 24) % 2 === 0 ? 1 : 0 }]);
  let n = 0;
  while (board.canUndo) {
    board.undo();
    n++;
  }
  assert.equal(n, 500);
});

test("Board: load keeps a saved state and the tool controls touch-action", () => {
  const { board, canvas } = makeBoard();
  assert.equal(canvas.style.touchAction, "none");
  board.tool = "move";
  assert.equal(canvas.style.touchAction, "pan-x pan-y");
  board.tool = "mark";
  assert.equal(canvas.style.touchAction, "none");
  board.tool = "nonsense";
  assert.equal(board.tool, "mark");
  const saved = new Uint8Array(24);
  saved[5] = 2;
  board.load(board.puzzle, saved);
  assert.equal(board.state[5], 2);
  assert.ok(!board.canUndo);
});

test("Board: keyboard cursor, Space fills, a Shift + arrow drag is one undo step", () => {
  const { board, canvas } = makeBoard();
  const key = (k, extra = {}) => board._keyDown({ key: k, preventDefault() {}, ...extra });
  const cursors = [];
  board.addEventListener("cursor", (e) => cursors.push([e.detail.r, e.detail.c]));
  key("ArrowRight");
  key("ArrowDown");
  assert.deepEqual(cursors, [[0, 1], [1, 1]]);
  key(" "); // fills (1,1) = index 7
  key("ArrowRight", { shiftKey: true });
  key("ArrowRight", { shiftKey: true });
  assert.deepEqual(Array.from(board.state.slice(6, 12)), [0, 1, 1, 1, 0, 0]);
  board.undo();
  assert.ok(board.state.every((v) => v === 0), "the keyboard drag undoes in one step");
  key("x");
  assert.equal(board.state[9], 2);
  key("z");
  assert.equal(board.state[9], 0);
  key("z", { ctrlKey: true, shiftKey: true }); // redo
  assert.equal(board.state[9], 2);
  key("2");
  assert.equal(board.tool, "mark");
  assert.equal(canvas.style.touchAction, "none");
  key("ArrowUp");
  key("ArrowUp");
  assert.deepEqual(cursors.at(-1), [0, 3], "the cursor stops at the edge");
});

test("Board: Enter fills at the cursor like Space and toggles back", () => {
  const { board } = makeBoard();
  const key = (k) => board._keyDown({ key: k, preventDefault() {} });
  key("ArrowRight");
  key("Enter");
  assert.equal(board.state[1], 1);
  key("Enter");
  assert.equal(board.state[1], 0);
  key(" ");
  assert.equal(board.state[1], 1);
});
