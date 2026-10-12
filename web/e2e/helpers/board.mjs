// Helpers for web/test/board.html, which puts one Board on window.board.
import { expect } from "@playwright/test";

/** Open the board check page. p: "heart", "rings 25", "sierpinski", "rings 40", "tiny". */
export async function openBoard(page, { p = "heart", theme = "light" } = {}) {
  await page.goto(`/test/board.html?p=${encodeURIComponent(p)}&theme=${theme}`);
  await expect.poll(() => page.evaluate(() => !!window.board?.puzzle)).toBe(true);
}

export const cells = (page) => page.evaluate(() => Array.from(window.board.state));
export const filledCount = async (page) => (await cells(page)).filter((v) => v === 1).length;
export const markedCount = async (page) => (await cells(page)).filter((v) => v === 2).length;
export const puzzleSize = (page) => page.evaluate(() => ({ w: window.board.puzzle.w, h: window.board.puzzle.h }));

/** The client centre of cell (r, c). */
export function cellPoint(page, r, c) {
  return page.evaluate(
    ([r, c]) => {
      const b = window.board;
      const rect = b.canvas.getBoundingClientRect();
      const { left, top, cell } = b._geom;
      return { x: rect.left + left + (c + 0.5) * cell, y: rect.top + top + (r + 0.5) * cell };
    },
    [r, c],
  );
}

/** Scroll a cell into view inside the frame (a large board scrolls). */
export async function scrollToCell(page, r, c) {
  await page.evaluate(
    ([r, c]) => {
      const b = window.board;
      const { left, top, cell } = b._geom;
      b.wrap.scrollLeft = Math.max(0, left + c * cell - b.wrap.clientWidth / 2);
      b.wrap.scrollTop = Math.max(0, top + r * cell - b.wrap.clientHeight / 2);
    },
    [r, c],
  );
}

export const geom = (page) => page.evaluate(() => ({ ...window.board._geom }));
export const lineStatus = (page) => page.evaluate(() => window.board._lines);

/** Count canvas pixels within `tol` of a CSS colour (rgb array) inside a client-independent canvas box. */
export function countColour(page, rgb, box, tol = 40) {
  return page.evaluate(
    ([rgb, box, tol]) => {
      const c = window.board.canvas;
      const dpr = c.width / parseFloat(c.style.width);
      const d = c.getContext("2d").getImageData(box.x * dpr, box.y * dpr, box.w * dpr, box.h * dpr).data;
      let n = 0;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i + 3] > 200 && Math.abs(d[i] - rgb[0]) < tol && Math.abs(d[i + 1] - rgb[1]) < tol && Math.abs(d[i + 2] - rgb[2]) < tol) n++;
      }
      return n;
    },
    [rgb, box, tol],
  );
}

/** A CSS custom property of :root as [r, g, b]. */
export function themeColour(page, name) {
  return page.evaluate((name) => {
    const el = document.createElement("i");
    el.style.color = getComputedStyle(document.documentElement).getPropertyValue(name);
    document.body.append(el);
    const m = getComputedStyle(el).color.match(/\d+(\.\d+)?/g).map(Number);
    el.remove();
    return m.slice(0, 3);
  }, name);
}
