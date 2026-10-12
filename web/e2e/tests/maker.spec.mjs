import { test, expect } from "../helpers/fixtures.mjs";
import { openMaker, solverReady, verdict, makerGeometry, makerCell, pictureOf } from "../helpers/app.mjs";
import { mouseDrag, touchDrag, touchTap, line } from "../helpers/input.mjs";
import { HEART_HASH, PLUS5_HASH, ONE_UNIQUE_TEXT } from "../helpers/data.mjs";

const hash = (page) => page.evaluate(() => location.hash);
const touchy = (testInfo) => !!testInfo.project.use.hasTouch;

async function setSize(page, w, h) {
  await page.locator("#w").fill(String(w));
  await page.locator("#w").dispatchEvent("change");
  await page.locator("#h").fill(String(h));
  await page.locator("#h").dispatchEvent("change");
}

test.describe("Maker", () => {
  test("clear empties the picture and asks for a drawing", async ({ page }) => {
    await openMaker(page, HEART_HASH);
    await page.locator("#clear").click();
    await expect(verdict(page)).toHaveText("Draw something");
    await expect.poll(() => hash(page)).toMatch(/^#15x15:A+$/);
    expect((await pictureOf(page)).join("")).not.toContain("#");
  });

  test("a stroke on the canvas draws cells and updates the hash and the verdict", async ({ page }, testInfo) => {
    await openMaker(page, "#make");
    await page.locator("#clear").click();
    await setSize(page, 5, 5);
    const g = await makerGeometry(page);
    const a = await makerCell(page, 2, 0, g);
    const b = await makerCell(page, 2, 4, g);
    if (touchy(testInfo)) await touchDrag(page, line(a, b, 8));
    else await mouseDrag(page, line(a, b, 8));
    await expect(verdict(page)).toHaveText(/Unique solution/, { timeout: 15_000 });
    expect(await pictureOf(page)).toEqual(["..#..", "..#..", "..#..", "..#..", "..#.."]);
    // A second tap on a drawn cell erases it.
    const before = await hash(page);
    const c = await makerCell(page, 2, 2, g);
    if (touchy(testInfo)) await touchTap(page, c);
    else await page.mouse.click(c.x, c.y);
    await expect.poll(() => pictureOf(page)).toEqual(["..#..", "..#..", ".....", "..#..", "..#.."]);
  });

  test("touch draws and mouse draws give the same picture", async ({ page }, testInfo) => {
    await openMaker(page, "#make");
    await page.locator("#clear").click();
    await setSize(page, 5, 5);
    const g = await makerGeometry(page);
    const a = await makerCell(page, 1, 1, g);
    const b = await makerCell(page, 3, 1, g);
    await mouseDrag(page, line(a, b, 6));
    const viaMouse = await hash(page);
    await page.locator("#clear").click();
    await touchDrag(page, line(a, b, 6));
    expect(await hash(page)).toBe(viaMouse);
  });

  test("right click or shift erases", async ({ page }, testInfo) => {
    test.skip(touchy(testInfo), "a mouse gesture");
    await openMaker(page, PLUS5_HASH);
    const g = await makerGeometry(page);
    const before = await hash(page);
    const c = await makerCell(page, 2, 2, g);
    await page.mouse.click(c.x, c.y, { button: "right" });
    await expect.poll(() => hash(page)).not.toBe(before);
  });

  test("the example picker loads an example and resets itself", async ({ page }) => {
    await openMaker(page, "#make");
    await page.locator("#examples").selectOption("house");
    await expect(page.locator("#examples")).toHaveValue("");
    await expect.poll(() => hash(page)).toMatch(/^#\d+x\d+:/);
    await solverReady(page);
    const house = await hash(page);
    await page.locator("#examples").selectOption("rings");
    await expect.poll(() => hash(page)).not.toBe(house);
    await expect(verdict(page)).toHaveText(/More than one solution/, { timeout: 20_000 });
  });

  test("import: a picture in text becomes the picture", async ({ page }) => {
    await openMaker(page, "#make");
    await page.locator("#import").click();
    await expect(page.locator("#import-dialog")).toBeVisible();
    await page.locator("#import-text").fill(ONE_UNIQUE_TEXT);
    await page.locator("#import-go").click();
    await expect(page.locator("#import-dialog")).toBeHidden();
    await expect(page.locator("#w")).toHaveValue("3");
    await expect(page.locator("#h")).toHaveValue("3");
    await expect(verdict(page)).toHaveText(/Unique solution/, { timeout: 15_000 });
    expect(await hash(page)).toMatch(/^#3x3:/);
  });

  test("import: clues in Hugi's format give the picture and the solver finds it", async ({ page }) => {
    await openMaker(page, "#make");
    await page.locator("#import").click();
    await page.locator("#import-text").fill("rows\n1\n3\n1\ncols\n1\n3\n1\n");
    await page.locator("#import-go").click();
    await expect(page.locator("#import-dialog")).toBeHidden();
    await expect(page.locator("#w")).toHaveValue("3");
    await expect(verdict(page)).toHaveText(/Unique solution/, { timeout: 15_000 });
  });

  test("import: cancel and Escape close the dialog without a change", async ({ page }) => {
    await openMaker(page, HEART_HASH);
    await page.locator("#import").click();
    await page.locator("#import-cancel").click();
    await expect(page.locator("#import-dialog")).toBeHidden();
    await page.locator("#import").click();
    await page.keyboard.press("Escape");
    await expect(page.locator("#import-dialog")).toBeHidden();
    expect(await hash(page)).toBe(HEART_HASH);
  });

  test("import: bad text shows an error and keeps the dialog open", async ({ page }) => {
    await openMaker(page, "#make");
    await page.locator("#import").click();
    await page.locator("#import-text").fill("this is not a puzzle");
    await page.locator("#import-go").click();
    await expect(page.locator("#import-error")).not.toBeEmpty();
    await expect(page.locator("#import-dialog")).toBeVisible();
  });

  test("a share link round trip: the link in a new tab shows the same picture", async ({ page, context }) => {
    await openMaker(page, HEART_HASH);
    await page.locator("#examples").selectOption("smiley");
    await solverReady(page);
    const shared = await hash(page);
    expect(shared).toMatch(/^#\d+x\d+:/);
    const other = await context.newPage();
    await other.goto("/index.html" + shared);
    await expect(other.locator("body")).toHaveAttribute("data-view", "make");
    await expect(other.locator("#verdict")).not.toHaveText(/^(Loading|Solving)/, { timeout: 20_000 });
    expect(await other.evaluate(() => location.hash)).toBe(shared);
    expect(await other.locator("#w").inputValue()).toBe(await page.locator("#w").inputValue());
    await other.close();
  });

  test("Copy link puts the share link on the clipboard", async ({ page, context, browserName }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await openMaker(page, HEART_HASH);
    await page.locator("#share").click();
    await expect(page.locator("#share")).toHaveText("Copied");
    const text = await page.evaluate(() => navigator.clipboard.readText());
    expect(text).toBe(new URL("/index.html" + HEART_HASH, page.url()).href);
    await expect(page.locator("#share")).toHaveText("Copy link"); // the label comes back
  });

  test("the Maker's picture comes back after a reload without a hash", async ({ page }) => {
    await openMaker(page, HEART_HASH);
    await page.goto("/index.html#make");
    await page.reload();
    await expect(page.locator("body")).toHaveAttribute("data-view", "make");
    await expect.poll(() => hash(page)).toBe(HEART_HASH);
  });

  test("the colour buttons set the aria-pressed state and persist", async ({ page }) => {
    await openMaker(page, HEART_HASH);
    await page.locator('[data-thread="2"]').click();
    await expect(page.locator('[data-thread="2"]')).toHaveAttribute("aria-pressed", "true");
    await page.reload();
    await expect(page.locator('[data-thread="2"]')).toHaveAttribute("aria-pressed", "true");
  });

  test("a very wide picture scrolls inside its frame, not the page", async ({ page }) => {
    await openMaker(page, "#make");
    await page.locator("#examples").selectOption("sierpinski");
    await solverReady(page);
    const m = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: innerWidth }));
    expect(m.sw).toBeLessThanOrEqual(m.iw);
  });
});
