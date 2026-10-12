// The hint policy: which cell is wrong, what each hint and check says and sets. Pure apart from the
// engine it is given. It never touches skeins: the caller spends first (docs/game-design.md §2b, §2c).
// A puzzle with `multi` set has several solutions (§5b): no cell is wrong, so the checks that compare
// with one picture are replaced by a look at the lines the player has finished.

import { runs } from "../grid.js?v=dev";

const FILLED = 1;
const MARKED = 2;

const word = (axis) => (axis === "row" ? "Row" : "Column");
const same = (a, b) => a.length === b.length && a.every((x, k) => x === b[k]);
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** The cells that disagree with the solution: filled where it is empty, marked where it is filled. */
export function wrongCells(puzzle, state) {
  if (puzzle.multi) return [];
  const out = [];
  for (let i = 0; i < state.length; i++) {
    if ((state[i] === FILLED && !puzzle.solution[i]) || (state[i] === MARKED && puzzle.solution[i])) out.push(i);
  }
  return out;
}

/** The lines without an unknown cell whose filled runs differ from their clue: [{axis, index}]. */
export function badLines(puzzle, state) {
  const { w, h } = puzzle;
  const out = [];
  for (let y = 0; y < h; y++) {
    const line = Array.from({ length: w }, (_, x) => state[y * w + x]);
    if (!line.includes(0) && !same(runs(line.map((v) => v === FILLED)), puzzle.rows[y])) out.push({ axis: "row", index: y });
  }
  for (let x = 0; x < w; x++) {
    const line = Array.from({ length: h }, (_, y) => state[y * w + x]);
    if (!line.includes(0) && !same(runs(line.map((v) => v === FILLED)), puzzle.cols[x])) out.push({ axis: "col", index: x });
  }
  return out;
}

// The wrong cell to point at: the newest of lastWrong (cell indices, newest last) that is still wrong, else the first.
function pickWrong(wrong, lastWrong) {
  const last = [lastWrong ?? []].flat();
  for (let k = last.length - 1; k >= 0; k--) if (wrong.includes(last[k])) return last[k];
  return wrong[0];
}

const result = (message, set = [], lines = [], cells = []) => ({ set, highlight: { lines, cells }, message });

// The first forced cell of a line move as {i, v}: a filled one if there is any, else an empty one (v 1 filled, 2 marked).
function firstCell(puzzle, move) {
  const cells = move.cells.map(([r, c, v]) => ({ i: r * puzzle.w + c, v: v ? FILLED : MARKED }));
  return cells.find((cell) => cell.v === FILLED) ?? cells[0];
}

// Every cell of one line, set from the solution.
function revealLine(puzzle, { axis, index }) {
  const { w, h, solution } = puzzle;
  const set = [];
  if (axis === "row") for (let x = 0; x < w; x++) set.push({ i: index * w + x, v: solution[index * w + x] ? FILLED : MARKED });
  else for (let y = 0; y < h; y++) set.push({ i: y * w + index, v: solution[y * w + index] ? FILLED : MARKED });
  return set;
}

function checkResult(kind, puzzle, state) {
  if (puzzle.multi) {
    const bad = badLines(puzzle, state);
    if (kind === "track") return result(bad.length ? "No: a finished row or column does not match its clue." : "Yes, every finished row and column matches its clue.");
    return result(bad.length ? `${plural(bad.length, "finished line does", "finished lines do")} not match its clue.` : "Every finished row and column matches its clue.", [], bad);
  }
  const wrong = wrongCells(puzzle, state);
  if (kind === "track") return result(wrong.length ? "No: something you placed is wrong." : "Yes, nothing you placed is wrong.");
  const message = wrong.length ? `${plural(wrong.length, "cell is", "cells are")} wrong.` : "No cell is wrong.";
  return result(message, [], [], wrong.map((i) => ({ i, style: "wrong" })));
}

/**
 * What a hint or check does. kind: "nudge" | "cell" | "line" | "track" | "mistakes". lastWrong: the cells the
 * player placed, newest last. pick: {axis, index} for "line". Returns {set: [{i, v}], highlight: {lines, cells}, message}.
 */
export async function runHint(kind, { puzzle, state, engine, lastWrong, pick }) {
  if (kind === "track" || kind === "mistakes") return checkResult(kind, puzzle, state);
  if (kind === "line") {
    if (puzzle.multi) return result("Reveal a line is not available for this puzzle.");
    if (!pick) return result("Pick a row or a column first.");
    return result(`${word(pick.axis)} ${pick.index + 1} is set.`, revealLine(puzzle, pick), [{ axis: pick.axis, index: pick.index }]);
  }

  const wrong = wrongCells(puzzle, state);
  if (wrong.length) {
    const i = pickWrong(wrong, lastWrong);
    return result("This cell is wrong.", [], [], [{ i, style: "wrong" }]);
  }

  const move = await engine.hint(puzzle, state);
  const nudge = kind === "nudge";
  const here = (i) => [{ i, style: "hint" }];

  switch (move.kind) {
    case "line": {
      const name = `${word(move.axis)} ${move.index + 1}`;
      if (nudge) return result(`${name} has a sure move.`, [], [{ axis: move.axis, index: move.index }]);
      const first = firstCell(puzzle, move);
      return result(`${name} decides this cell: it is ${first.v === FILLED ? "filled" : "empty"}.`, [first], [], here(first.i));
    }
    case "probe": {
      const i = move.cell[0] * puzzle.w + move.cell[1];
      if (nudge) return result("Try this cell both ways: one of them breaks a line.", [], [], here(i));
      const broken = `${move.value ? "Empty" : "Filled"}, this cell would leave ${word(move.axis).toLowerCase()} ${move.index + 1} impossible.`;
      return result(`${broken} So it ${move.value ? "is filled" : "stays empty"}.`, [{ i, v: move.value ? FILLED : MARKED }], [], here(i));
    }
    case "contradiction":
      return result(`${word(move.axis)} ${move.index + 1} cannot be completed with what is on the board.`, [], [{ axis: move.axis, index: move.index }]);
    case "solved":
      return result("Nothing left to show: the board is solved.");
    default: {
      const none = "No row or column decides anything here: this puzzle needs a guess.";
      if (nudge || puzzle.multi) return result(none);
      let i = state.findIndex((v, k) => v === 0 && puzzle.solution[k]);
      let v = FILLED;
      if (i < 0) (i = state.indexOf(0)), (v = MARKED);
      return i < 0 ? result(none) : result(none, [{ i, v }], [], here(i));
    }
  }
}
