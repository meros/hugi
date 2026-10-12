// The Play screen: the daily card, the quilt (one patch per puzzle, tier by tier) and the shelf of puzzles
// shared with the player. A solved patch shows its picture, so the list of levels and the collection are one screen.

import { registerScreen, go, ctx, setSkeins, toast } from "./main.js?v=dev";
import { css, tile } from "../draw.js?v=dev";
import { unpackBits } from "../grid.js?v=dev";
import { threadOf } from "./shared.js?v=dev";
import { tierState, dailyFor, dailyOpen } from "./pack.js?v=dev";
import { ACHIEVEMENTS, DAILY_OPENS_AFTER, activeStreak, today } from "./rules.js?v=dev";
import { saveStatus } from "./save.js?v=dev";
import { el, openAchievements, openProgress } from "./dialogs.js?v=dev";

if (!document.querySelector('link[href^="game/quilt.css"]')) {
  document.head.append(el("link", { rel: "stylesheet", href: "game/quilt.css?v=dev" }));
}

const root = document.getElementById("view-play");
const plural = (n, one, many = one + "s") => `${n} ${n === 1 ? one : many}`;
const reduceMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

// --- the pictures on the patches, drawn when they come near the screen (there are up to 210) ---

const pictures = new WeakMap(); // canvas -> {w, h, cells, thread}
const visible = new Set();
let seen = null; // IntersectionObserver
let resized = null; // ResizeObserver

// Draws the picture at a whole number of device pixels per cell, centred, so that 50x50 stays a picture at 56 px.
function paint(canvas) {
  const pic = pictures.get(canvas);
  const box = canvas.clientWidth;
  if (!pic || !box) return;
  const side = Math.round(box * (window.devicePixelRatio || 1));
  const color = css("--t" + pic.thread);
  const key = `${side}|${color}`;
  if (canvas.dataset.key === key) return;
  canvas.dataset.key = key;
  canvas.width = canvas.height = side;
  const cell = Math.max(1, Math.floor(side / Math.max(pic.w, pic.h)));
  const ox = Math.floor((side - cell * pic.w) / 2);
  const oy = Math.floor((side - cell * pic.h) / 2);
  const g = canvas.getContext("2d");
  for (let i = 0; i < pic.cells.length; i++) {
    if (pic.cells[i]) tile(g, ox + (i % pic.w) * cell, oy + Math.floor(i / pic.w) * cell, cell, color);
  }
}

function watch() {
  seen?.disconnect();
  resized?.disconnect();
  visible.clear();
  seen = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (e.isIntersecting) {
          visible.add(e.target);
          paint(e.target);
        } else visible.delete(e.target);
      }
    },
    { rootMargin: "300px" },
  );
  resized = new ResizeObserver(() => visible.forEach(paint));
  resized.observe(root);
  for (const c of root.querySelectorAll("canvas.picture")) seen.observe(c);
}

function pictureCanvas(w, h, cells, thread) {
  const canvas = el("canvas", { className: "picture", "aria-hidden": "true" });
  pictures.set(canvas, { w, h, cells, thread });
  return canvas;
}

// --- parts of the page ---

const starText = (n) => "★".repeat(n) + "☆".repeat(3 - n);

// kind: "blank" | "started" | "solved". `art` is what fills the square, `under` the line below it.
function patch({ hash, kind, label, art, under, fresh = false }) {
  const b = el(
    "button",
    { type: "button", className: `patch ${kind}${fresh ? " fresh" : ""}`, "aria-label": label, "data-go": hash },
    el("span", { className: "art" }, art),
    el("span", { className: "under" }, under),
  );
  return el("li", {}, b);
}

function dailyCard(save, pack) {
  const day = today();
  const { puzzle } = dailyFor(pack, day);
  const tierName = puzzle ? pack.tiers.find((t) => t.id === puzzle.tier)?.name : null;
  const card = el("section", { className: "card q-daily", "aria-labelledby": "q-daily-h" }, el("h2", { id: "q-daily-h" }, "Today’s puzzle"));
  if (!puzzle) {
    card.append(el("p", { className: "muted" }, "There is no daily puzzle in this pack."));
    return card;
  }
  const solvedCount = pack.puzzles.filter((p) => save.solved[p.id]).length;
  const streak = activeStreak(save.daily, day);

  if (!dailyOpen(pack, save)) {
    card.append(
      el("p", { className: "q-lock" }, `Opens when you solve ${DAILY_OPENS_AFTER} puzzles from the quilt (${solvedCount} so far).`),
      el("p", { className: "muted" }, "A new picture every day, and a streak for each day you finish it."),
    );
    return card;
  }
  const solvedToday = save.daily.last === day && save.solved[puzzle.id];
  const streakText = streak
    ? `Streak: ${plural(streak, "day")}.${solvedToday ? "" : " Solve today’s to keep it."}`
    : "No streak yet. Solve today’s to start one.";
  const meta = el("p", { className: "q-meta" }, `${puzzle.w}×${puzzle.h}`, tierName ? ` · ${tierName}` : "");
  const info = el("div", { className: "q-daily-info" }, meta, el("p", { className: "muted" }, streakText));
  if (solvedToday) {
    const art = el("span", { className: "q-thumb" }, pictureCanvas(puzzle.w, puzzle.h, puzzle.solution, puzzle.thread));
    card.append(
      el(
        "div",
        { className: "q-daily-row" },
        art,
        el(
          "div",
          { className: "q-daily-info" },
          el("p", { className: "q-solved" }, "Solved today"),
          el("p", { className: "q-stars", "aria-label": `${save.solved[puzzle.id].stars} of 3 stars` }, starText(save.solved[puzzle.id].stars)),
          meta,
          el("p", { className: "muted" }, streakText),
        ),
      ),
    );
    return card;
  }
  const started = Object.hasOwn(save.progress, puzzle.id);
  card.append(
    info,
    el("button", { type: "button", className: "primary q-play", "data-go": "#daily" }, started ? "Continue" : "Play"),
  );
  return card;
}

function toolbar(save) {
  const earned = ACHIEVEMENTS.filter((a) => save.ach[a.id]).length;
  return el(
    "div",
    { className: "q-tools" },
    el(
      "button",
      { type: "button", id: "q-achievements", onclick: () => openAchievements().then(() => document.getElementById("q-achievements")?.focus()) },
      "Achievements ",
      el("span", { className: "muted" }, `${earned} of ${ACHIEVEMENTS.length}`),
    ),
    el("button", { type: "button", id: "q-progress", onclick: () => openProgress().then(() => document.getElementById("q-progress")?.focus()) }, "Your progress"),
  );
}

function tierSection(pack, save, tier, numbers, justSolved) {
  const state = tierState(pack, save, tier.id);
  const at = pack.tiers.indexOf(tier);
  const done = state.total > 0 && state.solved === state.total;
  const section = el("section", { className: `q-tier${state.open ? "" : " locked"}${done ? " done" : ""}`, "aria-labelledby": "q-h-" + tier.id });
  const blurb = tier.id === "tapestry" && !/large screen/i.test(tier.blurb) ? `${tier.blurb} Best on a large screen.` : tier.blurb;
  section.append(
    el("div", { className: "q-head" }, el("h2", { id: "q-h-" + tier.id }, tier.name), el("span", { className: "q-count" }, `${state.solved} of ${state.total}`)),
    el("p", { className: "q-blurb muted" }, blurb),
  );
  if (!state.open) {
    section.append(el("p", { className: "q-lock" }, `Opens when you solve ${state.need} ${pack.tiers[at - 1].name} puzzles (${state.have} so far).`));
  } else if (done) {
    section.append(el("p", { className: "q-done" }, `A finished quilt: all ${state.total} pictures are yours.`));
  }
  const grid = el("ul", { className: "quilt", inert: !state.open });
  for (const p of pack.puzzles.filter((x) => x.tier === tier.id)) {
    const n = numbers.get(p.id);
    const size = `${p.w}×${p.h}`;
    const hash = "#play/" + encodeURIComponent(p.id);
    const solved = save.solved[p.id];
    if (solved) {
      grid.append(
        patch({
          hash,
          kind: "solved",
          label: `Puzzle ${n}, ${p.name}, ${size}, solved, ${plural(solved.stars, "star")}`,
          art: pictureCanvas(p.w, p.h, p.solution, p.thread),
          under: el("span", { className: "q-stars", "aria-hidden": "true" }, starText(solved.stars)),
          fresh: justSolved.has(p.id),
        }),
      );
    } else {
      const started = Object.hasOwn(save.progress, p.id);
      grid.append(
        patch({
          hash,
          kind: started ? "started" : "blank",
          label: `Puzzle ${n}, ${size}, ${started ? "in progress" : "not started"}`,
          art: [el("span", { className: "num" }, String(n)), el("span", { className: "sz" }, size)],
          under: started ? "started" : "",
        }),
      );
    }
  }
  section.append(grid);
  return section;
}

// A shared puzzle opens through its #solve: link (docs/game-design.md 5b).
function sharedHash(s) {
  const extra = (s.title ? `&t=${encodeURIComponent(s.title)}` : "") + (s.author ? `&a=${encodeURIComponent(s.author)}` : "");
  return `#solve:${s.w}x${s.h}:${s.bits}${extra}`;
}

function shelf(save) {
  const entries = Object.entries(save.shared).sort((a, b) => b[1].at - a[1].at);
  const section = el(
    "section",
    { className: "q-tier q-shelf", "aria-labelledby": "q-h-shared" },
    el("div", { className: "q-head" }, el("h2", { id: "q-h-shared" }, "Shared with me"), entries.length ? el("span", { className: "q-count" }, plural(entries.length, "picture")) : null),
  );
  if (!entries.length) {
    section.append(el("p", { className: "muted" }, "Nothing here yet. When a friend sends you a puzzle link from the Maker, it waits for you here."));
    return section;
  }
  section.append(el("p", { className: "q-blurb muted" }, "Puzzles that people sent you. They earn stars but no skeins."));
  const grid = el("ul", { className: "quilt shelf" });
  for (const [id, s] of entries) {
    const title = s.title || "Untitled";
    const from = s.author ? `from ${s.author}` : "";
    const solved = s.stars > 0;
    // A shared puzzle carries no thread colour: the id picks a steady one.
    const art = solved ? pictureCanvas(s.w, s.h, unpackBits(s.w, s.h, s.bits), threadOf(id)) : [el("span", { className: "sz" }, `${s.w}×${s.h}`)];
    grid.append(
      patch({
        hash: sharedHash(s),
        kind: solved ? "solved" : "blank",
        label: `${title}${from ? ", " + from : ""}, ${s.w}×${s.h}, ${solved ? "solved, " + plural(s.stars, "star") : "not solved"}`,
        art,
        under: [
          solved ? el("span", { className: "q-stars", "aria-hidden": "true" }, starText(s.stars)) : null,
          el("span", { className: "q-title" }, title),
          from ? el("span", { className: "q-from muted" }, from) : null,
        ],
      }),
    );
  }
  section.append(grid);
  return section;
}

// --- the screen ---

let shown = false;
let scrollAt = 0;
let lastSolved = null; // ids solved at the last render, to find what is new
let lastOpen = null; // tier id -> open at the last render

function render({ restore = false } = {}) {
  const { pack, save } = ctx;
  if (!pack || !save) {
    root.replaceChildren(
      el("section", { className: "card q-page" }, el("h2", {}, "The puzzles did not load"), el("p", { className: "muted" }, "Reload the page to try again. The Maker still works.")),
    );
    return;
  }
  setSkeins(save.skeins);
  const solvedIds = new Set(Object.keys(save.solved));
  const justSolved = new Set(lastSolved ? [...solvedIds].filter((id) => !lastSolved.has(id)) : []);
  const numbers = new Map(pack.puzzles.map((p, i) => [p.id, i + 1]));
  const fresh = !pack.puzzles.some((p) => save.solved[p.id] || save.progress[p.id]);
  const note = saveStatus(save).note;

  const page = el(
    "div",
    { className: "q-page" },
    el("div", { className: "q-top" }, dailyCard(save, pack), toolbar(save)),
    note && el("p", { className: "q-note", role: "status" }, note),
    fresh && el("p", { className: "q-prompt" }, "New here? Pick any patch in Tabby to begin. Each picture you finish is stitched into your quilt."),
  );
  const open = new Map();
  for (const tier of pack.tiers) {
    page.append(tierSection(pack, save, tier, numbers, justSolved));
    open.set(tier.id, tierState(pack, save, tier.id).open);
  }
  page.append(shelf(save));
  if (pack.credits) page.append(el("p", { className: "q-credits muted" }, pack.credits));
  root.replaceChildren(page);
  watch();

  // Back from a puzzle: say what opened, and bring the new picture into view.
  if (lastOpen) {
    for (const tier of pack.tiers) if (open.get(tier.id) && !lastOpen.get(tier.id)) toast(`${tier.name} is open.`);
  }
  const target = [...justSolved][0] && root.querySelector(".patch.fresh");
  if (target) target.scrollIntoView({ block: "center", behavior: reduceMotion() ? "instant" : "smooth" });
  else if (restore) scrollTo(0, scrollAt);
  lastSolved = solvedIds;
  lastOpen = open;
}

root.addEventListener("click", (e) => {
  const target = e.target.closest("[data-go]");
  if (target) go(target.dataset.go);
});

// The theme changes the thread colours: draw the pictures on screen again.
document.addEventListener("hugi:theme", () => {
  if (document.body.dataset.view === "play") visible.forEach(paint);
});
// A load or an erase in the dialogs, or another tab writing the save.
document.addEventListener("hugi:save", () => document.body.dataset.view === "play" && render());

registerScreen("play", {
  show() {
    render({ restore: shown });
    shown = true;
  },
  hide() {
    scrollAt = window.scrollY;
    seen?.disconnect();
    visible.clear();
  },
});
