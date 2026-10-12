// Screenshots of the share flow for a visual check (screens/ is ignored by git). Phone project only.
import { test, expect } from "../helpers/fixtures.mjs";
import { openMaker, seedGameSave } from "../helpers/app.mjs";

test.beforeEach(({}, info) => test.skip(info.project.name !== "phone", "screenshots are taken on the phone project"));

const shared = (title, author, bits, w, h, stars, at) => ({ w, h, bits, title, author, unique: true, stars, best: stars ? 60 : null, first: stars ? "2026-10-12" : null, at });

for (const theme of ["light", "dark"]) {
  test.describe(theme, () => {
    test.beforeEach(async ({ page }) => {
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.addInitScript((t) => localStorage.setItem("hugi-theme", t), theme);
    });

    test("share dialog, unique and not", async ({ page }) => {
      await openMaker(page, "#3x3:ugA", { theme });
      await page.locator("#share").click();
      await page.locator("#share-title").fill("Plus");
      await page.locator("#share-author").fill("Åsa");
      await page.screenshot({ path: `screens/share-unique-${theme}.png` });
      await page.keyboard.press("Escape");
      await page.locator("#examples").selectOption("rings");
      await expect(page.locator("#verdict")).toHaveText(/More than one solution/, { timeout: 20_000 });
      await page.locator("#share").click();
      await page.screenshot({ path: `screens/share-multi-${theme}.png` });
    });

    test("shared puzzle, several solutions, shelf", async ({ page }) => {
      await page.goto("/index.html#solve:3x3:ugA&t=Plus&a=%C3%85sa");
      await expect(page.locator(".pz-title")).toContainText("Plus");
      await page.screenshot({ path: `screens/share-puzzle-${theme}.png` });
      await page.goto("/index.html#solve:2x2:CQ&t=Pair&a=Ann");
      await expect(page.locator(".pz-note.pz-strong")).toBeVisible();
      await page.screenshot({ path: `screens/share-multi-puzzle-${theme}.png` });
    });

    test("shelf", async ({ page }) => {
      await seedGameSave(page, {
        shared: {
          "s-00000001": shared("Plus", "Åsa", "ugA", 3, 3, 3, 3),
          "s-00000002": shared("Block", "Ann", "_wE", 3, 3, 0, 2),
          "s-00000003": shared("", "", "CQ", 2, 2, 1, 1),
        },
      });
      await page.goto("/index.html#play");
      await expect(page.locator(".q-shelf .patch")).toHaveCount(3);
      await page.locator(".q-shelf").scrollIntoViewIfNeeded();
      await page.locator(".q-shelf").screenshot({ path: `screens/share-shelf-${theme}.png` });
    });
  });
}
