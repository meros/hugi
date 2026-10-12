// Helpers for the real page (index.html): open it with a hash, wait for the solver, read the Maker.
import { expect } from "@playwright/test";

/** Seed localStorage before the page scripts run, once per tab (a reload keeps what the page wrote). */
export async function seedStorage(page, entries) {
  await page.addInitScript((items) => {
    try {
      if (sessionStorage.getItem("e2e-seeded")) return;
      sessionStorage.setItem("e2e-seeded", "1");
      for (const [k, v] of Object.entries(items)) localStorage.setItem(k, typeof v === "string" ? v : JSON.stringify(v));
    } catch {}
  }, entries);
}

/** A save for localStorage["hugi-game"] (docs/game-design.md section 4). Pass overrides. */
export const gameSave = (over = {}) => ({
  v: 1,
  skeins: 5,
  solved: {},
  progress: {},
  daily: { last: null, streak: 0, best: 0 },
  ach: {},
  stats: { parStars: 0, threeStars: 0, hints: 0, checks: 0 },
  shared: {},
  settings: {},
  ...over,
});

export const seedGameSave = (page, over) => seedStorage(page, { "hugi-game": gameSave(over) });

/** Open the app at a hash ("" is the front door) and wait until the router has chosen a view. */
export async function openApp(page, hash = "", { theme } = {}) {
  if (theme) await seedStorage(page, { "hugi-theme": theme });
  await page.goto("/index.html" + hash);
  await expect(page.locator("body")).toHaveAttribute("data-view", /.+/);
}

/** Open the Maker and wait until the solver has given a verdict (not Loading, Solving or Draw). */
export async function openMaker(page, hash = "#make", opts) {
  await openApp(page, hash, opts);
  await expect(page.locator("body")).toHaveAttribute("data-view", "make");
  await solverReady(page);
}

export async function solverReady(page) {
  await expect(page.locator("#verdict")).not.toHaveText(/^(Loading the solver|Solving)/, { timeout: 20_000 });
}

export const verdict = (page) => page.locator("#verdict");

/** The Maker's picture as rows of # and . read from the share hash. */
export async function makerHash(page) {
  return page.evaluate(() => location.hash);
}

/** The Maker keeps its grid geometry private. It follows from the canvas size: the canvas is
 *  left + w*cell + 2 wide and top + h*cell + 2 high, with cell = clamp(floor(avail / (w + rmax*0.9)), 6, 30),
 *  left = ceil(rmax*cell*0.9) + 4 and top = ceil(cmax*cell*0.9) + 4 (app.js, draw()). Search for the
 *  (cell, rmax, cmax) that fits all of it. */
export async function makerGeometry(page) {
  return page.evaluate(() => {
    const c = document.getElementById("board");
    const r = c.getBoundingClientRect();
    const w = +document.getElementById("w").value;
    const h = +document.getElementById("h").value;
    const avail = Math.max(220, c.parentElement.clientWidth - 28);
    const cw = Math.round(r.width);
    const ch = Math.round(r.height);
    for (let rmax = 1; rmax <= 60; rmax++) {
      const cell = Math.max(6, Math.min(30, Math.floor(avail / (w + rmax * 0.9))));
      const left = Math.ceil(rmax * cell * 0.9) + 4;
      if (left + w * cell + 2 !== cw) continue;
      for (let cmax = 1; cmax <= 60; cmax++) {
        const top = Math.ceil(cmax * cell * 0.9) + 4;
        if (top + h * cell + 2 === ch) return { x: r.left, y: r.top, left, top, cell, w, h };
      }
    }
    throw new Error("cannot derive the Maker geometry from a canvas of " + cw + "x" + ch);
  });
}

/** The client point at the centre of the Maker's cell (x, y). */
export async function makerCell(page, x, y, geom = null) {
  const g = geom ?? (await makerGeometry(page));
  return { x: g.x + g.left + (x + 0.5) * g.cell, y: g.y + g.top + (y + 0.5) * g.cell };
}

/** The Maker's picture as rows of "#" and "." decoded from the share hash with the page's own grid.js. */
export function pictureOf(page) {
  return page.evaluate(async () => {
    const { unpackBits } = await import("/grid.js?v=dev");
    const m = /^#(\d+)x(\d+):([\w-]*)$/.exec(location.hash);
    if (!m) return null;
    const [w, h] = [+m[1], +m[2]];
    const cells = unpackBits(w, h, m[3]);
    return Array.from({ length: h }, (_, y) => Array.from({ length: w }, (_, x) => (cells[y * w + x] ? "#" : ".")).join(""));
  });
}
