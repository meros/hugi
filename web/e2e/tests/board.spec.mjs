// The play board on web/test/board.html: 15x15 heart (thread 2), 25x25 and 40x40 rings, 32x32 sierpinski.
import { test, expect } from "../helpers/fixtures.mjs";
import { openBoard, cells, filledCount, markedCount, cellPoint, scrollToCell, geom, lineStatus, countColour, themeColour, puzzleSize } from "../helpers/board.mjs";
import { pointer, line, touchDrag, mouseDrag } from "../helpers/input.mjs";
import { expectNoHorizontalScroll } from "../helpers/layout.mjs";

const idx = (w, r, c) => r * w + c;

/** Bring a rectangle of cells into the frame and the page viewport; returns nothing. */
async function show(page, r, c) {
  await scrollToCell(page, r, c);
  await page.locator("#board").scrollIntoViewIfNeeded();
}

test.describe("board", () => {
  test("a tap fills a cell and a second tap clears it", async ({ page }, testInfo) => {
    const dev = pointer(page, testInfo);
    await openBoard(page);
    const p = await cellPoint(page, 4, 4);
    await dev.tap(p);
    expect((await cells(page))[idx(15, 4, 4)]).toBe(1);
    await dev.tap(p);
    expect((await cells(page))[idx(15, 4, 4)]).toBe(0);
  });

  test("the Mark tool puts a mark, and a fill drag never overwrites it", async ({ page }, testInfo) => {
    const dev = pointer(page, testInfo);
    await openBoard(page);
    await page.locator('[data-tool="mark"]').click();
    await expect(page.locator('[data-tool="mark"]')).toHaveAttribute("aria-pressed", "true");
    await dev.tap(await cellPoint(page, 6, 5));
    expect((await cells(page))[idx(15, 6, 5)]).toBe(2);
    await page.locator('[data-tool="fill"]').click();
    await dev.drag(line(await cellPoint(page, 6, 3), await cellPoint(page, 6, 8), 10));
    const row = (await cells(page)).slice(idx(15, 6, 0), idx(15, 7, 0));
    expect(row.slice(3, 9)).toEqual([1, 1, 2, 1, 1, 1]);
  });

  test("right click marks whatever the tool is", async ({ page }, testInfo) => {
    test.skip(!!testInfo.project.use.hasTouch, "a mouse gesture");
    await openBoard(page);
    const p = await cellPoint(page, 2, 2);
    await page.mouse.click(p.x, p.y, { button: "right" });
    expect((await cells(page))[idx(15, 2, 2)]).toBe(2);
  });

  test("a drag locks to the row of its first cell", async ({ page }, testInfo) => {
    const dev = pointer(page, testInfo);
    await openBoard(page);
    const a = await cellPoint(page, 3, 2);
    const b = await cellPoint(page, 3, 9);
    const wobble = await cellPoint(page, 5, 10); // two rows off, but the row axis is longer
    await dev.drag([a, ...line(a, b, 6).slice(1), wobble]);
    const s = await cells(page);
    const filled = s.map((v, i) => (v === 1 ? i : -1)).filter((i) => i >= 0);
    expect(filled).toEqual(Array.from({ length: 9 }, (_, k) => idx(15, 3, 2 + k)));
  });

  test("a drag locks to the column of its first cell", async ({ page }, testInfo) => {
    const dev = pointer(page, testInfo);
    await openBoard(page);
    const a = await cellPoint(page, 2, 6);
    const b = await cellPoint(page, 9, 6);
    const wobble = await cellPoint(page, 10, 8);
    await dev.drag([a, ...line(a, b, 6).slice(1), wobble]);
    const filled = (await cells(page)).map((v, i) => (v === 1 ? i : -1)).filter((i) => i >= 0);
    expect(filled).toEqual(Array.from({ length: 9 }, (_, k) => idx(15, 2 + k, 6)));
  });

  test("a drag that turns back gives the cells back", async ({ page }, testInfo) => {
    const dev = pointer(page, testInfo);
    await openBoard(page);
    const a = await cellPoint(page, 7, 1);
    const far = await cellPoint(page, 7, 9);
    const near = await cellPoint(page, 7, 3);
    await dev.drag([a, ...line(a, far, 4).slice(1), ...line(far, near, 4).slice(1)]);
    expect(await filledCount(page)).toBe(3);
  });

  test("undo and redo by button, one stroke is one step", async ({ page }, testInfo) => {
    const dev = pointer(page, testInfo);
    await openBoard(page);
    await dev.drag(line(await cellPoint(page, 1, 1), await cellPoint(page, 1, 5), 5));
    await dev.tap(await cellPoint(page, 9, 9));
    expect(await filledCount(page)).toBe(6);
    await page.locator("#undo").click();
    expect(await filledCount(page)).toBe(5);
    await page.locator("#undo").click();
    expect(await filledCount(page)).toBe(0);
    await page.locator("#redo").click();
    expect(await filledCount(page)).toBe(5);
    await page.locator("#redo").click();
    expect(await filledCount(page)).toBe(6);
  });

  test("a new stroke clears the redo history", async ({ page }, testInfo) => {
    const dev = pointer(page, testInfo);
    await openBoard(page);
    await dev.tap(await cellPoint(page, 0, 0));
    await page.locator("#undo").click();
    expect(await page.evaluate(() => window.board.canRedo)).toBe(true);
    await dev.tap(await cellPoint(page, 1, 1));
    expect(await page.evaluate(() => window.board.canRedo)).toBe(false);
  });

  test("keyboard: arrows move the cursor, Space fills, X marks, Z and Y undo and redo", async ({ page }) => {
    await openBoard(page);
    await page.locator("#board").focus();
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowDown");
    expect(await page.evaluate(() => window.board.cursor)).toEqual({ r: 1, c: 1 });
    await page.keyboard.press(" ");
    expect((await cells(page))[idx(15, 1, 1)]).toBe(1);
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("x");
    expect((await cells(page))[idx(15, 1, 2)]).toBe(2);
    await page.keyboard.press("z");
    expect((await cells(page))[idx(15, 1, 2)]).toBe(0);
    await page.keyboard.press("y");
    expect((await cells(page))[idx(15, 1, 2)]).toBe(2);
    await page.keyboard.press("Control+z");
    await page.keyboard.press("Control+z");
    expect(await filledCount(page)).toBe(0);
    await page.keyboard.press("Control+Shift+z");
    expect((await cells(page))[idx(15, 1, 1)]).toBe(1);
  });

  test("keyboard: Shift + arrows repeat the last action (a keyboard drag)", async ({ page }) => {
    await openBoard(page);
    await page.locator("#board").focus();
    await page.keyboard.press("Space");
    await page.keyboard.press("Shift+ArrowRight");
    await page.keyboard.press("Shift+ArrowRight");
    await page.keyboard.press("Shift+ArrowRight");
    const row = (await cells(page)).slice(0, 4);
    expect(row).toEqual([1, 1, 1, 1]);
    await page.keyboard.press("z"); // the whole keyboard drag is one step
    expect(await filledCount(page)).toBe(0);
  });

  // docs/game-design.md section 1: "Space or Enter: Fill at the cursor". board.js _keyDown lower-cases only
  // one-character keys, so e.key "Enter" is compared with "enter" and never matches.
  test.fixme("keyboard: Enter fills at the cursor (BUG web/game/board.js: k === \"enter\" never true)", async ({ page }) => {
    await openBoard(page);
    await page.locator("#board").focus();
    await page.keyboard.press("Enter");
    expect((await cells(page))[0]).toBe(1);
  });

  test("keys 1 and 2 choose the tool and the buttons follow", async ({ page }) => {
    await openBoard(page);
    await page.locator("#board").focus();
    await page.keyboard.press("2");
    await expect(page.locator('[data-tool="mark"]')).toHaveAttribute("aria-pressed", "true");
    await page.keyboard.press("1");
    await expect(page.locator('[data-tool="fill"]')).toHaveAttribute("aria-pressed", "true");
  });

  test("a clue turns impossible (--bad) when a cell is filled in an empty line, and back when undone", async ({ page }, testInfo) => {
    const dev = pointer(page, testInfo);
    await openBoard(page); // the heart's row 0 and column 0 are empty
    const bad = await themeColour(page, "--bad");
    const g = await geom(page);
    const box = { x: 0, y: g.top, w: g.left, h: g.cell }; // the clue of row 0
    expect(await countColour(page, bad, box)).toBe(0);
    expect((await lineStatus(page)).rows[0]).toBe(2); // empty clue, empty line: done
    await dev.tap(await cellPoint(page, 0, 7));
    expect((await lineStatus(page)).rows[0]).toBe(1);
    expect(await countColour(page, bad, box)).toBeGreaterThan(0);
    await page.locator("#undo").click();
    expect((await lineStatus(page)).rows[0]).toBe(2);
    expect(await countColour(page, bad, box)).toBe(0);
  });

  test("a clue greys out (done) when its line is complete", async ({ page }, testInfo) => {
    const dev = pointer(page, testInfo);
    await openBoard(page);
    const ink = await themeColour(page, "--ink");
    const g = await geom(page);
    const box = { x: 0, y: g.top + 4 * g.cell, w: g.left, h: g.cell }; // the clue of row 4: 15
    const before = await countColour(page, ink, box, 60);
    expect(before).toBeGreaterThan(10);
    expect((await lineStatus(page)).rows[4]).toBe(0);
    await dev.drag(line(await cellPoint(page, 4, 0), await cellPoint(page, 4, 14), 14));
    expect((await lineStatus(page)).rows[4]).toBe(2);
    expect(await countColour(page, ink, box, 60)).toBeLessThan(before / 3);
  });

  test("the hint and wrong-cell highlights draw and the next stroke clears them", async ({ page }, testInfo) => {
    const dev = pointer(page, testInfo);
    await openBoard(page);
    await page.locator("#hint").click();
    expect(await page.evaluate(() => window.board._hl.lines.length)).toBe(2);
    await dev.tap(await cellPoint(page, 0, 0));
    expect(await page.evaluate(() => window.board._hl.lines.length)).toBe(0);
    await page.locator("#wrong").click();
    expect(await page.evaluate(() => window.board._hl.cells.length)).toBe(2);
  });

  test("reveal paints the picture in its thread colour and locks the board", async ({ page }) => {
    await openBoard(page, { p: "heart" });
    await page.locator("#reveal").click();
    await expect(page.locator("#log")).toHaveText("revealed", { timeout: 6000 });
    expect(await page.evaluate(() => window.board.revealed)).toBe(true);
    const t2 = await themeColour(page, "--t2");
    const g = await geom(page);
    expect(await countColour(page, t2, { x: g.left + 7 * g.cell, y: g.top + 4 * g.cell, w: g.cell, h: g.cell }, 12)).toBeGreaterThan(g.cell * g.cell * 0.8);
    const before = await cells(page);
    await page.locator("#board").focus();
    await page.keyboard.press("Space");
    expect(await cells(page)).toEqual(before);
  });

  test("reveal with reduced motion goes straight to the final state", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await openBoard(page);
    const t = await page.evaluate(async () => {
      const t0 = performance.now();
      await window.board.reveal(window.board.puzzle.solution, 2);
      return performance.now() - t0;
    });
    expect(t).toBeLessThan(150); // the animation takes at least 1 s
    expect(await page.evaluate(() => window.board.revealed)).toBe(true);
  });

  test("reveal without reduced motion takes time (the wave)", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await openBoard(page);
    const t = await page.evaluate(async () => {
      const t0 = performance.now();
      await window.board.reveal(window.board.puzzle.solution, 2);
      return performance.now() - t0;
    });
    expect(t).toBeGreaterThan(700);
  });

  test("night theme redraws the board in the night colours", async ({ page }) => {
    await openBoard(page, { theme: "dark" });
    const ink = await themeColour(page, "--t5");
    expect(ink[0]).toBeGreaterThan(200); // --t5 is light in the night theme
    await page.locator('#board').scrollIntoViewIfNeeded();
    const p = await cellPoint(page, 4, 4);
    await page.mouse.click(p.x, p.y);
    const g = await geom(page);
    const n = await countColour(page, ink, { x: g.left + 4 * g.cell + 2, y: g.top + 4 * g.cell + 2, w: g.cell - 4, h: g.cell - 4 }, 30);
    expect(n).toBeGreaterThan(10);
  });

  test.describe("large boards", () => {
    test("40x40 scrolls inside its frame and never scrolls the page sideways", async ({ page }, testInfo) => {
      await openBoard(page, { p: "rings 40" });
      await expectNoHorizontalScroll(page);
      const m = await page.evaluate(() => {
        const w = window.board.wrap;
        return { sw: w.scrollWidth, cw: w.clientWidth, ox: getComputedStyle(w).overflowX };
      });
      expect(["auto", "scroll"]).toContain(m.ox);
      if (page.viewportSize().width < 600) expect(m.sw).toBeGreaterThan(m.cw); // phones and tablets cannot fit 40 cells (a tablet at 768 can)
      // the frame scrolls
      await page.evaluate(() => (window.board.wrap.scrollLeft = 120));
      if (m.sw > m.cw) expect(await page.evaluate(() => window.board.wrap.scrollLeft)).toBeGreaterThan(0);
      await expectNoHorizontalScroll(page);
      expect(await page.evaluate(() => document.scrollingElement.scrollLeft)).toBe(0);
    });

    test("40x40: the cell is at least 14 px on touch and 12 px with a mouse", async ({ page }, testInfo) => {
      await openBoard(page, { p: "rings 40" });
      const g = await geom(page);
      expect(g.cell).toBeGreaterThanOrEqual(testInfo.project.use.hasTouch ? 14 : 12);
    });

    test("40x40: a fill tap and drag work after scrolling to the far corner", async ({ page }, testInfo) => {
      const dev = pointer(page, testInfo);
      await openBoard(page, { p: "rings 40" });
      await scrollToCell(page, 35, 35);
      await page.locator("#board").scrollIntoViewIfNeeded();
      await scrollToCell(page, 35, 35);
      const a = await cellPoint(page, 35, 33);
      const b = await cellPoint(page, 35, 36);
      const vp = page.viewportSize();
      test.skip(a.x < 0 || b.x > vp.width || a.y > vp.height, "the far corner is outside the viewport on this project");
      await dev.drag(line(a, b, 4));
      const s = await cells(page);
      expect([33, 34, 35, 36].map((c) => s[idx(40, 35, c)])).toEqual([1, 1, 1, 1]);
    });

    test("40x40: with the Move tool one finger scrolls the frame instead of drawing", async ({ page }, testInfo) => {
      test.skip(!testInfo.project.use.hasTouch, "a touch gesture");
      await openBoard(page, { p: "rings 40" });
      test.skip(await page.evaluate(() => window.board.wrap.scrollWidth <= window.board.wrap.clientWidth), "the board fits the frame");
      await page.locator('[data-tool="move"]').click();
      await page.locator("#board").scrollIntoViewIfNeeded();
      const r = await page.locator("#wrap").boundingBox();
      const y = Math.min(r.y + r.height / 2, page.viewportSize().height - 40);
      await touchDrag(page, line({ x: r.x + r.width - 30, y }, { x: r.x + 30, y }, 10));
      await expect.poll(() => page.evaluate(() => window.board.wrap.scrollLeft)).toBeGreaterThan(20);
      expect(await filledCount(page)).toBe(0);
    });

    test("25x25 and 32x32 fit or scroll without a page overflow", async ({ page }) => {
      for (const p of ["rings 25", "sierpinski"]) {
        await openBoard(page, { p });
        await expectNoHorizontalScroll(page);
        const { w } = await puzzleSize(page);
        expect(w).toBeGreaterThan(20);
      }
    });
  });
});
