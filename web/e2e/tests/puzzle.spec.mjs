// The puzzle screen (web/game/play.js): drawing, hints and checks with their prices, the win, resume,
// restart, the daily route, and the phone layout. Pack puzzles come from test/fixtures/pack-small.json
// (cup-5 is a 5x5), the layout tests use the shipped pack.json. The board is read from its pixels and the
// save, because the Board object is private to the module.
import { test, expect } from "../helpers/fixtures.mjs";
import { seedGameSave } from "../helpers/app.mjs";
import { themeColour } from "../helpers/board.mjs";
import { pointer, line, touchDrag } from "../helpers/input.mjs";
import { expectNoHorizontalScroll, smallTargets } from "../helpers/layout.mjs";

const PACK = "test/fixtures/pack-small.json";
const FIVE = ["cup-5", "heart-5", "tree-5", "boat-6", "moon-6"]; // solved: opens the daily

/** Open a pack puzzle of the fixture pack (or the shipped pack with pack = null). */
async function openPuzzle(page, id = "cup-5", { pack = PACK, theme } = {}) {
  await page.emulateMedia({ reducedMotion: "reduce" });
  if (theme) await page.addInitScript((t) => localStorage.setItem("hugi-theme", t), theme);
  await page.goto(`/index.html${pack ? `?pack=${pack}` : ""}#play/${id}`);
  await expect(page.locator(".pz-title")).toHaveText(/·/);
}

/** The puzzle of the fixture pack: {w, h, solution, rows, cols}. */
const puzzleOf = (page, id = "cup-5") =>
  page.evaluate(
    async ([id, pack]) => {
      const json = await (await fetch("/" + pack)).json();
      const { unpackBits, cluesOf } = await import("/grid.js?v=dev");
      const p = json.puzzles.find((x) => x.id === id);
      const solution = unpackBits(p.w, p.h, p.bits);
      return { w: p.w, h: p.h, solution: Array.from(solution), ...cluesOf(p.w, p.h, solution) };
    },
    [id, PACK],
  );

/** Where the cells are: the canvas size follows from the cell size (board.js boardLayout), so search for it. */
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

/** The client point of a cell centre, or of a clue: (r, -1) is the clue of row r, (-1, c) of column c. */
async function point(page, p, r, c) {
  const g = await geometry(page, p);
  const box = await page.locator(".pz-canvas").boundingBox();
  const x = c < 0 ? g.left / 2 : g.left + (c + 0.5) * g.cell;
  const y = r < 0 ? g.top / 2 : g.top + (r + 0.5) * g.cell;
  return { x: box.x + x, y: box.y + y };
}

/** The board as rows of 0 empty, 1 filled, 2 marked, from the pixel at each cell centre. */
async function board(page, p) {
  const g = await geometry(page, p);
  const [ink, muted] = await Promise.all([themeColour(page, "--t5"), themeColour(page, "--muted")]);
  return page.evaluate(
    ([p, g, ink, muted]) => {
      const c = document.querySelector(".pz-canvas");
      const dpr = c.width / c.offsetWidth;
      const ctx = c.getContext("2d");
      const near = (d, rgb) => Math.abs(d[0] - rgb[0]) + Math.abs(d[1] - rgb[1]) + Math.abs(d[2] - rgb[2]) < 60;
      return Array.from({ length: p.h }, (_, r) =>
        Array.from({ length: p.w }, (_, k) => {
          const d = ctx.getImageData(Math.round((g.left + (k + 0.5) * g.cell) * dpr), Math.round((g.top + (r + 0.5) * g.cell) * dpr), 1, 1).data;
          if (d[3] < 200) return 0;
          return near(d, ink) ? 1 : near(d, muted) ? 2 : 0;
        }),
      );
    },
    [p, g, ink, muted],
  );
}

const countOf = (rows, v) => rows.flat().filter((x) => x === v).length;
const readSave = (page) => page.evaluate(() => JSON.parse(localStorage.getItem("hugi-game")) ?? { progress: {}, solved: {}, stats: {} });
const skeins = async (page) => Number(await page.locator("#skeins").textContent());
const clockText = (page) => page.locator(".pz-clock").textContent();

/** Open the Help sheet on a phone (the panel shows Help at once on a wide screen) and press a button. */
async function help(page, name) {
  if (!(await page.locator(".pz-help").isVisible())) await page.locator(".pz-helpbtn").click();
  await page.getByRole("button", { name }).click();
}

/** Wait until a started hint is done: the buttons are enabled again, or the board was won. */
const settled = (page) =>
  page.waitForFunction(() => !document.querySelector(".pz-hbtn").disabled || !document.querySelector(".pz-win").hidden);

/** A tap or click on a cell. */
const tapCell = async (dev, page, p, r, c) => dev.tap(await point(page, p, r, c));

test.describe("puzzle screen", () => {
  test("opens a pack puzzle: title without the name, timer, par, tools, no sideways scroll", async ({ page }, testInfo) => {
    await openPuzzle(page);
    await expect(page.locator(".pz-title")).toHaveText("Puzzle 1 · 5×5 · Tabby");
    await expect(page.locator(".pz-clock")).toHaveText("0:00");
    await expect(page.locator(".pz-par")).toContainText("par 1:00");
    await expect(page.locator(".pz-canvas")).toBeVisible();
    await expect(page.locator("#view-puzzle")).not.toContainText("Cup"); // the picture's name stays hidden
    await expect(page.locator(".pz-note")).toContainText("Each number is a run of filled cells"); // the coach note
    await expect(page.getByRole("button", { name: "Fill" })).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator('[data-tool="move"]')).toBeHidden(); // the board fits its frame
    await expect(page.getByRole("button", { name: "Undo" })).toBeDisabled();
    await expectNoHorizontalScroll(page);
    if (testInfo.project.use.hasTouch) await expect(page.locator(".pz-bar")).toBeInViewport(); // the sticky bar is in reach
  });

  test("a locked puzzle, an unknown id and a link that holds no puzzle show a card with a way out", async ({ page }) => {
    await page.goto(`/index.html?pack=${PACK}#play/boat-6`);
    await expect(page.getByRole("heading", { name: "This puzzle is locked" })).toBeVisible();
    await expect(page.locator(".pz-card")).toContainText("Opens when you solve 2 Tabby puzzles (0 so far).");
    await page.goto(`/index.html?pack=${PACK}#play/nope-9`);
    await expect(page.getByRole("heading", { name: "There is no such puzzle" })).toBeVisible();
    await page.goto(`/index.html?pack=${PACK}#solve:5x5:xH1HAA`);
    await expect(page.getByRole("heading", { name: "This link does not hold a puzzle" })).toBeVisible();
    await page.locator(".pz-card").getByRole("button", { name: "Play" }).click();
    await expect(page.locator("body")).toHaveAttribute("data-view", "play");
  });

  test("a tap fills a cell, a second tap clears it, Mark puts a dot", async ({ page }, testInfo) => {
    const dev = pointer(page, testInfo);
    await openPuzzle(page);
    const p = await puzzleOf(page);
    await tapCell(dev, page, p, 1, 2);
    expect((await board(page, p))[1][2]).toBe(1);
    await tapCell(dev, page, p, 1, 2);
    expect((await board(page, p))[1][2]).toBe(0);
    await page.getByRole("button", { name: "Mark" }).click();
    await expect(page.getByRole("button", { name: "Mark" })).toHaveAttribute("aria-pressed", "true");
    await tapCell(dev, page, p, 3, 3);
    expect((await board(page, p))[3][3]).toBe(2);
  });

  test("the stroke rule: a fill drag locks to its row and never overwrites a mark", async ({ page }, testInfo) => {
    const dev = pointer(page, testInfo);
    await openPuzzle(page);
    const p = await puzzleOf(page);
    await page.getByRole("button", { name: "Mark" }).click();
    await tapCell(dev, page, p, 2, 2);
    await page.getByRole("button", { name: "Fill" }).click();
    const a = await point(page, p, 2, 0);
    const b = await point(page, p, 2, 4);
    const off = await point(page, p, 4, 4); // two rows off: the row axis is longer, so the row stays locked
    await dev.drag([a, ...line(a, b, 6).slice(1), off]);
    expect((await board(page, p))[2]).toEqual([1, 1, 2, 1, 1]);
    expect(countOf(await board(page, p), 1)).toBe(4);
  });

  test("undo and redo by button, and Undo is disabled when there is nothing to undo", async ({ page }, testInfo) => {
    const dev = pointer(page, testInfo);
    await openPuzzle(page);
    const p = await puzzleOf(page);
    const undo = page.getByRole("button", { name: "Undo" });
    const redo = page.getByRole("button", { name: "Redo" });
    await tapCell(dev, page, p, 0, 0);
    await dev.drag(line(await point(page, p, 1, 0), await point(page, p, 1, 3), 4));
    expect(countOf(await board(page, p), 1)).toBe(5);
    await expect(undo).toBeEnabled();
    await undo.click(); // the drag is one step
    expect(countOf(await board(page, p), 1)).toBe(1);
    await expect(redo).toBeEnabled();
    await undo.click();
    await expect(undo).toBeDisabled();
    await redo.click();
    await redo.click();
    expect(countOf(await board(page, p), 1)).toBe(5);
    await expect(redo).toBeDisabled();
  });

  test("keyboard: arrows, Space and X play, and the cursor cell is announced", async ({ page }) => {
    await openPuzzle(page);
    const p = await puzzleOf(page);
    await page.locator(".pz-canvas").focus();
    await page.keyboard.press("ArrowDown");
    await expect(page.locator(".pz-sr")).toContainText("Row 2, column 1, empty. Row clue");
    await page.keyboard.press("Space");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("x");
    expect((await board(page, p)).slice(1, 2)[0].slice(0, 2)).toEqual([1, 2]);
    await page.keyboard.press("z");
    expect((await board(page, p))[1][1]).toBe(0);
  });

  test("a row that cannot fit its clue turns its clue --bad, for free", async ({ page }, testInfo) => {
    const dev = pointer(page, testInfo);
    await openPuzzle(page);
    const p = await puzzleOf(page);
    const bad = await themeColour(page, "--bad");
    const badPixels = () =>
      page.evaluate((bad) => {
        const c = document.querySelector(".pz-canvas");
        const dpr = c.width / c.offsetWidth;
        const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
        let n = 0;
        for (let i = 0; i < d.length; i += 4) {
          if (d[i + 3] > 200 && Math.abs(d[i] - bad[0]) < 30 && Math.abs(d[i + 1] - bad[1]) < 30 && Math.abs(d[i + 2] - bad[2]) < 30) n++;
        }
        return n;
      }, bad);
    expect(await badPixels()).toBe(0);
    const before = await skeins(page);
    const row = p.rows.findIndex((c) => !(c.length === 1 && c[0] === p.w)); // a row that is not full
    const a = await point(page, p, row, 0);
    const b = await point(page, p, row, p.w - 1);
    await dev.drag(line(a, b, 6)); // fill the whole row: impossible unless its clue is the full width
    await expect.poll(badPixels).toBeGreaterThan(0);
    expect(await skeins(page)).toBe(before); // no skeins were spent
  });

  test("Nudge, Show a cell, On track? and Show mistakes cost their price once and update the balance", async ({ page }, testInfo) => {
    const dev = pointer(page, testInfo);
    await seedGameSave(page, { skeins: 20 });
    await openPuzzle(page);
    const p = await puzzleOf(page);
    await expect(page.locator("#skeins")).toHaveText("20");

    await help(page, /^Nudge/);
    await expect(page.locator("#skeins")).toHaveText("19");
    await expect(page.locator(".pz-msg")).toContainText(/has a sure move|this cell/i);
    await settled(page);

    await help(page, /^Show a cell/);
    await expect(page.locator("#skeins")).toHaveText("17");
    await expect(page.locator(".pz-msg")).toContainText(/decides this cell|Filled, this cell|Empty, this cell/);
    await settled(page);
    expect(await skeins(page)).toBe(17);
    const placed = (await board(page, p)).flat().filter(Boolean).length;
    expect(placed).toBeGreaterThanOrEqual(1); // the hint set a cell

    // A wrong cell: the first cell that is empty in the solution.
    const k = p.solution.findIndex((v) => !v && !(placed && false));
    const [r, c] = [Math.floor(k / p.w), k % p.w];
    if ((await board(page, p))[r][c] === 0) await tapCell(dev, page, p, r, c);
    await help(page, /^On track/);
    await expect(page.locator("#skeins")).toHaveText("16");
    await expect(page.locator(".pz-msg")).toHaveText("No: something you placed is wrong.");
    await settled(page);
    await help(page, /^Show mistakes/);
    await expect(page.locator("#skeins")).toHaveText("13");
    await expect(page.locator(".pz-msg")).toHaveText(/^1 cell is wrong\.$/);
    await settled(page);

    const save = await readSave(page);
    expect(save.skeins).toBe(13);
    expect(save.stats).toMatchObject({ hints: 2, checks: 2 });
    // With a wrong cell on the board, a hint points at it first.
    await help(page, /^Nudge/);
    await expect(page.locator(".pz-msg")).toHaveText("This cell is wrong.");
    await expect(page.locator("#skeins")).toHaveText("12");
  });

  test("Reveal a line: pick a clue, the line is set, 5 skeins are charged once", async ({ page }, testInfo) => {
    const dev = pointer(page, testInfo);
    await seedGameSave(page, { skeins: 20 });
    await openPuzzle(page);
    const p = await puzzleOf(page);
    await help(page, /^Reveal a line/);
    await expect(page.locator("#skeins")).toHaveText("20"); // pick mode first: nothing charged yet
    await expect(page.locator(".pz-msg")).toContainText("Tap the clue of a row");
    await tapCell(dev, page, p, 2, 2); // a cell, not a clue: the board does not take it
    expect(countOf(await board(page, p), 1)).toBe(0);
    await dev.tap(await point(page, p, 2, -1)); // the clue of row 3
    await expect(page.locator("#skeins")).toHaveText("15");
    await expect(page.locator(".pz-msg")).toHaveText("Row 3 is set.");
    await settled(page);
    const rows = await board(page, p);
    expect(rows[2].map((v) => (v === 1 ? 1 : 0))).toEqual(p.solution.slice(2 * p.w, 3 * p.w));
    expect(rows[2].every((v) => v !== 0)).toBe(true); // filled or marked, every cell
    expect(await skeins(page)).toBe(15);
  });

  test("Escape leaves pick mode without a charge", async ({ page }) => {
    await seedGameSave(page, { skeins: 20 });
    await openPuzzle(page);
    await help(page, /^Reveal a line/);
    await page.keyboard.press("Escape");
    await expect(page.locator(".pz-msg")).toContainText("Cancelled");
    await expect(page.locator("#skeins")).toHaveText("20");
  });

  test("too few skeins: the button is disabled with a title, a click says why, nothing is charged", async ({ page }) => {
    await seedGameSave(page, { skeins: 2 });
    await openPuzzle(page);
    if (!(await page.locator(".pz-help").isVisible())) await page.locator(".pz-helpbtn").click();
    const mistakes = page.getByRole("button", { name: /^Show mistakes/ });
    await expect(mistakes).toBeDisabled(); // aria-disabled counts
    await expect(mistakes).toHaveAttribute("title", "You need 3 skeins; you have 2.");
    await expect(page.getByRole("button", { name: /^Reveal a line/ })).toHaveAttribute("title", /You need 5 skeins/);
    await mistakes.click({ force: true });
    await expect(page.locator(".pz-msg")).toContainText("You need 3 skeins");
    await expect(page.locator("#skeins")).toHaveText("2");
    await expect(page.getByRole("button", { name: /^Nudge/ })).toBeEnabled();
    await help(page, /^Nudge/);
    await expect(page.locator("#skeins")).toHaveText("1");
  });

  test("solving with Show a cell only reaches the win card; skeins and stars are saved, and Quilt leaves", async ({ page }) => {
    test.setTimeout(90_000);
    await seedGameSave(page, { skeins: 100 });
    await openPuzzle(page);
    let used = 0;
    for (let i = 0; i < 40 && (await page.locator(".pz-win").isHidden()); i++) {
      await help(page, /^Show a cell/);
      used++;
      await settled(page);
    }
    await expect(page.locator(".pz-win")).toBeVisible();
    await expect(page.locator(".pz-win-name")).toHaveText("Cup");
    await expect(page.locator(".pz-win-meta")).toContainText("Tabby · 5×5");
    await expect(page.locator(".pz-stars")).toHaveAttribute("aria-label", "2 of 3 stars"); // helped, within par
    await expect(page.locator(".pz-win-skeins")).toHaveText("+4 skeins"); // Tabby 2 + 2 stars
    await expect(page.getByRole("button", { name: "Save picture" })).toBeVisible();
    const save = await readSave(page);
    expect(save.solved["cup-5"]).toMatchObject({ stars: 2 });
    expect(save.skeins).toBe(100 - 2 * used + 4 + 5); // the price of every hint, the reward, "First stitch"
    expect(save.progress["cup-5"]).toBeUndefined();
    await expect(page.locator("#skeins")).toHaveText(String(save.skeins));
    await expect(page.locator(".toast")).toContainText("First stitch");
    await page.getByRole("button", { name: "Quilt" }).click();
    await expect(page.locator("body")).toHaveAttribute("data-view", "play");
  });

  test("solving by drawing earns three stars; Next opens the next puzzle", async ({ page }, testInfo) => {
    test.setTimeout(60_000);
    const dev = pointer(page, testInfo);
    await openPuzzle(page);
    const p = await puzzleOf(page);
    for (let r = 0; r < p.h; r++) for (let c = 0; c < p.w; c++) if (p.solution[r * p.w + c]) await tapCell(dev, page, p, r, c);
    await expect(page.locator(".pz-win")).toBeVisible();
    await expect(page.locator(".pz-stars")).toHaveAttribute("aria-label", "3 of 3 stars");
    await expect(page.locator(".pz-win-skeins")).toHaveText("+5 skeins"); // Tabby 2 + 3 stars
    expect((await readSave(page)).skeins).toBe(5 + 5 + 5); // start, reward, "First stitch"
    await expect(page.locator(".pz-bar")).toBeHidden(); // the win card replaces the tools
    if (testInfo.project.use.hasTouch) expect(await smallTargets(page, 44, { scope: ".pz-win" })).toEqual([]);
    await expectNoHorizontalScroll(page);
    await page.screenshot({ path: `screens/${testInfo.project.name}-puzzle-win.png` });
    await page.getByRole("button", { name: "Next" }).click();
    await expect(page).toHaveURL(/#play\/(heart-5|tree-5)$/);
    await expect(page.locator(".pz-title")).toHaveText(/^Puzzle 2 · 5×5 · Tabby$/);
    await expect(page.locator(".pz-win")).toBeHidden();
  });

  test("the picture can be saved as a PNG", async ({ page }, testInfo) => {
    test.setTimeout(60_000);
    const dev = pointer(page, testInfo);
    await openPuzzle(page);
    const p = await puzzleOf(page);
    for (let r = 0; r < p.h; r++) for (let c = 0; c < p.w; c++) if (p.solution[r * p.w + c]) await tapCell(dev, page, p, r, c);
    await expect(page.locator(".pz-win")).toBeVisible();
    const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Save picture" }).click()]);
    expect(download.suggestedFilename()).toBe("hugi-cup-5.png");
  });

  test("reload resumes the board, the clock and the help flag", async ({ page }, testInfo) => {
    const dev = pointer(page, testInfo);
    await seedGameSave(page, { skeins: 20 });
    await openPuzzle(page);
    const p = await puzzleOf(page);
    await tapCell(dev, page, p, 0, 0);
    await page.getByRole("button", { name: "Mark" }).click();
    await tapCell(dev, page, p, 4, 4);
    await help(page, /^On track/);
    await settled(page);
    await expect.poll(async () => (await readSave(page)).progress["cup-5"]?.helped).toBe(true);
    await page.waitForTimeout(1200);
    await page.evaluate(() => dispatchEvent(new Event("pagehide"))); // what a closing tab sends
    const before = await readSave(page);
    expect(before.progress["cup-5"].seconds).toBeGreaterThanOrEqual(1);
    await page.reload();
    await expect(page.locator(".pz-title")).toHaveText(/·/);
    const rows = await board(page, p);
    expect(rows[0][0]).toBe(1);
    expect(rows[4][4]).toBe(2);
    await expect(page.locator(".pz-msg")).toHaveText("Picked up where you left off.");
    expect(await clockText(page)).not.toBe("0:00");
    expect((await readSave(page)).progress["cup-5"].helped).toBe(true);
  });

  test("the clock starts at the first stroke and pauses while the page is hidden", async ({ page }, testInfo) => {
    const dev = pointer(page, testInfo);
    await openPuzzle(page);
    const p = await puzzleOf(page);
    await page.waitForTimeout(1300);
    await expect(page.locator(".pz-clock")).toHaveText("0:00");
    await tapCell(dev, page, p, 0, 0);
    await expect(page.locator(".pz-clock")).not.toHaveText("0:00", { timeout: 4000 });
    await page.evaluate(() => {
      Object.defineProperty(document, "hidden", { value: true, configurable: true });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    const paused = await clockText(page);
    await page.waitForTimeout(1600);
    expect(await clockText(page)).toBe(paused);
  });

  test("Restart asks first, then clears the board, the clock and the saved progress", async ({ page }, testInfo) => {
    const dev = pointer(page, testInfo);
    await openPuzzle(page);
    const p = await puzzleOf(page);
    await tapCell(dev, page, p, 0, 0);
    await expect.poll(async () => (await readSave(page)).progress["cup-5"] !== undefined).toBe(true);
    if (!(await page.locator(".pz-help").isVisible())) await page.locator(".pz-helpbtn").click();
    await page.locator(".pz-restart:visible, [data-act=restart]:visible").first().click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.getByRole("button", { name: "Keep playing" }).click();
    expect((await board(page, p))[0][0]).toBe(1); // cancelled
    if (!(await page.locator(".pz-help").isVisible())) await page.locator(".pz-helpbtn").click();
    await page.locator(".pz-restart:visible, [data-act=restart]:visible").first().click();
    await page.getByRole("dialog").getByRole("button", { name: "Restart" }).click();
    await expect(page.locator(".pz-msg")).toHaveText("Started again.");
    expect(countOf(await board(page, p), 1)).toBe(0);
    await expect(page.locator(".pz-clock")).toHaveText("0:00");
    expect((await readSave(page)).progress["cup-5"]).toBeUndefined();
  });

  test("the daily route opens today's puzzle once five puzzles are solved, and says when it is not open", async ({ page }) => {
    await page.goto(`/index.html?pack=${PACK}#daily`);
    await expect(page.getByRole("heading", { name: "The daily puzzle is not open yet" })).toBeVisible();
    await expect(page.locator(".pz-card")).toContainText("(0 so far)");
  });

  test("the daily puzzle plays like any puzzle", async ({ page }) => {
    const solved = Object.fromEntries(FIVE.map((id) => [id, { stars: 1, best: 90, first: "2026-10-01" }]));
    await seedGameSave(page, { solved });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto(`/index.html?pack=${PACK}#daily`);
    await expect(page.locator(".pz-title")).toHaveText(/^Daily puzzle · 5×5 · Twill$/);
    await expect(page.locator(".pz-canvas")).toBeVisible();
    await expect(page).toHaveURL(/#daily$/);
  });

  test("keys 1 and 2 choose the tool and the buttons follow", async ({ page }) => {
    await openPuzzle(page);
    await page.locator(".pz-canvas").focus();
    await page.keyboard.press("2");
    await expect(page.getByRole("button", { name: "Mark" })).toHaveAttribute("aria-pressed", "true");
    await page.keyboard.press("1");
    await expect(page.getByRole("button", { name: "Fill" })).toHaveAttribute("aria-pressed", "true");
  });
});

test.describe("puzzle screen, layout", () => {
  /** An id of the shipped pack with a given side, found in the pack so the spec survives a rebuild. */
  const find = async (page, side) => {
    const pack = await (await page.request.get("/pack.json")).json();
    const solved = Object.fromEntries(pack.puzzles.filter((p) => p.tier !== "tapestry").map((p) => [p.id, { stars: 1, best: 99, first: "2026-10-01" }]));
    return { id: pack.puzzles.find((p) => p.w === side).id, solved };
  };

  for (const side of [10, 15, 40]) {
    test(`${side}x${side}: no sideways scroll, the sticky bar stays in view, Move appears when the board does not fit`, async ({ page }, testInfo) => {
      const { id, solved } = await find(page, side);
      await seedGameSave(page, { solved, skeins: 9 });
      await page.goto(`/index.html#play/${id}`);
      await expect(page.locator(".pz-title")).toContainText(`${side}×${side}`);
      await expectNoHorizontalScroll(page);
      const phone = (testInfo.project.use.viewport?.width ?? 1280) < 860;
      if (phone) await expect(page.locator(".pz-bar")).toBeInViewport({ ratio: 1 });
      const overflows = await page.evaluate(() => {
        const w = document.querySelector(".pz-frame");
        return w.scrollWidth > w.clientWidth + 1 || w.scrollHeight > w.clientHeight + 1;
      });
      await expect(page.locator('[data-tool="move"]')).toBeVisible({ visible: overflows });
      if (side === 40 && (testInfo.project.use.viewport?.width ?? 1280) < 600) expect(overflows).toBe(true); // a phone cannot show 40 cells at 14 px
    });
  }

  test("tap targets of the tools, the Help sheet and the win-card buttons are at least 44 px on touch", async ({ page }, testInfo) => {
    test.skip(!testInfo.project.use.hasTouch, "a touch rule");
    await openPuzzle(page);
    expect(await smallTargets(page, 44, { scope: "#view-puzzle" })).toEqual([]);
    if (!(await page.locator(".pz-help").isVisible())) await page.locator(".pz-helpbtn").click();
    expect(await smallTargets(page, 44, { scope: "#view-puzzle" })).toEqual([]);
    await expectNoHorizontalScroll(page);
  });

  test("on a phone the Help sheet closes after a choice, so the highlight is not covered", async ({ page }, testInfo) => {
    test.skip((testInfo.project.use.viewport?.width ?? 1280) >= 860, "the side panel keeps Help open");
    await seedGameSave(page, { skeins: 20 });
    await openPuzzle(page);
    await page.locator(".pz-helpbtn").click();
    await expect(page.locator(".pz-help")).toBeVisible();
    await expect(page.locator(".pz-helpbtn")).toHaveAttribute("aria-expanded", "true");
    await page.screenshot({ path: `screens/${testInfo.project.name}-puzzle-help.png` });
    await page.getByRole("button", { name: /^Nudge/ }).click();
    await expect(page.locator(".pz-help")).toBeHidden();
    await expect(page.locator(".pz-msg")).not.toHaveText("");
    await page.locator(".pz-helpbtn").click();
    await page.keyboard.press("Escape");
    await expect(page.locator(".pz-help")).toBeHidden();
  });

  test("with Move, one finger scrolls the board; with Fill it draws and the page does not scroll", async ({ page }, testInfo) => {
    test.skip(!testInfo.project.use.hasTouch || (testInfo.project.use.viewport?.width ?? 0) >= 600, "a phone gesture: a tablet shows the whole 40x40 board");
    const { id, solved } = await find(page, 40);
    await seedGameSave(page, { solved });
    await page.goto(`/index.html#play/${id}`);
    await expect(page.locator(".pz-title")).toContainText("40×40");
    const frame = page.locator(".pz-frame");
    const box = await frame.boundingBox();
    const from = { x: box.x + box.width * 0.8, y: box.y + box.height * 0.5 };
    const to = { x: box.x + box.width * 0.2, y: from.y };
    const scrollLeft = () => frame.evaluate((e) => e.scrollLeft);
    const pageY = () => page.evaluate(() => scrollY);
    // Fill: a horizontal swipe draws a stroke and scrolls nothing.
    await page.getByRole("button", { name: "Fill" }).click();
    const y0 = await pageY();
    await touchDrag(page, line(from, to, 6));
    expect(await scrollLeft()).toBe(0);
    expect(await pageY()).toBe(y0);
    // Move: the same swipe scrolls the frame and draws nothing.
    await page.getByRole("button", { name: "Move" }).click();
    await touchDrag(page, line(from, to, 8));
    await expect.poll(scrollLeft).toBeGreaterThan(20);
    await page.getByRole("button", { name: "Undo" }).click(); // undoes the Fill stroke only if there was one
  });

  for (const theme of ["light", "dark"]) {
    test(`${theme === "light" ? "day" : "night"}: the screen renders without a sideways scroll`, async ({ page }, testInfo) => {
      await openPuzzle(page, "cup-5", { theme });
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await expectNoHorizontalScroll(page);
      await page.screenshot({ path: `screens/${testInfo.project.name}-puzzle-${theme}.png` });
    });
  }
});
