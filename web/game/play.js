// The puzzle screen (docs/game-design.md §1, §2, §5): the board, the timer, the tools, the help, autosave
// and the win. It registers the "puzzle" view and owns #view-puzzle.
//
// Phones (under 860 px) are board first: title and timer on top, the board as wide as the screen, and a
// sticky bar at the bottom with the message line and the tools. Help is a sheet that opens above that bar
// and closes when a choice is made, so a hint highlight is never hidden behind it. From 860 px the same
// elements are a side panel and Help is always open (play.css).

import { ctx, registerScreen, go, setSkeins, toast } from "./main.js?v=dev";
import { Board } from "./board.js?v=dev";
import { lineStatus } from "./engine.js?v=dev";
import { runHint } from "./hints.js?v=dev";
import { PRICES, ACHIEVEMENTS, par as parOf, today } from "./rules.js?v=dev";
import { getProgress, putProgress, clearProgress, recordSolve, spend, writeSave, saveStatus } from "./save.js?v=dev";
import { dailyFor, dailyOpen, tierState, nextPuzzle, sharedPuzzle } from "./pack.js?v=dev";
import { css } from "../draw.js?v=dev";

const link = document.createElement("link");
link.rel = "stylesheet";
link.href = "game/play.css?v=dev";
document.head.append(link);

const SAVE_DELAY_MS = 400;
const MAX_PLACED = 500;
const CELL_NAME = ["empty", "filled", "marked"];
const MULTI_NOTE = "This puzzle has more than one solution. Any picture that fits every clue counts.";
const UNCHECKED_NOTE = "Hugi could not finish checking this puzzle.";

// The help buttons in sheet order. kind is the runHint kind; stat is what the save counts.
const HELP = [
  { kind: "nudge", label: "Nudge", tip: "Shows where the easiest next move is.", stat: "hint" },
  { kind: "cell", label: "Show a cell", tip: "Sets one sure cell for you.", stat: "hint" },
  { kind: "line", label: "Reveal a line", tip: "Fills in a whole row or column of your choice.", stat: "hint" },
  { kind: "track", label: "On track?", tip: "Tells you whether anything you placed is wrong.", stat: "check" },
  { kind: "mistakes", label: "Show mistakes", tip: "Outlines every wrong cell.", stat: "check" },
];
const MULTI_HIDDEN = new Set(["line", "track", "mistakes"]); // "wrong" means nothing with several answers (§5b)

const pad = (n) => String(n).padStart(2, "0");
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

function clock(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}

function el(tag, props = {}, ...kids) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...kids);
  return node;
}

// ── The DOM, built once ────────────────────────────────────────────────────

let ui = null; // element references
let board = null;
let cur = null; // the puzzle on screen: see load()
let active = false; // the puzzle view is the current route
let seq = 0; // a newer show() makes an older one stale
let saveTimer = 0;
let tick = 0;

function build(root) {
  root.innerHTML = `
    <section class="pz" aria-label="Puzzle">
      <div class="board-wrap pz-frame"><canvas class="pz-canvas"></canvas></div>
      <aside class="pz-panel">
        <div class="pz-head">
          <h2 class="pz-title"></h2>
          <span class="pz-time" role="timer"><span class="pz-clock">0:00</span><span class="pz-par"></span></span>
          <span class="skeins pz-skeins"></span>
        </div>
        <div class="pz-notes"></div>
        <div class="pz-bar">
          <div class="pz-msgrow">
            <p class="pz-msg" aria-live="polite"></p>
            <button type="button" class="pz-cancel" hidden>Cancel</button>
          </div>
          <div class="pz-help" id="pz-help" role="group" aria-label="Help">
            <p class="pz-help-head"><strong>Help</strong> <span class="pz-help-skeins"></span></p>
            <div class="pz-help-grid"></div>
          </div>
          <div class="pz-tools" role="toolbar" aria-label="Tools">
            <button type="button" data-tool="fill" aria-pressed="true" title="Fill (1)">Fill</button>
            <button type="button" data-tool="mark" aria-pressed="false" title="Mark (2)">Mark</button>
            <button type="button" data-tool="move" aria-pressed="false" title="Move the board with one finger" hidden>Move</button>
            <button type="button" data-act="undo" title="Undo (Z)">Undo</button>
            <button type="button" data-act="redo" title="Redo (Y)">Redo</button>
            <button type="button" data-act="help" class="pz-helpbtn" aria-expanded="false" aria-controls="pz-help">Help</button>
          </div>
        </div>
        <section class="pz-win card" tabindex="-1" aria-labelledby="pz-win-name" hidden>
          <h3 class="pz-win-name" id="pz-win-name"></h3>
          <p class="pz-win-meta"></p>
          <p class="pz-stars" role="img"></p>
          <ul class="pz-why"></ul>
          <p class="pz-win-skeins"></p>
          <p class="pz-win-more muted"></p>
          <div class="row">
            <button type="button" class="primary" data-win="next">Next</button>
            <button type="button" data-win="quilt">Quilt</button>
            <button type="button" data-win="png">Save picture</button>
          </div>
        </section>
        <div class="pz-extras"><button type="button" data-act="restart">Restart</button></div>
      </aside>
      <p class="sr-only pz-sr" aria-live="polite"></p>
    </section>
    <section class="card pz-card" hidden>
      <h2></h2>
      <p class="muted"></p>
      <p><button type="button" class="primary" data-card="play">Play</button></p>
    </section>
    <dialog class="pz-confirm" aria-labelledby="pz-confirm-title">
      <form method="dialog">
        <h2 id="pz-confirm-title">Start this puzzle again?</h2>
        <p>Your board and your time are cleared. Skeins you spent are not given back.</p>
        <div class="actions">
          <button value="keep" autofocus>Keep playing</button>
          <button value="restart" class="primary">Restart</button>
        </div>
      </form>
    </dialog>`;
  const $ = (sel) => root.querySelector(sel);
  ui = {
    root,
    pz: $(".pz"),
    wrap: $(".pz-frame"),
    canvas: $(".pz-canvas"),
    title: $(".pz-title"),
    clock: $(".pz-clock"),
    par: $(".pz-par"),
    skeins: $(".pz-skeins"),
    notes: $(".pz-notes"),
    msg: $(".pz-msg"),
    cancel: $(".pz-cancel"),
    help: $(".pz-help"),
    helpGrid: $(".pz-help-grid"),
    helpSkeins: $(".pz-help-skeins"),
    helpBtn: $(".pz-helpbtn"),
    sr: $(".pz-sr"),
    tools: [...root.querySelectorAll("[data-tool]")],
    undo: $('[data-act="undo"]'),
    redo: $('[data-act="redo"]'),
    move: $('[data-tool="move"]'),
    bar: $(".pz-bar"),
    win: $(".pz-win"),
    card: $(".pz-card"),
    confirm: $(".pz-confirm"),
    helpButtons: [],
  };

  for (const h of HELP) {
    const b = el("button", { type: "button", className: "pz-hbtn" });
    b.dataset.kind = h.kind;
    b.append(el("span", { className: "lbl", textContent: h.label }), el("span", { className: "price", textContent: String(PRICES[h.kind]) }));
    b.setAttribute("aria-label", `${h.label}, ${plural(PRICES[h.kind], "skein", "skeins")}`);
    b.onclick = () => useHelp(h.kind);
    ui.helpGrid.append(b);
    ui.helpButtons.push(b);
  }
  // The sheet's last cell: Restart, so the sticky bar of a phone reaches it (the side panel has its own below).
  ui.helpGrid.append(el("button", { type: "button", className: "pz-restart", textContent: "Restart", onclick: askRestart }));

  board = new Board(ui.canvas, ui.wrap);
  ui.canvas.setAttribute("aria-label", "Puzzle board");
  board.addEventListener("stroke", onStroke);
  board.addEventListener("cursor", onCursor);
  board.addEventListener("tool", syncTools);
  ui.canvas.addEventListener("pointerdown", onPickDown, { capture: true });
  ui.canvas.addEventListener("keydown", onPickKey);

  for (const b of ui.tools) b.onclick = () => ((board.tool = b.dataset.tool), syncTools());
  ui.undo.onclick = () => board.undo();
  ui.redo.onclick = () => board.redo();
  ui.helpBtn.onclick = () => (ui.help.classList.contains("open") ? closeSheet(true) : openSheet());
  ui.cancel.onclick = () => cancelPick(true);
  root.querySelector('[data-act="restart"]').onclick = askRestart;
  ui.confirm.addEventListener("close", () => ui.confirm.returnValue === "restart" && restart());
  ui.win.querySelector('[data-win="quilt"]').onclick = () => go("#play");
  ui.win.querySelector('[data-win="png"]').onclick = () => cur && savePicture(cur.puzzle);
  ui.card.querySelector("button").onclick = () => go("#play");

  if (globalThis.ResizeObserver) {
    const ro = new ResizeObserver(fitTools);
    ro.observe(ui.wrap);
    ro.observe(ui.canvas);
  }
  document.addEventListener("keydown", onEscape);
  document.addEventListener("visibilitychange", onVisibility);
  addEventListener("pagehide", () => persist());
}

// ── Messages ───────────────────────────────────────────────────────────────

const say = (text) => (ui.msg.textContent = text);
const announce = (text) => (ui.sr.textContent = text);

function cellWords(i) {
  const { w, rows, cols } = cur.puzzle;
  const r = Math.floor(i / w);
  const c = i % w;
  return `Row ${r + 1}, column ${c + 1}, ${CELL_NAME[board.state[i]]}. Row clue ${rows[r].join(" ") || 0}. Column clue ${cols[c].join(" ") || 0}.`;
}

function onCursor({ detail: { r, c } }) {
  if (cur) announce(cellWords(r * cur.puzzle.w + c));
}

// ── The clock: starts at the first stroke, stops while the page is hidden ──

const elapsed = () => cur.acc + (cur.since === null ? 0 : (performance.now() - cur.since) / 1000);

function paintClock() {
  if (cur) ui.clock.textContent = clock(elapsed());
}

function runClock() {
  if (!cur || !cur.started || cur.won || !active || document.hidden || cur.since !== null) return;
  cur.since = performance.now();
  tick = setInterval(paintClock, 500);
}

function pauseClock() {
  clearInterval(tick);
  if (cur && cur.since !== null) {
    cur.acc = elapsed();
    cur.since = null;
  }
  paintClock();
}

function onVisibility() {
  if (!cur) return;
  if (document.hidden) {
    pauseClock();
    persist();
  } else runClock();
}

// ── Showing a puzzle ───────────────────────────────────────────────────────

function showCard(title, text, { play = true } = {}) {
  ui.pz.hidden = true;
  ui.card.hidden = false;
  ui.card.querySelector("h2").textContent = title;
  ui.card.querySelector("p").textContent = text;
  ui.card.querySelector("button").hidden = !play;
}

const tierName = (puzzle) => ctx.pack.tiers.find((t) => t.id === puzzle.tier)?.name ?? null;

function titleOf(puzzle) {
  const size = `${puzzle.w}×${puzzle.h}`;
  const tier = tierName(puzzle);
  const head =
    puzzle.kind === "pack"
      ? `Puzzle ${ctx.pack.puzzles.findIndex((p) => p.id === puzzle.id) + 1}`
      : puzzle.kind === "daily"
        ? "Daily puzzle"
        : puzzle.name || "Untitled";
  return [head, size, tier].filter(Boolean).join(" · ");
}

// What the route asks for: {puzzle} or {card: [title, text, {play}]}. A shared puzzle is checked here
// (one solution or several, and its rating) before the board opens.
async function resolve(params, token) {
  const { pack, save } = ctx;
  if (!pack || !save) return { card: ["The puzzles did not load", "Reload the page to try again.", { play: false }] };
  if (params.kind === "pack") {
    const puzzle = pack.byId.get(params.id);
    if (!puzzle || puzzle.kind !== "pack") return { card: ["There is no such puzzle", "This link does not match a puzzle in the collection."] };
    const t = tierState(pack, save, puzzle.tier);
    if (!t.open) {
      const before = pack.tiers[pack.tiers.findIndex((x) => x.id === puzzle.tier) - 1];
      return { card: ["This puzzle is locked", `Opens when you solve ${t.need} ${before.name} puzzles (${t.have} so far).`] };
    }
    return { puzzle };
  }
  if (params.kind === "daily") {
    if (!dailyOpen(pack, save)) {
      const n = pack.puzzles.filter((p) => save.solved[p.id]).length;
      return { card: ["The daily puzzle is not open yet", `It opens when you have solved 5 puzzles (${n} so far).`] };
    }
    const { puzzle, day } = dailyFor(pack);
    return puzzle ? { puzzle, day } : { card: ["There is no daily puzzle today", "Try one from the collection."] };
  }
  const puzzle = sharedPuzzle(params.hash);
  if (!puzzle) return { card: ["This link does not hold a puzzle", "It may be cut off or mistyped."] };
  if (puzzle.unique === undefined && puzzle.rating === undefined && ctx.engine) {
    showCard("Checking the puzzle…", "Hugi is looking for a second solution.", { play: false });
    const one = await ctx.engine.unique(puzzle).catch(() => null); // one at a time: each call has its own 5 s cap
    const rating = await ctx.engine.rate(puzzle).catch(() => ({ timeout: true }));
    if (token !== seq) return { stale: true };
    puzzle.unique = one !== false;
    puzzle.multi = one === false;
    puzzle.unchecked = one === null;
    puzzle.rating = rating.timeout ? { probes: 0 } : rating;
    puzzle.tier ??= rating.timeout || !rating.tier ? "tapestry" : rating.tier;
  }
  return { puzzle };
}

async function show(params) {
  if (!ui) build(document.getElementById("view-puzzle"));
  active = true;
  const token = ++seq;
  if (cur) leaveCurrent();
  ui.win.hidden = true;
  setSkeins(ctx.save ? ctx.save.skeins : null);
  const res = await resolve(params, token);
  if (token !== seq || res.stale) return;
  if (res.card) return showCard(...res.card);
  load(res.puzzle, res.day ?? today());
}

function hide() {
  active = false;
  seq++;
  if (cur) leaveCurrent();
}

// Pauses the clock, saves, and drops the puzzle that was on screen.
function leaveCurrent() {
  pauseClock();
  persist();
  closeSheet();
  cancelPick();
  clearTimeout(saveTimer);
  cur = null;
}

function load(puzzle, day) {
  ui.card.hidden = true;
  ui.pz.hidden = false;
  ui.win.hidden = true;
  ui.bar.hidden = false;
  ui.root.querySelector(".pz-extras").hidden = false;
  const prog = getProgress(ctx.save, puzzle.id, puzzle.w * puzzle.h);
  cur = {
    puzzle,
    day,
    par: parOf(puzzle),
    helped: prog?.helped ?? false,
    acc: prog?.seconds ?? 0,
    since: null,
    started: false,
    won: false,
    busy: false,
    picking: false,
    applying: false,
    placed: [],
    lines: null,
  };
  const used = prog && (prog.seconds > 0 || prog.state.some((v) => v));
  cur.started = !!used;
  board.tool = "fill";
  syncTools();
  board.load(puzzle, prog?.state ?? null);
  ui.title.textContent = titleOf(puzzle);
  ui.par.textContent = ` · par ${clock(cur.par)}`;
  paintNotes();
  paintStatus();
  paintSkeins();
  paintClock();
  say(used ? "Picked up where you left off." : "");
  fitTools();
  refresh();
  runClock();
  if (!used) ui.wrap.scrollTop = ui.wrap.scrollLeft = 0;
}

function paintNotes() {
  const { puzzle } = cur;
  ui.notes.replaceChildren();
  const add = (text, cls = "") => text && ui.notes.append(el("p", { className: `pz-note ${cls}`.trim(), textContent: text }));
  if (puzzle.kind === "shared" && puzzle.author) add(`From ${puzzle.author}.`);
  add(puzzle.note);
  if (puzzle.multi) add(MULTI_NOTE, "pz-strong");
  if (puzzle.unchecked) add(UNCHECKED_NOTE);
  const st = saveStatus(ctx.save);
  if (st.note && (st.unavailable || st.readOnly || st.broken)) add(st.note, "pz-savenote");
}

// ── Tools and buttons ──────────────────────────────────────────────────────

function syncTools() {
  for (const b of ui.tools) b.setAttribute("aria-pressed", String(b.dataset.tool === board.tool));
}

// Move is for a board that does not fit its frame.
function fitTools() {
  if (!ui) return;
  const wide = ui.wrap.scrollWidth > ui.wrap.clientWidth + 1 || ui.wrap.scrollHeight > ui.wrap.clientHeight + 1;
  ui.move.hidden = !wide;
  if (!wide && board.tool === "move") {
    board.tool = "fill";
    syncTools();
  }
}

function paintSkeins() {
  const n = ctx.save.skeins;
  ui.skeins.textContent = String(n);
  ui.skeins.setAttribute("aria-label", plural(n, "skein", "skeins"));
  ui.helpSkeins.textContent = plural(n, "skein", "skeins");
  setSkeins(n);
}

function refresh() {
  if (!cur) return;
  const { won, busy, puzzle } = cur;
  ui.undo.disabled = won || !board.canUndo;
  ui.redo.disabled = won || !board.canRedo;
  const n = ctx.save.skeins;
  for (const b of ui.helpButtons) {
    const kind = b.dataset.kind;
    const info = HELP.find((h) => h.kind === kind);
    const price = PRICES[kind];
    b.hidden = !!puzzle.multi && MULTI_HIDDEN.has(kind);
    const needsEngine = kind === "nudge" || kind === "cell";
    b.disabled = won || busy || (needsEngine && !ctx.engine);
    const poor = n < price;
    b.setAttribute("aria-disabled", String(poor));
    b.title = needsEngine && !ctx.engine ? "The solver did not load." : poor ? `You need ${plural(price, "skein", "skeins")}; you have ${n}.` : info.tip;
  }
}

// ── Strokes: free clue feedback, win test, autosave ────────────────────────

function paintStatus() {
  if (!ctx.solver?.hugi) return;
  try {
    cur.lines = lineStatus(ctx.solver.hugi, cur.puzzle, board.state);
    board.setLineStatus(cur.lines);
  } catch (e) {
    if (!cur.lineFailed) console.error("The clue status failed:", e);
    cur.lineFailed = true;
  }
}

function isSolved() {
  const { puzzle, lines } = cur;
  if (puzzle.multi) return !!lines && lines.rows.every((s) => s === 2) && lines.cols.every((s) => s === 2);
  const st = board.state;
  for (let i = 0; i < st.length; i++) if ((st[i] === 1) !== (puzzle.solution[i] === 1)) return false;
  return true;
}

function onStroke({ detail: { changed } }) {
  const c = cur;
  if (!c || c.won) return;
  c.placed.push(...changed);
  if (c.placed.length > MAX_PLACED) c.placed.splice(0, c.placed.length - MAX_PLACED);
  if (!c.applying) say("");
  if (!c.started) {
    c.started = true;
    runClock();
  }
  paintStatus();
  if (changed.length === 1 && document.activeElement === ui.canvas) announce(cellWords(changed[0]));
  refresh();
  if (isSolved()) finish();
  else scheduleSave();
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(persist, SAVE_DELAY_MS);
}

function persist() {
  clearTimeout(saveTimer);
  const c = cur;
  if (!c || c.won || !ctx.save) return;
  if (c.started || board.state.some((v) => v)) putProgress(ctx.save, c.puzzle.id, { state: board.state, seconds: Math.floor(elapsed()), helped: c.helped });
  writeSave(ctx.save);
  refreshSaveNote();
}

function refreshSaveNote() {
  const had = ui.notes.querySelector(".pz-savenote");
  const st = saveStatus(ctx.save);
  const show = st.note && (st.unavailable || st.readOnly || st.broken);
  if (!!had === !!show) return;
  if (had) had.remove();
  else ui.notes.append(el("p", { className: "pz-note pz-savenote", textContent: st.note }));
}

// ── Help ───────────────────────────────────────────────────────────────────

function openSheet() {
  if (!cur || cur.won) return;
  ui.help.classList.add("open");
  ui.helpBtn.setAttribute("aria-expanded", "true");
  ui.helpGrid.querySelector("button:not([hidden]):not(:disabled)")?.focus({ preventScroll: true });
}

function closeSheet(focus = false) {
  if (!ui) return;
  ui.help.classList.remove("open");
  ui.helpBtn.setAttribute("aria-expanded", "false");
  if (focus) ui.helpBtn.focus({ preventScroll: true });
}

function startPick() {
  cur.picking = true;
  ui.cancel.hidden = false;
  closeSheet();
  say("Tap the clue of a row or a column. Keyboard: R or C at the cursor, Esc to cancel.");
  ui.canvas.focus({ preventScroll: true });
}

function cancelPick(spoken = false) {
  if (!cur?.picking) return;
  cur.picking = false;
  ui.cancel.hidden = true;
  if (spoken) say("Cancelled. Nothing was charged.");
}

// While picking, a tap belongs to the pick and never reaches the board's own handler.
function onPickDown(e) {
  if (!cur?.picking) return;
  e.stopImmediatePropagation();
  e.preventDefault();
  const line = board.lineAt(e.clientX, e.clientY);
  if (line) useHelp("line", line);
  else say("That is not a clue. Tap the numbers beside or above the board.");
}

function onPickKey(e) {
  if (!cur?.picking || e.ctrlKey || e.metaKey || e.altKey) return;
  const k = e.key.toLowerCase();
  if (k !== "r" && k !== "c") return;
  e.preventDefault();
  const { r, c } = board.cursor;
  useHelp("line", k === "r" ? { axis: "row", index: r } : { axis: "col", index: c });
}

function onEscape(e) {
  if (e.key !== "Escape" || !cur || ui.confirm.open) return;
  if (cur.picking) cancelPick(true);
  else if (ui.help.classList.contains("open")) closeSheet(true);
}

// Spend first, then run (docs §6). The price is charged once; a hint that fails to answer is refunded.
async function useHelp(kind, pick = null) {
  const c = cur;
  if (!c || c.won || c.busy) return;
  const info = HELP.find((h) => h.kind === kind);
  const price = PRICES[kind];
  const save = ctx.save;
  if (save.skeins < price) {
    say(`You need ${plural(price, "skein", "skeins")} for ${info.label.toLowerCase()}; you have ${save.skeins}. Solving puzzles earns more.`);
    return;
  }
  if (kind === "line" && !pick) return startPick();
  cancelPick();
  closeSheet();
  spend(save, price, info.stat);
  c.helped = true;
  c.busy = true;
  paintSkeins();
  refresh();
  writeSave(save);
  let result;
  try {
    result = await runHint(kind, { puzzle: c.puzzle, state: board.state, engine: ctx.engine, lastWrong: c.placed, pick });
  } catch (e) {
    save.skeins += price;
    save.stats[info.stat === "hint" ? "hints" : "checks"]--;
    c.busy = false;
    if (cur !== c) return;
    paintSkeins();
    refresh();
    writeSave(save);
    say(`${e.message || "That did not work."} Nothing was charged.`);
    return;
  }
  c.busy = false;
  if (cur !== c || c.won) return;
  c.applying = true;
  if (result.set.length) board.setCells(result.set);
  c.applying = false;
  if (!c.won) {
    board.highlight(result.highlight);
    say(result.message);
    announce(result.message);
    ui.canvas.focus({ preventScroll: true });
  }
  refresh();
  scheduleSave();
}

// ── Restart ────────────────────────────────────────────────────────────────

function askRestart() {
  if (!cur) return;
  closeSheet();
  ui.confirm.showModal();
}

function restart() {
  const c = cur;
  if (!c) return;
  clearTimeout(saveTimer);
  pauseClock();
  clearProgress(ctx.save, c.puzzle.id);
  writeSave(ctx.save);
  load(c.puzzle, c.day);
  say("Started again.");
}

// ── The win ────────────────────────────────────────────────────────────────

async function finish() {
  const c = cur;
  c.won = true;
  pauseClock();
  clearTimeout(saveTimer);
  closeSheet();
  cancelPick();
  const seconds = Math.floor(c.acc);
  const res = recordSolve(ctx.save, { puzzle: c.puzzle, seconds, helped: c.helped, day: c.day, pack: ctx.pack });
  clearProgress(ctx.save, c.puzzle.id);
  writeSave(ctx.save);
  refreshSaveNote();
  paintSkeins();
  refresh();
  ui.bar.hidden = true;
  say("");
  announce("Solved.");
  await board.reveal(c.puzzle.solution, c.puzzle.thread);
  if (cur !== c) return;
  showWin(c, res, seconds);
  for (const id of res.newAch) {
    const a = ACHIEVEMENTS.find((x) => x.id === id);
    toast(`${a?.name ?? id}: achievement earned, +5 skeins.`, 4200);
  }
}

function paintStars() {
  const n = cur?.stars;
  if (n === undefined) return;
  ui.win.querySelector(".pz-stars").textContent = "★".repeat(n) + "☆".repeat(3 - n);
}

function showWin(c, res, seconds) {
  const { puzzle } = c;
  const w = ui.win;
  c.stars = res.stars;
  w.querySelector(".pz-win-name").textContent = puzzle.name || "Untitled";
  w.querySelector(".pz-win-meta").textContent = [tierName(puzzle), `${puzzle.w}×${puzzle.h}`, clock(seconds)].filter(Boolean).join(" · ");
  const stars = w.querySelector(".pz-stars");
  stars.setAttribute("aria-label", `${res.stars} of 3 stars`);
  paintStars();
  const why = w.querySelector(".pz-why");
  const row = (ok, yes, no) => el("li", { className: ok ? "yes" : "no", textContent: (ok ? "✓ " : "– ") + (ok ? yes : no) });
  why.replaceChildren(row(true, "Solved", ""), row(!c.helped, "No help", "Help used"), row(seconds <= c.par, `Within par (${clock(c.par)})`, `Over par (${clock(c.par)})`));
  w.querySelector(".pz-win-skeins").textContent =
    res.earned > 0 ? `+${plural(res.earned, "skein", "skeins")}` : puzzle.kind === "shared" ? "No skeins for a shared puzzle." : "No new skeins this time.";
  const more = [];
  if (res.bonus) more.push(`+${res.bonus} for ${plural(res.newAch.length, "achievement", "achievements")}`);
  if (puzzle.kind === "daily") more.push(`Daily streak: ${plural(ctx.save.daily.streak, "day", "days")}`);
  const next = nextPuzzle(ctx.pack, ctx.save, puzzle.kind === "pack" ? puzzle.id : null);
  c.next = next;
  const nextBtn = w.querySelector('[data-win="next"]');
  nextBtn.hidden = !next;
  nextBtn.onclick = () => next && go(`#play/${next.id}`);
  if (!next) more.push("Every open puzzle is solved. Solve more of a tier to open the next.");
  w.querySelector(".pz-win-more").textContent = more.join(" ");
  w.hidden = false;
  announce(`Solved: ${puzzle.name || "Untitled"}. ${res.stars} of 3 stars. ${res.earned} skeins.`);
  w.focus({ preventScroll: true });
  w.scrollIntoView?.({ block: "nearest" });
}

// A PNG of the finished picture: tiles of the thread colour on --panel, 16 px margin.
function savePicture(puzzle) {
  const cell = Math.max(8, Math.floor(512 / Math.max(puzzle.w, puzzle.h)));
  const margin = 16;
  const cv = document.createElement("canvas");
  cv.width = puzzle.w * cell + 2 * margin;
  cv.height = puzzle.h * cell + 2 * margin;
  const g = cv.getContext("2d");
  g.fillStyle = css("--panel");
  g.fillRect(0, 0, cv.width, cv.height);
  g.fillStyle = css("--t" + puzzle.thread);
  for (let y = 0; y < puzzle.h; y++) for (let x = 0; x < puzzle.w; x++) if (puzzle.solution[y * puzzle.w + x]) g.fillRect(margin + x * cell, margin + y * cell, cell, cell);
  cv.toBlob((blob) => {
    if (!blob) return;
    const a = el("a", { href: URL.createObjectURL(blob), download: `hugi-${puzzle.id}.png` });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }, "image/png");
}

registerScreen("puzzle", { show, hide });
