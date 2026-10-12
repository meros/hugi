import { test, expect } from "../helpers/fixtures.mjs";
import { openApp, openMaker, solverReady, verdict } from "../helpers/app.mjs";
import { HEART_HASH } from "../helpers/data.mjs";

const view = (page) => page.locator("body");

test.describe("router", () => {
  test("an empty hash opens Play and marks the Play link", async ({ page }) => {
    await openApp(page, "");
    await expect(view(page)).toHaveAttribute("data-view", "play");
    await expect(page.locator("#nav-play")).toHaveAttribute("aria-current", "page");
    await expect(page.locator("#nav-make")).not.toHaveAttribute("aria-current", /.*/);
    await expect(page.locator("#view-play")).toBeVisible();
    await expect(page.locator("#view-make")).toBeHidden();
  });

  test("#make opens the Maker", async ({ page }) => {
    await openMaker(page, "#make");
    await expect(page.locator("#nav-make")).toHaveAttribute("aria-current", "page");
    await expect(page.locator("#view-make")).toBeVisible();
    await expect(page.locator("#view-play")).toBeHidden();
  });

  test("a legacy share link opens the Maker with that picture and its verdict", async ({ page }) => {
    await openMaker(page, HEART_HASH);
    await expect(view(page)).toHaveAttribute("data-view", "make");
    await expect(page.locator("#w")).toHaveValue("15");
    await expect(page.locator("#h")).toHaveValue("15");
    await expect(verdict(page)).toHaveText(/Unique solution/);
    expect(await page.evaluate(() => location.hash)).toBe(HEART_HASH);
  });

  test("the nav switches views and each view keeps its hash", async ({ page }) => {
    await openMaker(page, HEART_HASH);
    await page.locator("#nav-play").click();
    await expect(view(page)).toHaveAttribute("data-view", "play");
    expect(await page.evaluate(() => location.hash)).toBe("#play");
    await page.locator("#nav-make").click();
    await expect(view(page)).toHaveAttribute("data-view", "make");
    // The Maker writes its own picture back to the hash when it is shown again.
    await expect.poll(() => page.evaluate(() => location.hash)).toBe(HEART_HASH);
    await expect(page.locator("#w")).toHaveValue("15");
    await solverReady(page);
    await expect(verdict(page)).toHaveText(/Unique solution/);
  });

  test("the Maker does not write its hash while Play is shown", async ({ page }) => {
    await openMaker(page, HEART_HASH);
    await page.locator("#nav-play").click();
    await expect(view(page)).toHaveAttribute("data-view", "play");
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => location.hash)).toBe("#play");
  });

  test("back and forward follow the views", async ({ page }) => {
    await openApp(page, "");
    await page.locator("#nav-make").click();
    await expect(view(page)).toHaveAttribute("data-view", "make");
    await page.goBack();
    await expect(view(page)).toHaveAttribute("data-view", "play");
    await page.goForward();
    await expect(view(page)).toHaveAttribute("data-view", "make");
  });

  test("an unknown hash falls back to Play", async ({ page }) => {
    await openApp(page, "#nonsense");
    await expect(view(page)).toHaveAttribute("data-view", "play");
  });

  test("the theme button switches and the choice survives a reload", async ({ page }) => {
    await openApp(page, "", { theme: "light" });
    const html = page.locator("html");
    await expect(html).toHaveAttribute("data-theme", "light");
    await page.locator("#theme").click();
    await expect(html).toHaveAttribute("data-theme", "dark");
    await expect(page.locator("#theme")).toHaveText("Day");
    await page.reload();
    await expect(html).toHaveAttribute("data-theme", "dark");
    await page.locator("#theme").click();
    await page.reload();
    await expect(html).toHaveAttribute("data-theme", "light");
  });

  test("the theme follows the system when nothing is stored", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "dark" });
    await openApp(page, "");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  });

  // Needs the screens of WP7.
  test.fixme("#play/<id> opens a puzzle and #daily opens today's puzzle (WP7b: play.js not merged)", async () => {});
});
