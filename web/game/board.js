// The play board: one canvas with the clues and the grid, drawn like the Maker's board. It owns the
// cells, the tools, the stroke rule, the undo history and the reveal. It knows nothing about hints,
// skeins or the timer: the screen (play.js) listens to its events and calls its methods.
//
//   events   "stroke" {changed: number[]}   after a stroke, undo, redo or setCells
//            "cursor" {r, c}                after a keyboard move of the cursor
//            "tool"   {tool}                when a key (1, 2) or the tool property changes the tool
//
// The pure parts (strokePath, applyStroke, boardLayout) are exported and tested without a DOM.

import { css, tile, dot } from "../draw.js?v=dev";

const FILL = 1;
const MARK = 2;
const MAX_UNDO = 500;
const MAX_CELL = 30;
const MIN_CELL = { pointer: 12, touch: 14 };

/** @typedef {{i: number, from: number, to: number}} Change */

const toValue = (tool) => (tool === "mark" || tool === MARK ? MARK : FILL);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// The cells of one stroke, from start to end (cell indices, row-major), locked to one axis: "row"
// keeps the row of start, "col" keeps its column. Without an axis, the longer distance decides
// (a tie goes to the row). Every cell between the two ends is on the path, so a fast drag skips nothing.
export function strokePath(start, end, w, axis = null) {
  if (start === end) return [start];
  const sx = start % w;
  const sy = (start - sx) / w;
  const ex = end % w;
  const ey = (end - ex) / w;
  const a = axis ?? (Math.abs(ex - sx) >= Math.abs(ey - sy) ? "row" : "col");
  const out = [];
  if (a === "row") {
    const step = ex >= sx ? 1 : -1;
    for (let x = sx; ; x += step) {
      out.push(sy * w + x);
      if (x === ex) break;
    }
  } else {
    const step = ey >= sy ? 1 : -1;
    for (let y = sy; ; y += step) {
      out.push(y * w + sx);
      if (y === ey) break;
    }
  }
  return out;
}

// The stroke rule of docs/game-design.md §1. v0 is the value of the first cell on the path and t the tool
// value (1 filled, 2 marked; "fill" and "mark" also work). Only cells whose value is v0 change: to 0 when
// v0 == t, else to t. Pure: state is not changed. Returns [{i, from, to}].
export function applyStroke(state, path, tool) {
  if (!path.length) return [];
  const t = toValue(tool);
  const v0 = state[path[0]];
  const to = v0 === t ? 0 : t;
  const out = [];
  for (const i of path) if (state[i] === v0) out.push({ i, from: v0, to });
  return out;
}

// The size of the canvas. avail is the width the board may use; the cell is as large as fits (at most 30),
// but never below minCell, and then the frame scrolls.
export function boardLayout(rows, cols, w, h, avail, minCell) {
  const longest = (list) => Math.max(1, ...list.map((c) => c.length || 1));
  const rmax = longest(rows);
  const cmax = longest(cols);
  const cell = clamp(Math.floor((avail - 8) / (w + rmax * 0.9)), minCell, MAX_CELL);
  const left = Math.ceil(rmax * cell * 0.9) + 4;
  const top = Math.ceil(cmax * cell * 0.9) + 4;
  return { cell, left, top, width: left + w * cell + 2, height: top + h * cell + 2 };
}

const KEY_STEP = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };

export class Board extends EventTarget {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {HTMLElement} wrap  the scrolling frame (.board-wrap) that holds the canvas
   */
  constructor(canvas, wrap) {
    super();
    this.canvas = canvas;
    this.wrap = wrap;
    this.ctx = canvas.getContext("2d");
    this.puzzle = null;
    this._state = new Uint8Array(0);
    this._tool = "fill";
    this._undo = []; // arrays of Change
    this._redo = [];
    this._lines = null; // {rows, cols} from the solver: 0 open, 1 impossible, 2 done
    this._hl = { lines: [], cells: [] };
    this._cursor = { r: 0, c: 0 };
    this._cursorShown = false;
    this._stroke = null; // the stroke in progress
    this._pan = null; // a mouse drag with the Move tool
    this._kb = null; // the last keyboard action, for Shift + arrows: {t, v0, step}
    this._rev = null; // the reveal: {solution, color, t}
    this._raf = 0;
    this._geom = { cell: 10, left: 0, top: 0, width: 0, height: 0 };
    this._fitKey = "";

    if (!canvas.hasAttribute?.("tabindex")) canvas.setAttribute?.("tabindex", "0");
    canvas.setAttribute?.("role", "application");
    if (!canvas.getAttribute?.("aria-label")) canvas.setAttribute?.("aria-label", "The puzzle board");
    this._applyTool();
    // A flex frame with plain `center` clips the left of a board that is wider than the frame; `safe` scrolls to it.
    if (wrap.style) wrap.style.justifyContent = "safe center";

    this._on = {
      down: (e) => this._pointerDown(e),
      move: (e) => this._pointerMove(e),
      up: (e) => this._pointerUp(e),
      cancel: (e) => this._pointerCancel(e),
      menu: (e) => e.preventDefault(),
      key: (e) => this._keyDown(e),
      theme: () => this.draw(),
      resize: () => this._resized(),
    };
    canvas.addEventListener("pointerdown", this._on.down);
    canvas.addEventListener("pointermove", this._on.move);
    canvas.addEventListener("pointerup", this._on.up);
    canvas.addEventListener("pointercancel", this._on.cancel);
    canvas.addEventListener("contextmenu", this._on.menu);
    canvas.addEventListener("keydown", this._on.key);
    globalThis.document?.addEventListener("hugi:theme", this._on.theme);
    globalThis.addEventListener?.("resize", this._on.resize);
    if (globalThis.ResizeObserver) {
      this._ro = new ResizeObserver(this._on.resize);
      this._ro.observe(wrap);
    }
  }

  dispose() {
    const c = this.canvas;
    c.removeEventListener("pointerdown", this._on.down);
    c.removeEventListener("pointermove", this._on.move);
    c.removeEventListener("pointerup", this._on.up);
    c.removeEventListener("pointercancel", this._on.cancel);
    c.removeEventListener("contextmenu", this._on.menu);
    c.removeEventListener("keydown", this._on.key);
    globalThis.document?.removeEventListener("hugi:theme", this._on.theme);
    globalThis.removeEventListener?.("resize", this._on.resize);
    this._ro?.disconnect();
    this._stopReveal();
  }

  // ── State ────────────────────────────────────────────────────────────────

  /** A fresh board, or a saved one (state: Uint8Array of w*h). History, highlights and the reveal are reset. */
  load(puzzle, state = null) {
    this._stopReveal();
    this.puzzle = puzzle;
    this._state = new Uint8Array(puzzle.w * puzzle.h);
    if (state) this._state.set(state.subarray ? state.subarray(0, this._state.length) : state.slice(0, this._state.length));
    this._undo = [];
    this._redo = [];
    this._lines = null;
    this._hl = { lines: [], cells: [] };
    this._cursor = { r: 0, c: 0 };
    this._cursorShown = false;
    this._stroke = null;
    this._kb = null;
    this._fitKey = "";
    this.draw();
  }

  /** The cells: 0 unknown, 1 filled, 2 marked. Do not mutate. */
  get state() {
    return this._state;
  }

  get tool() {
    return this._tool;
  }

  set tool(tool) {
    if (!["fill", "mark", "move"].includes(tool) || tool === this._tool) return;
    this._tool = tool;
    this._applyTool();
    this.dispatchEvent(new CustomEvent("tool", { detail: { tool } }));
  }

  get cursor() {
    return { ...this._cursor };
  }

  get canUndo() {
    return this._undo.length > 0;
  }

  get canRedo() {
    return this._redo.length > 0;
  }

  get revealed() {
    return this._rev !== null;
  }

  _applyTool() {
    // Fill and Mark need every pointer event; Move lets one finger scroll the frame.
    this.canvas.style.touchAction = this._tool === "move" ? "pan-x pan-y" : "none";
    this.canvas.style.cursor = this._tool === "move" ? "grab" : "crosshair";
  }

  _emit(changes) {
    this.dispatchEvent(new CustomEvent("stroke", { detail: { changed: changes.map((c) => c.i) } }));
  }

  // One undo step. Clears the redo history and, because it is a stroke, the highlights.
  _push(step) {
    this._undo.push(step);
    if (this._undo.length > MAX_UNDO) this._undo.shift();
    this._redo = [];
    this._hl = { lines: [], cells: [] };
  }

  undo() {
    const step = this._undo.pop();
    if (!step || this._rev) return;
    for (const c of step) this._state[c.i] = c.from;
    this._redo.push(step);
    this._after(step);
  }

  redo() {
    const step = this._redo.pop();
    if (!step || this._rev) return;
    for (const c of step) this._state[c.i] = c.to;
    this._undo.push(step);
    this._after(step);
  }

  _after(step) {
    this._kb = null;
    this._hl = { lines: [], cells: [] };
    this.draw();
    this._emit(step);
  }

  /** Set cells as one undo step (hints use this). list: [{i, v}]. Cells that already have v are skipped.
   *  The highlights stay, so a hint can set a cell and outline it in either order. */
  setCells(list) {
    if (this._rev) return;
    const step = [];
    for (const { i, v } of list) if (this._state[i] !== v) step.push({ i, from: this._state[i], to: v });
    if (!step.length) return;
    for (const c of step) this._state[c.i] = c.to;
    const keep = this._hl;
    this._push(step);
    this._hl = keep;
    this._kb = null;
    this.draw();
    this._emit(step);
  }

  /** Outline lines ([{axis: "row"|"col", index}]) and cells ([{i, style: "hint"|"wrong"}]) until the next stroke.
   *  Called without an argument, it clears them. */
  highlight({ lines = [], cells = [] } = {}) {
    this._hl = { lines: [...lines], cells: [...cells] };
    this.draw();
  }

  /** The solver's status of every line: {rows: number[], cols: number[]}, 0 open, 1 impossible, 2 done. */
  setLineStatus(status) {
    this._lines = status;
    this.draw();
  }

  // ── Pointer ──────────────────────────────────────────────────────────────

  // The cell under a client position. With clamp, a position outside the grid gives the nearest edge cell.
  _cellAt(clientX, clientY, clamped = false) {
    const p = this.puzzle;
    const r = this.canvas.getBoundingClientRect();
    const { left, top, cell } = this._geom;
    let x = Math.floor((clientX - r.left - left) / cell);
    let y = Math.floor((clientY - r.top - top) / cell);
    if (clamped) {
      x = clamp(x, 0, p.w - 1);
      y = clamp(y, 0, p.h - 1);
    } else if (x < 0 || y < 0 || x >= p.w || y >= p.h) return -1;
    return y * p.w + x;
  }

  /** The row or column whose clue is under a client position, or null. For the pick mode of "Reveal a line". */
  lineAt(clientX, clientY) {
    if (!this.puzzle) return null;
    const p = this.puzzle;
    const r = this.canvas.getBoundingClientRect();
    const { left, top, cell } = this._geom;
    const x = Math.floor((clientX - r.left - left) / cell);
    const y = Math.floor((clientY - r.top - top) / cell);
    if (clientY - r.top < top && x >= 0 && x < p.w) return { axis: "col", index: x };
    if (clientX - r.left < left && y >= 0 && y < p.h) return { axis: "row", index: y };
    return null;
  }

  _pointerDown(e) {
    if (!this.puzzle || this._rev) return;
    const right = e.button === 2;
    if (e.button !== 0 && !right) return;
    this._cursorShown = false;
    if (this._tool === "move" && !right) {
      // Touch scrolls by itself (touch-action). A mouse drags the frame.
      if (e.pointerType === "mouse") {
        this.canvas.setPointerCapture?.(e.pointerId);
        this._pan = { x: e.clientX, y: e.clientY, sl: this.wrap.scrollLeft, st: this.wrap.scrollTop };
        this.canvas.style.cursor = "grabbing";
      }
      return;
    }
    const start = this._cellAt(e.clientX, e.clientY);
    if (start < 0) return;
    e.preventDefault();
    this.canvas.focus?.({ preventScroll: true });
    this.canvas.setPointerCapture?.(e.pointerId);
    const w = this.puzzle.w;
    this._cursor = { r: Math.floor(start / w), c: start % w };
    const rect = this.canvas.getBoundingClientRect();
    const { left, top, cell } = this._geom;
    this._stroke = {
      pointerId: e.pointerId,
      t: right ? MARK : toValue(this._tool),
      start,
      axis: null,
      base: this._state.slice(),
      changes: [],
      cx: rect.left + left + ((start % w) + 0.5) * cell, // the centre of the first cell, to pick the axis
      cy: rect.top + top + (Math.floor(start / w) + 0.5) * cell,
    };
    this._strokeTo(start);
  }

  _pointerMove(e) {
    if (this._pan) {
      this.wrap.scrollLeft = this._pan.sl - (e.clientX - this._pan.x);
      this.wrap.scrollTop = this._pan.st - (e.clientY - this._pan.y);
      return;
    }
    const s = this._stroke;
    if (!s || e.pointerId !== s.pointerId) return;
    const end = this._cellAt(e.clientX, e.clientY, true);
    if (s.axis === null && end !== s.start) {
      // The pointer left the first cell: the larger offset from its centre locks the axis.
      s.axis = Math.abs(e.clientX - s.cx) >= Math.abs(e.clientY - s.cy) ? "row" : "col";
    }
    this._strokeTo(end);
  }

  // Show the stroke from its first cell to `end`: the cells are rebuilt from the state before the stroke,
  // so a drag that turns back gives the cells back.
  _strokeTo(end) {
    const s = this._stroke;
    const path = strokePath(s.start, end, this.puzzle.w, s.axis);
    const changes = applyStroke(s.base, path, s.t);
    this._state.set(s.base);
    for (const c of changes) this._state[c.i] = c.to;
    s.changes = changes;
    this.draw();
  }

  _pointerUp(e) {
    if (this._pan) {
      this._pan = null;
      this._applyTool();
      return;
    }
    const s = this._stroke;
    if (!s || e.pointerId !== s.pointerId) return;
    this._stroke = null;
    this._kb = null;
    if (!s.changes.length) return;
    this._push(s.changes);
    this.draw();
    this._emit(s.changes);
  }

  _pointerCancel() {
    this._pan = null;
    this._applyTool();
    const s = this._stroke;
    if (!s) return;
    this._stroke = null;
    this._state.set(s.base);
    this.draw();
  }

  // ── Keyboard ─────────────────────────────────────────────────────────────

  _keyDown(e) {
    if (!this.puzzle || this._rev || e.altKey) return;
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    const mod = e.ctrlKey || e.metaKey;
    const handled = () => {
      e.preventDefault();
      this._cursorShown = true;
    };
    if (mod) {
      if (k === "z") {
        e.preventDefault();
        if (e.shiftKey) this.redo();
        else this.undo();
      } else if (k === "y") {
        e.preventDefault();
        this.redo();
      }
      return;
    }
    if (KEY_STEP[k]) {
      handled();
      this._moveCursor(...KEY_STEP[k], e.shiftKey);
    } else if (k === " " || k === "enter") {
      handled();
      this._keyAct(FILL);
    } else if (k === "x" || k === ".") {
      handled();
      this._keyAct(MARK);
    } else if (k === "z") {
      e.preventDefault();
      this.undo();
    } else if (k === "y") {
      e.preventDefault();
      this.redo();
    } else if (k === "1") {
      this.tool = "fill";
    } else if (k === "2") {
      this.tool = "mark";
    }
  }

  _moveCursor(dr, dc, repeat) {
    const { w, h } = this.puzzle;
    this._cursor = { r: clamp(this._cursor.r + dr, 0, h - 1), c: clamp(this._cursor.c + dc, 0, w - 1) };
    if (repeat && this._kb) this._keyRepeat();
    else this._kb = null;
    this.draw();
    this.dispatchEvent(new CustomEvent("cursor", { detail: { ...this._cursor } }));
  }

  // Space, Enter, X: a stroke of one cell at the cursor. It starts a keyboard drag for Shift + arrows.
  _keyAct(t) {
    const i = this._cursor.r * this.puzzle.w + this._cursor.c;
    const step = applyStroke(this._state, [i], t);
    if (!step.length) return;
    const v0 = this._state[i];
    this._state[i] = step[0].to;
    this._push(step);
    this._kb = { t, v0, step };
    this.draw();
    this._emit(step);
  }

  // Shift + arrow: the last keyboard action again, on the new cell, with the stroke rule of the first cell.
  _keyRepeat() {
    const { t, v0 } = this._kb;
    const i = this._cursor.r * this.puzzle.w + this._cursor.c;
    if (this._state[i] !== v0) return;
    const change = { i, from: v0, to: v0 === t ? 0 : t };
    this._state[i] = change.to;
    if (this._undo[this._undo.length - 1] === this._kb.step) this._kb.step.push(change);
    else {
      this._kb.step = [change];
      this._push(this._kb.step);
    }
    this._emit([change]);
  }

  // ── Layout and drawing ───────────────────────────────────────────────────

  _resized() {
    globalThis.cancelAnimationFrame?.(this._rz);
    this._rz = globalThis.requestAnimationFrame?.(() => this.draw());
  }

  // Sizes the canvas for the puzzle, the frame and the pixel ratio. Returns the geometry.
  _fit() {
    const p = this.puzzle;
    const wrap = this.wrap;
    const cs = globalThis.getComputedStyle?.(wrap);
    const pad = (parseFloat(cs?.paddingLeft) || 0) + (parseFloat(cs?.paddingRight) || 0);
    const avail = Math.max(220, wrap.clientWidth - pad);
    const coarse = !!globalThis.matchMedia?.("(pointer: coarse)").matches;
    const dpr = globalThis.devicePixelRatio || 1;
    const g = boardLayout(p.rows, p.cols, p.w, p.h, avail, coarse ? MIN_CELL.touch : MIN_CELL.pointer);
    const key = `${p.id}|${g.width}x${g.height}|${dpr}`;
    if (key !== this._fitKey) {
      this._fitKey = key;
      this.canvas.width = Math.round(g.width * dpr);
      this.canvas.height = Math.round(g.height * dpr);
      this.canvas.style.width = g.width + "px";
      this.canvas.style.height = g.height + "px";
    }
    this._geom = g;
    return { ...g, dpr };
  }

  draw() {
    const p = this.puzzle;
    if (!p || !this.ctx) return;
    const { cell, left, top, width, height, dpr } = this._fit();
    const ctx = this.ctx;
    const { w, h } = p;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height); // the linen of .board-wrap shows through
    ctx.globalAlpha = 1;
    const rv = this._rev ? this._revFrame() : null;
    const x0 = (x) => left + x * cell;
    const y0 = (y) => top + y * cell;

    // Tiles
    if (rv) this._drawRevealTiles(ctx, rv, cell, left, top);
    else {
      const ink = css("--t5");
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (this._state[y * w + x] === FILL) tile(ctx, x0(x), y0(y), cell, ink);
    }

    // Marks: a quiet dot
    if (!rv || rv.marks > 0) {
      ctx.globalAlpha = rv ? rv.marks : 1;
      const muted = css("--muted");
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (this._state[y * w + x] === MARK) dot(ctx, x0(x), y0(y), cell, muted);
      ctx.globalAlpha = 1;
    }

    // Highlights of a hint or a check
    if (!rv) {
      const fillHint = css("--hint-fill");
      const stitch = css("--stitch");
      for (const { axis, index } of this._hl.lines) {
        const bx = axis === "col" ? x0(index) : 0;
        const by = axis === "col" ? 0 : y0(index);
        const bw = axis === "col" ? cell : x0(w);
        const bh = axis === "col" ? y0(h) : cell;
        ctx.fillStyle = fillHint;
        ctx.fillRect(bx, by, bw, bh);
        ctx.strokeStyle = stitch;
        ctx.lineWidth = 2;
        ctx.strokeRect(bx + 1, by + 1, bw - 2, bh - 2);
      }
      for (const { i, style } of this._hl.cells) {
        const px = x0(i % w);
        const py = y0(Math.floor(i / w));
        if (style === "wrong") {
          ctx.fillStyle = css("--madder-fill");
          ctx.fillRect(px, py, cell, cell);
          ctx.strokeStyle = css("--madder");
          ctx.setLineDash([3, 2]);
        } else {
          ctx.fillStyle = css("--hint-fill");
          ctx.fillRect(px, py, cell, cell);
          ctx.strokeStyle = stitch;
        }
        ctx.lineWidth = 2;
        ctx.strokeRect(px + 1.5, py + 1.5, cell - 3, cell - 3);
        ctx.setLineDash([]);
      }
    }

    // Grid and clues, which fade out in the reveal
    const chrome = rv ? rv.grid : 1;
    if (chrome > 0) {
      ctx.globalAlpha = chrome;
      this._drawGrid(ctx, cell, left, top, dpr);
      this._drawClues(ctx, cell, left, top);
      ctx.globalAlpha = 1;
    }

    // The keyboard cursor
    if (!rv && this._cursorShown) {
      ctx.strokeStyle = css("--stitch");
      ctx.lineWidth = 2;
      ctx.strokeRect(x0(this._cursor.c) + 2, y0(this._cursor.r) + 2, cell - 4, cell - 4);
    }
  }

  _drawGrid(ctx, cell, left, top, dpr) {
    const { w, h } = this.puzzle;
    const heavy = css("--heavy");
    const thin = css("--line");
    // Line widths are whole device pixels, centred on a pixel, so the lines stay crisp at any ratio.
    const stroke = (bold, vertical, at, from, to) => {
      const dev = bold ? Math.max(2, Math.round(1.2 * dpr)) : 1;
      const off = dev % 2 ? 0.5 : 0;
      const pos = (Math.round(at * dpr - off) + off) / dpr;
      ctx.strokeStyle = bold ? heavy : thin;
      ctx.lineWidth = dev / dpr;
      ctx.beginPath();
      if (vertical) {
        ctx.moveTo(pos, from);
        ctx.lineTo(pos, to);
      } else {
        ctx.moveTo(from, pos);
        ctx.lineTo(to, pos);
      }
      ctx.stroke();
    };
    for (let i = 0; i <= w; i++) stroke(i % 5 === 0, true, left + i * cell, top, top + h * cell);
    for (let i = 0; i <= h; i++) stroke(i % 5 === 0, false, top + i * cell, left, left + w * cell);
  }

  _drawClues(ctx, cell, left, top) {
    const { rows, cols } = this.puzzle;
    const show = (c) => (c.length ? c : [0]);
    ctx.font = `${Math.max(9, Math.floor(cell * 0.66))}px ${css("--serif")}`;
    ctx.textBaseline = "middle";
    const ink = css("--ink");
    const muted = css("--muted");
    const bad = css("--bad");
    // done: --muted at 55 %; impossible: --bad; open: --ink
    const paint = (status) => {
      ctx.fillStyle = status === 1 ? bad : status === 2 ? muted : ink;
      return status === 2 ? 0.55 : 1;
    };
    const base = ctx.globalAlpha;
    ctx.textAlign = "right";
    rows.forEach((r, i) => {
      ctx.globalAlpha = base * paint(this._lines?.rows?.[i] ?? 0);
      [...show(r)].reverse().forEach((v, k) => ctx.fillText(v, left - 4 - k * cell * 0.9, top + (i + 0.5) * cell));
    });
    ctx.textAlign = "center";
    cols.forEach((c, i) => {
      ctx.globalAlpha = base * paint(this._lines?.cols?.[i] ?? 0);
      [...show(c)].reverse().forEach((v, k) => ctx.fillText(v, left + (i + 0.5) * cell, top - cell * 0.5 - k * cell * 0.9));
    });
    ctx.globalAlpha = base;
  }

  // ── The reveal ───────────────────────────────────────────────────────────

  /** The win animation of §1. solution: Uint8Array of the picture (1 filled). color: a CSS colour, a variable
   *  name ("--t3") or a thread number (1..5). Resolves at the end; at once with prefers-reduced-motion.
   *  The board stays revealed (no clues, no grid, no input) until the next load(). */
  reveal(solution, color) {
    this._stopReveal();
    this._stroke = null;
    this._hl = { lines: [], cells: [] };
    const { w, h } = this.puzzle;
    const step = Math.min(18, 1100 / (w + h));
    const total = 550 + (w + h - 2) * step + 160;
    const reduced = !!globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    this._rev = { solution, color, step, total, t: reduced ? Infinity : 0 };
    this.draw();
    if (reduced) return Promise.resolve();
    return new Promise((resolve) => {
      this._revDone = resolve;
      const t0 = performance.now();
      const tick = (now) => {
        const rev = this._rev;
        if (!rev) return;
        rev.t = (now ?? performance.now()) - t0;
        this.draw();
        if (rev.t >= rev.total) {
          this._raf = 0;
          this._revDone = null;
          resolve();
        } else this._raf = requestAnimationFrame(tick);
      };
      this._raf = requestAnimationFrame(tick);
    });
  }

  _stopReveal() {
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = 0;
    this._rev = null;
    const done = this._revDone;
    this._revDone = null;
    done?.();
  }

  _revColor() {
    const c = this._rev.color;
    if (typeof c === "number") return css("--t" + c);
    return typeof c === "string" && c.startsWith("--") ? css(c) : c;
  }

  _revFrame() {
    const { t, step } = this._rev;
    return { marks: 1 - clamp(t / 250, 0, 1), grid: 1 - clamp((t - 250) / 300, 0, 1), t, step };
  }

  // Each tile goes from --t5 to the thread colour while its margin goes to 0, so the tiles join.
  _drawRevealTiles(ctx, rv, cell, left, top) {
    const { w, h } = this.puzzle;
    const { solution } = this._rev;
    const ink = css("--t5");
    const color = this._revColor();
    const m0 = cell < 9 ? 0 : Math.max(0.5, cell * 0.035);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (!solution[y * w + x]) continue;
        const px = left + x * cell;
        const py = top + y * cell;
        const p = clamp((rv.t - 550 - (x + y) * rv.step) / 160, 0, 1);
        if (p >= 1) {
          ctx.fillStyle = color;
          ctx.fillRect(px, py, cell, cell);
          continue;
        }
        const e = p * p * (3 - 2 * p);
        tile(ctx, px, py, cell, ink, m0 * (1 - e));
        if (e > 0) {
          ctx.globalAlpha = e;
          tile(ctx, px, py, cell, color, m0 * (1 - e));
          ctx.globalAlpha = 1;
        }
      }
    }
  }
}
