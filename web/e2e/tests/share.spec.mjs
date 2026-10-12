// Share to solve (WP9, docs/game-design.md 5b): the Maker's Share… dialog, the #solve: link, the puzzle
// screen for a shared puzzle (clues only, title and author as text), several-solutions mode, 0 skeins,
// and the Shared with me shelf. Small pictures keep the solving by tap short.
import { test, expect } from "../helpers/fixtures.mjs";
import { openApp, openMaker, solverReady } from "../helpers/app.mjs";
import { pointer } from "../helpers/input.mjs";
import { expectNoHorizontalScroll, smallTargets } from "../helpers/layout.mjs";

const PLUS3 = "#3x3:ugA"; // .#. / ### / .#. : unique
const DIAG2 = "#solve:2x2:CQ&t=Pair&a=Ann"; // # . / . # : two solutions

/** The puzzle on screen from its own solve hash: {w, h, solution, rows, cols}. */
const puzzleOf = (page, hash) =>
  page.evaluate(async (hash) => {
    const { parseSolveLink } = await import("/game/shared.js?v=dev");
    const { cluesOf } = await import("/grid.js?v=dev");
    const p = parseSolveLink(hash);
    return { w: p.w, h: p.h, solution: Array.from(p.cells), ...cluesOf(p.w, p.h, p.cells) };
  }, hash);

/** Where the cells are, derived from the canvas size as in puzzle.spec.mjs. */
async function geometry(page, p) {
  const box = await page.evaluate(() => {
    const c = document.querySelector(".pz-canvas");
    return { w: c.offsetWidth, h: c.offsetHeight };
  });
  const rmax = Math.max(1, ...p.rows.map((c) => c.length || 1));
  const cmax = Math.max(1, ...p.cols.map((c) => c.length || 1));
  for (let cell = 6; cell <= 56; cell++) {
    const left = Math.ceil(rmax * cell * 0.9) + 4;
    const top = Math.ceil(cmax * cell * 0.9) + 4;
    if (left + p.w * cell + 2 === box.w && top + p.h * cell + 2 === box.h) return { left, top, cell };
  }
  throw new Error(`no cell size fits a canvas of ${box.w}x${box.h}`);
}

async function cellPoint(page, p, r, c) {
  const g = await geometry(page, p);
  const box = await page.locator(".pz-canvas").boundingBox();
  return { x: box.x + g.left + (c + 0.5) * g.cell, y: box.y + g.top + (r + 0.5) * g.cell };
}

/** The number of filled cells, read from the pixels at the cell centres. */
async function filled(page, p) {
  const g = await geometry(page, p);
  return page.evaluate(
    ([p, g]) => {
      const c = document.querySelector(".pz-canvas");
      const dpr = c.width / c.offsetWidth;
      const ctx = c.getContext("2d");
      let n = 0;
      for (let r = 0; r < p.h; r++)
        for (let k = 0; k < p.w; k++) {
          const d = ctx.getImageData(Math.round((g.left + (k + 0.5) * g.cell) * dpr), Math.round((g.top + (r + 0.5) * g.cell) * dpr), 1, 1).data;
          if (d[3] > 200 && d[0] + d[1] + d[2] < 450) n++;
        }
      return n;
    },
    [p, g],
  );
}

const solveCells = async (page, dev, p, picture) => {
  for (let r = 0; r < p.h; r++) for (let c = 0; c < p.w; c++) if (picture[r * p.w + c]) await dev.tap(await cellPoint(page, p, r, c));
};

const saved = (page) => page.evaluate(() => JSON.parse(localStorage.getItem("hugi-game")));
const hashOf = (page) => page.evaluate(() => location.hash);

/** A second browser context with the same device settings and an empty storage. */
async function freshPage(browser, testInfo) {
  const { viewport, hasTouch, isMobile, deviceScaleFactor, baseURL } = testInfo.project.use;
  const context = await browser.newContext({ viewport, hasTouch, isMobile, deviceScaleFactor, baseURL });
  return { context, page: await context.newPage() };
}

test.describe("the Share… dialog", () => {
  test("a unique picture gives a link to solve with the title and the name; the name is remembered", async ({ page, context }, testInfo) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await openMaker(page, PLUS3);
    await expect(page.locator("#verdict")).toHaveText("Unique solution");
    await page.locator("#share").click();
    const dialog = page.getByRole("dialog", { name: "Share this picture" });
    await expect(dialog).toBeVisible();
    await expect(page.locator("#share-state")).toContainText("Unique solution");
    await expect(page.locator("#share-solve-link")).toBeEnabled();
    await expect(page.locator("#share-solve-link")).toBeFocused(); // the main action, not a text field
    await expect(page.locator("#share-make-unique-row")).toBeHidden();
    await page.locator("#share-title").fill("Plus & <b>more</b> #1");
    await page.locator("#share-author").fill("Åsa");
    await page.locator("#share-solve-link").click();
    await expect(page.locator("#share-solve-link")).toHaveText("Copied");
    const link = await page.locator("#share-out").inputValue();
    expect(link).toBe(new URL("/index.html#solve:3x3:ugA&t=Plus%20%26%20%3Cb%3Emore%3C%2Fb%3E%20%231&a=%C3%85sa", page.url()).href);
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(link);
    await expect(page.locator("#share-solve-link")).toHaveText("Link to solve");
    if (testInfo.project.use.hasTouch) expect(await smallTargets(page, 44, { scope: "#share-dialog" })).toEqual([]);
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(page.locator("#share")).toBeFocused();
    expect(await page.evaluate(() => localStorage.getItem("hugi-author"))).toBe("Åsa");
    await page.locator("#share").click();
    await expect(page.locator("#share-author")).toHaveValue("Åsa");
    await expect(page.locator("#share-title")).toHaveValue("Plus & <b>more</b> #1"); // same picture: the title stays
    await page.keyboard.press("Escape");
    await page.locator("#examples").selectOption("heart");
    await solverReady(page);
    await page.locator("#share").click();
    await expect(page.locator("#share-title")).toHaveValue(""); // another picture starts untitled
    await expectNoHorizontalScroll(page);
  });

  test("a picture with several solutions cannot produce a link to solve and points to Make unique", async ({ page }) => {
    await openMaker(page, "#make");
    await page.locator("#examples").selectOption("rings");
    await expect(page.locator("#verdict")).toHaveText(/More than one solution/, { timeout: 20_000 });
    await page.locator("#share").click();
    await expect(page.locator("#share-state")).toContainText("more than one solution. Use Make unique first, or share it to edit.");
    await expect(page.locator("#share-solve-link")).toBeDisabled();
    await expect(page.locator("#share-try")).toBeDisabled();
    await expect(page.locator("#share-edit-link")).toBeEnabled(); // sharing it to edit stays possible
    await expect(page.locator("#share-make-unique")).toBeVisible();
    await page.locator("#share-make-unique").click();
    await expect(page.getByRole("dialog")).toBeHidden();
    await expect(page.locator("#verdict")).toHaveText(/Making it unique|Unique solution|Still ambiguous/, { timeout: 30_000 });
  });

  test("Solve it yourself opens the solve link in this tab", async ({ page }) => {
    await openMaker(page, PLUS3);
    await page.locator("#share").click();
    await page.locator("#share-title").fill("Mine");
    await page.locator("#share-try").click();
    await expect(page.locator("body")).toHaveAttribute("data-view", "puzzle");
    expect(await hashOf(page)).toBe("#solve:3x3:ugA&t=Mine");
    await expect(page.locator(".pz-title")).toContainText("Mine · 3×3");
  });
});

test.describe("a shared puzzle", () => {
  test("the link from the Maker opens in a fresh context with clues only; solving pays 0 skeins and fills the shelf", async ({ page, browser }, testInfo) => {
    await openMaker(page, PLUS3);
    await page.locator("#share").click();
    await page.locator("#share-title").fill("Plus");
    await page.locator("#share-author").fill("Åsa");
    await page.locator("#share-solve-link").click();
    const link = await page.locator("#share-out").inputValue();
    expect(link).toContain("#solve:3x3:ugA");

    const { context, page: other } = await freshPage(browser, testInfo);
    try {
      const dev = pointer(other, testInfo);
      await other.goto(link);
      await expect(other.locator(".pz-title")).toContainText("Plus · 3×3");
      await expect(other.locator(".pz-note").first()).toHaveText("From Åsa.");
      await expect(other.locator("#view-puzzle")).not.toContainText("Shared picture");
      const p = await puzzleOf(other, new URL(link).hash);
      expect(await filled(other, p)).toBe(0); // clues only, no picture
      await expect(other.locator(".pz-win")).toBeHidden();
      await expect(other.locator("#skeins")).toHaveText("5");
      await expectNoHorizontalScroll(other);

      await solveCells(other, dev, p, p.solution);
      await expect(other.locator(".pz-win")).toBeVisible();
      await expect(other.locator(".pz-win-name")).toHaveText("Plus");
      await expect(other.locator(".pz-win-skeins")).toContainText("0 skeins earned");
      await expect(other.locator("#skeins")).toHaveText("15"); // 5 + First stitch 5 + A gift 5; nothing for the puzzle
      const s = await saved(other);
      expect(Object.keys(s.solved)).toEqual([]);
      const [entry] = Object.values(s.shared);
      expect(entry).toMatchObject({ w: 3, h: 3, title: "Plus", author: "Åsa", unique: true });
      expect(entry.stars).toBeGreaterThanOrEqual(1);
      expect(Object.keys(s.ach).sort()).toEqual(["first", "own"]);

      await other.locator('[data-win="quilt"]').click();
      const shelf = other.locator(".q-shelf");
      await expect(shelf.locator(".patch")).toHaveCount(1);
      await expect(shelf).toContainText("Plus");
      await expect(shelf).toContainText("from Åsa");
      await expect(shelf.locator(".patch.solved")).toHaveCount(1);
      await expect(other.locator(".q-tier:not(.q-shelf)").first().locator(".q-count")).toHaveText(/^0 of/); // no tier counts it
      await shelf.locator(".patch").click(); // reopens the link; the stars stay
      await expect(other.locator(".pz-title")).toContainText("Plus · 3×3");
    } finally {
      await context.close();
    }
  });

  test("the achievement A gift pays once", async ({ page }, testInfo) => {
    const dev = pointer(page, testInfo);
    const hash = "#solve:3x3:ugA&t=One";
    await page.goto("/index.html" + hash);
    await expect(page.locator(".pz-title")).toContainText("One");
    const p = await puzzleOf(page, hash);
    await solveCells(page, dev, p, p.solution);
    await expect(page.locator(".pz-win")).toBeVisible();
    await expect(page.locator("#skeins")).toHaveText("15");
    // A second shared puzzle: stars come, the achievements and skeins do not.
    const block = "#solve:3x3:_wE&t=Block"; // all nine cells
    await page.goto("/index.html" + block);
    await expect(page.locator(".pz-title")).toContainText("Block");
    const q = await puzzleOf(page, block);
    await solveCells(page, dev, q, q.solution);
    await expect(page.locator(".pz-win")).toBeVisible();
    await expect(page.locator("#skeins")).toHaveText("15");
    expect(Object.keys((await saved(page)).shared)).toHaveLength(2);
  });

  test("a hand-made link with several solutions plays in several-solutions mode", async ({ page }, testInfo) => {
    const dev = pointer(page, testInfo);
    await page.goto("/index.html" + DIAG2);
    await expect(page.locator(".pz-note.pz-strong")).toHaveText("This puzzle has more than one solution. Any picture that fits every clue counts.");
    await expect(page.locator(".pz-title")).toContainText("Pair · 2×2");
    // The checks that need one right picture are gone; the hints stay.
    if (!(await page.locator(".pz-help").isVisible())) await page.locator(".pz-helpbtn").click();
    await expect(page.getByRole("button", { name: /^On track\?/ })).toBeHidden();
    await expect(page.getByRole("button", { name: /^Show mistakes/ })).toBeHidden();
    await expect(page.getByRole("button", { name: /^Reveal a line/ })).toBeHidden();
    await expect(page.getByRole("button", { name: /^Nudge/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /^Show a cell/ })).toBeVisible();
    await page.keyboard.press("Escape");
    // The other diagonal is not the picture in the link, and it wins.
    const p = await puzzleOf(page, DIAG2);
    await solveCells(page, dev, p, [0, 1, 1, 0]);
    await expect(page.locator(".pz-win")).toBeVisible();
    await expect(page.locator(".pz-win-skeins")).toContainText("0 skeins earned");
    const id = await page.evaluate(async () => (await import("/game/shared.js?v=dev")).sharedId(2, 2, "CQ"));
    expect((await saved(page)).shared[id]).toMatchObject({ unique: false, title: "Pair", author: "Ann" });
  });

  test("the Rings example as a hand-made link opens with the note", async ({ page }) => {
    await openMaker(page, "#make");
    await page.locator("#examples").selectOption("rings");
    await expect(page.locator("#verdict")).toHaveText(/More than one solution/, { timeout: 20_000 });
    const rings = (await hashOf(page)).replace("#", "#solve:");
    await page.goto("/index.html" + rings);
    await expect(page.locator(".pz-note.pz-strong")).toContainText("more than one solution", { timeout: 20_000 });
    await expect(page.locator(".pz-canvas")).toBeVisible();
  });

  test("a hostile title and a 5000 character name render as cut text", async ({ page }) => {
    const evil = '<img src=x onerror="window.__pwned=1">';
    await page.goto(`/index.html#solve:3x3:ugA&t=${encodeURIComponent(evil + "x".repeat(5000))}&a=${"y".repeat(5000)}`);
    await expect(page.locator(".pz-title")).toContainText(evil);
    const title = await page.locator(".pz-title").textContent();
    expect(title.startsWith(evil + "xx · 3×3")).toBe(true); // cut to 40 characters
    await expect(page.locator(".pz-note").first()).toHaveText("From " + "y".repeat(40) + ".");
    expect(await page.locator("#view-puzzle img").count()).toBe(0);
    expect(await page.evaluate(() => window.__pwned)).toBeUndefined();
    await expectNoHorizontalScroll(page);
  });

  test("garbage after #solve: shows the card, with a way out", async ({ page }) => {
    for (const bad of ["#solve:", "#solve:abc", "#solve:3x3:ug", "#solve:3x3:ugA&t=%E0%A4%A", "#solve:0x3:AAAA"]) {
      await page.goto("/index.html" + bad);
      await page.reload();
      await expect(page.getByRole("heading", { name: "This link does not hold a puzzle" })).toBeVisible();
    }
    await page.locator(".pz-card").getByRole("button", { name: "Play" }).click();
    await expect(page.locator("body")).toHaveAttribute("data-view", "play");
  });
});

test.describe("old links", () => {
  test("#WxH:bits and #make still open the Maker", async ({ page }) => {
    await openApp(page, PLUS3);
    await expect(page.locator("body")).toHaveAttribute("data-view", "make");
    await solverReady(page);
    await expect(page.locator("#verdict")).toHaveText("Unique solution");
    await openApp(page, "#make");
    await expect(page.locator("body")).toHaveAttribute("data-view", "make");
  });
});
