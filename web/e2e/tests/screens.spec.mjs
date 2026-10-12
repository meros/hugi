// Full-page screenshots of each view, project and theme into web/e2e/screens/ (git-ignored), to LOOK at.
// There are no pixel baselines: fonts differ between machines and CI, and the board animates. The assertions
// here are computed colours and geometry, which do not depend on the font.
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test, expect } from "../helpers/fixtures.mjs";
import { openApp, openMaker } from "../helpers/app.mjs";
import { openBoard } from "../helpers/board.mjs";
import { HEART_HASH } from "../helpers/data.mjs";

const dir = fileURLToPath(new URL("../screens/", import.meta.url));
mkdirSync(dir, { recursive: true });

const THEMES = { light: "day", dark: "night" };
const BG = { light: [230, 218, 189], dark: [15, 20, 27] }; // --bg of web/index.html

const SHOTS = {
  play: (page, theme) => openApp(page, "", { theme }),
  maker: (page, theme) => openMaker(page, HEART_HASH, { theme }),
  "maker-wide": async (page, theme) => {
    await openMaker(page, "#make", { theme });
    await page.locator("#examples").selectOption("sierpinski");
    await expect(page.locator("#verdict")).not.toHaveText(/^(Loading|Solving)/, { timeout: 20_000 });
  },
  "maker-import": async (page, theme) => {
    await openMaker(page, HEART_HASH, { theme });
    await page.locator("#import").click();
    await expect(page.locator("#import-dialog")).toBeVisible();
  },
  "board-15": (page, theme) => openBoard(page, { p: "heart", theme }),
  "board-40": (page, theme) => openBoard(page, { p: "rings 40", theme }),
};

for (const [theme, label] of Object.entries(THEMES)) {
  for (const [name, open] of Object.entries(SHOTS)) {
    test(`screenshot ${name} ${label}`, async ({ page }, testInfo) => {
      await page.emulateMedia({ reducedMotion: "reduce" });
      await open(page, theme);
      await page.waitForTimeout(250);
      await page.screenshot({ path: `${dir}${testInfo.project.name}-${name}-${label}.png`, fullPage: true });
      const bg = await page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor.match(/\d+/g).slice(0, 3).map(Number));
      expect(bg).toEqual(BG[theme]);
    });
  }
}

test.describe("geometry", () => {
  test("the Maker's board frame holds the board and the verdict is below or beside it", async ({ page }) => {
    await openMaker(page, HEART_HASH);
    const frame = await page.locator(".board-wrap").boundingBox();
    const canvas = await page.locator("#board").boundingBox();
    const vw = page.viewportSize().width;
    expect(frame.x).toBeGreaterThanOrEqual(0);
    expect(frame.x + frame.width).toBeLessThanOrEqual(vw + 0.5);
    expect(canvas.x + canvas.width).toBeLessThanOrEqual(frame.x + frame.width + 0.5);
    const verdict = await page.locator("#verdict").boundingBox();
    expect(verdict.x + verdict.width).toBeLessThanOrEqual(vw + 0.5);
  });

  test("on a phone the Maker is one column; the board is wide enough to play (cell 10 px or more)", async ({ page }, testInfo) => {
    test.skip(page.viewportSize().width > 500, "phones only");
    await openMaker(page, HEART_HASH);
    const frame = await page.locator(".board-wrap").boundingBox();
    const side = await page.locator("aside").boundingBox();
    expect(side.y).toBeGreaterThanOrEqual(frame.y + frame.height - 1); // below, not beside
    const w = await page.locator("#board").evaluate((c) => parseFloat(c.style.width));
    expect(w / 20).toBeGreaterThan(10);
  });

  for (const [theme, dark] of [["light", true], ["dark", false]]) {
    test(`${THEMES[theme]}: the tiles are drawn ${dark ? "dark" : "light"}`, async ({ page }) => {
      await openMaker(page, HEART_HASH, { theme });
      const px = await page.evaluate(() => {
        const c = document.getElementById("board");
        const d = c.getContext("2d").getImageData(c.width / 2, c.height * 0.55, 1, 1).data; // inside the heart
        return [d[0], d[1], d[2], d[3]];
      });
      expect(px[3]).toBeGreaterThan(200);
      const lum = (px[0] + px[1] + px[2]) / 3;
      if (dark) expect(lum).toBeLessThan(110);
      else expect(lum).toBeGreaterThan(110);
    });
  }
});
