// The Play screen (WP7a): the daily card, the quilt, the shelf, and the Achievements and Your progress dialogs.
// Most tests use the small fixture pack (3 + 3 puzzles, Twill opens after 2 Tabby); the unlock at 20 uses the real pack.
import { readFileSync } from "node:fs";
import { test, expect } from "../helpers/fixtures.mjs";
import { openApp, seedGameSave, gameSave } from "../helpers/app.mjs";
import { expectNoHorizontalScroll, smallTargets, contrastOf } from "../helpers/layout.mjs";

const SMALL = "?pack=test/fixtures/pack-small.json";
const REAL = JSON.parse(readFileSync(new URL("../../pack.json", import.meta.url), "utf8"));
const solved = (ids, stars = 3) => Object.fromEntries(ids.map((id) => [id, { stars, best: 40, first: "2026-10-10" }]));
const TABBY = ["cup-5", "heart-5", "tree-5"];
const ALL_SMALL = [...TABBY, "boat-6", "moon-6", "key-6"];

const open = async (page, opts = {}) => {
  await openApp(page, SMALL, opts);
  await expect(page.locator(".q-page")).toBeVisible();
};
const savedGame = (page) => page.evaluate(() => JSON.parse(localStorage.getItem("hugi-game")));

test.describe("a fresh save", () => {
  test("opens the first tier, locks the others and says how to start", async ({ page }) => {
    await open(page);
    await expect(page.locator(".q-prompt")).toContainText("Pick any patch in Tabby");
    await expect(page.locator("#q-h-tabby")).toHaveText("Tabby");
    await expect(page.locator(".q-tier").first().locator(".q-count")).toHaveText("0 of 3");
    await expect(page.locator(".patch")).toHaveCount(6);
    await expect(page.locator(".patch.blank")).toHaveCount(6);
    await expect(page.locator(".q-tier.locked")).toHaveCount(1);
    await expect(page.locator(".q-tier.locked .q-lock")).toHaveText("Opens when you solve 2 Tabby puzzles (0 so far).");
    await expect(page.locator("#skeins")).toHaveText("5");
    await expect(page.locator(".q-shelf")).toContainText("Nothing here yet");
  });

  test("the daily card is locked with a plain sentence", async ({ page }) => {
    await open(page);
    await expect(page.locator(".q-daily .q-lock")).toHaveText("Opens when you solve 5 puzzles from the quilt (0 so far).");
    await expect(page.locator(".q-daily button")).toHaveCount(0);
  });

  test("a locked patch cannot take focus", async ({ page }) => {
    await open(page);
    const grid = page.locator(".q-tier.locked .quilt");
    await expect(grid).toHaveAttribute("inert", "");
    const kept = await page.evaluate(() => {
      const b = document.querySelector(".q-tier.locked .patch");
      b.focus();
      return document.activeElement === b;
    });
    expect(kept).toBe(false);
    // Tab through the page: focus never lands in the locked grid.
    await page.locator(".q-tier").first().locator(".patch").last().focus();
    await page.keyboard.press("Tab");
    expect(await page.evaluate(() => !!document.activeElement.closest(".locked"))).toBe(false);
  });

  test("a patch opens its puzzle", async ({ page }) => {
    await open(page);
    await page.locator(".patch").first().click();
    await expect.poll(() => page.evaluate(() => location.hash)).toBe("#play/cup-5");
  });
});

test.describe("a seeded save", () => {
  test.beforeEach(async ({ page }) => {
    await seedGameSave(
      page,
      gameSave({
        skeins: 42,
        solved: { ...solved(["cup-5"], 3), ...solved(["heart-5"], 1) },
        progress: { "tree-5": { cells: "AAAA", seconds: 4, helped: false, at: 1 } },
        daily: { last: "2026-10-11", streak: 3, best: 3 },
      }),
    );
    await open(page);
  });

  test("solved patches show their picture and stars, a started board is marked", async ({ page }) => {
    await expect(page.locator("#skeins")).toHaveText("42");
    await expect(page.locator(".patch.solved")).toHaveCount(2);
    await expect(page.locator(".patch.started")).toHaveCount(1);
    await expect(page.locator(".patch.started .under")).toHaveText("started");
    const first = page.locator(".patch.solved").first();
    await expect(first.locator(".q-stars")).toHaveText("★★★");
    await expect(page.locator(".patch.solved").nth(1).locator(".q-stars")).toHaveText("★☆☆");
    await expect(first).toHaveAttribute("aria-label", /Puzzle 1, Cup, 5×5, solved, 3 stars/);
    await expect(first.locator("canvas")).toHaveAttribute("data-key", /\d+\|#/);
    // The canvas has ink in it.
    const ink = await first.locator("canvas").evaluate((c) => c.getContext("2d").getImageData(0, 0, c.width, c.height).data.some((v, i) => i % 4 === 3 && v > 0));
    expect(ink).toBe(true);
    await expect(page.locator(".q-tier").first().locator(".q-count")).toHaveText("2 of 3");
    await expect(page.locator(".q-prompt")).toHaveCount(0);
  });

  test("a tier opens when enough of the one before is solved", async ({ page }) => {
    await seedAgain(page, { solved: solved(["cup-5"]) });
    await expect(page.locator(".q-tier.locked .q-lock")).toHaveText("Opens when you solve 2 Tabby puzzles (1 so far).");
    await seedAgain(page, { solved: solved(["cup-5", "heart-5"]) });
    await expect(page.locator(".q-tier.locked")).toHaveCount(0);
    await expect(page.locator(".q-tier").nth(1).locator(".quilt")).not.toHaveAttribute("inert", "");
  });
});

// Rewrites the save and shows the screen again without a new page (the router does the rest).
async function seedAgain(page, over) {
  await page.evaluate((s) => localStorage.setItem("hugi-game", JSON.stringify(s)), gameSave(over));
  await page.reload();
  await expect(page.locator(".q-page")).toBeVisible();
}

test("the second tier of the real pack opens at 20 solved Tabby puzzles, not at 19", async ({ page }) => {
  const tabby = REAL.puzzles.filter((p) => p.tier === "tabby").map((p) => p.id);
  await seedGameSave(page, gameSave({ solved: solved(tabby.slice(0, 19)) }));
  await openApp(page, "");
  await expect(page.locator(".q-page")).toBeVisible();
  await expect(page.locator(".q-tier.locked .q-lock").first()).toHaveText("Opens when you solve 20 Tabby puzzles (19 so far).");
  await expect(page.locator(".patch")).toHaveCount(150);
  await seedAgain(page, { solved: solved(tabby.slice(0, 20)) });
  await expect(page.locator("#q-h-twill").locator("xpath=ancestor::section")).not.toHaveClass(/locked/);
  await expect(page.locator(".q-lock")).toHaveCount(3); // Satin, Brocade, Tapestry (the daily is open after 20 solved)
});

test.describe("a finished tier", () => {
  test("reads as a finished quilt", async ({ page }) => {
    await seedGameSave(page, gameSave({ solved: solved(TABBY) }));
    await open(page);
    await expect(page.locator(".q-tier.done")).toHaveCount(1);
    await expect(page.locator(".q-done")).toHaveText("A finished quilt: all 3 pictures are yours.");
  });
});

test.describe("the daily card", () => {
  const five = solved(["cup-5", "heart-5", "tree-5", "boat-6", "moon-6"]);

  test("2026-10-12 after a streak of 3 yesterday: Play and the streak", async ({ page }) => {
    await page.clock.setFixedTime(new Date(2026, 9, 12, 10, 0));
    await seedGameSave(page, gameSave({ solved: five, daily: { last: "2026-10-11", streak: 3, best: 3 } }));
    await open(page);
    await expect(page.locator(".q-daily .q-meta")).toHaveText("5×5 · Twill");
    await expect(page.locator(".q-daily")).toContainText("Streak: 3 days. Solve today’s to keep it.");
    await page.locator(".q-daily .q-play").click();
    await expect.poll(() => page.evaluate(() => location.hash)).toBe("#daily");
  });

  test("2026-10-12 with the daily done today: Solved today, with its picture", async ({ page }) => {
    // The daily of 2026-10-12 is daily[(11 * 37) % 3] = d-c-5.
    await page.clock.setFixedTime(new Date(2026, 9, 12, 23, 30));
    await seedGameSave(page, gameSave({ solved: { ...five, ...solved(["d-c-5"], 2) }, daily: { last: "2026-10-12", streak: 4, best: 4 } }));
    await open(page);
    await expect(page.locator(".q-solved")).toHaveText("Solved today");
    await expect(page.locator(".q-daily .q-stars")).toHaveText("★★☆");
    await expect(page.locator(".q-daily")).toContainText("Streak: 4 days.");
    await expect(page.locator(".q-daily .q-play")).toHaveCount(0);
    await expect(page.locator(".q-daily canvas")).toHaveAttribute("data-key", /\d+\|#/);
  });

  test("2026-10-14 after a gap: the streak is over", async ({ page }) => {
    await page.clock.setFixedTime(new Date(2026, 9, 14, 9, 0));
    await seedGameSave(page, gameSave({ solved: five, daily: { last: "2026-10-11", streak: 3, best: 3 } }));
    await open(page);
    await expect(page.locator(".q-daily")).toContainText("No streak yet.");
    await expect(page.locator(".q-daily .q-play")).toHaveText("Play");
  });
});

test.describe("the shelf", () => {
  test("lists shared puzzles with title and author, and opens the solve link", async ({ page }) => {
    const bits = "xH1HAA";
    await seedGameSave(
      page,
      gameSave({
        shared: {
          "s-1": { w: 5, h: 5, bits, title: "Plus <b>", author: "Åsa", unique: true, stars: 2, best: 30, first: "2026-10-10", at: 5 },
          "s-2": { w: 5, h: 5, bits, title: "", author: "", unique: true, stars: 0, best: null, first: null, at: 4 },
        },
      }),
    );
    await open(page);
    const shelf = page.locator(".q-shelf");
    await expect(shelf.locator(".patch")).toHaveCount(2);
    await expect(shelf.locator(".q-title").first()).toHaveText("Plus <b>"); // text, never markup
    await expect(shelf.locator(".q-from")).toHaveText("from Åsa");
    await expect(shelf.locator(".q-title").nth(1)).toHaveText("Untitled");
    await expect(shelf.locator(".patch.solved")).toHaveCount(1);
    await shelf.locator(".patch").first().click();
    await expect.poll(() => page.evaluate(() => location.hash)).toBe("#solve:5x5:xH1HAA&t=Plus%20%3Cb%3E&a=%C3%85sa");
  });
});

test.describe("dialogs", () => {
  const save = gameSave({ skeins: 17, solved: solved(["cup-5", "heart-5"], 2), daily: { last: "2026-10-11", streak: 2, best: 5 }, ach: { first: "2026-10-10" } });
  test.beforeEach(async ({ page }) => {
    await seedGameSave(page, save);
    await open(page);
  });

  test("Achievements lists all eight, closes on Esc and returns focus", async ({ page }) => {
    const opener = page.locator("#q-achievements");
    await expect(opener).toContainText("1 of 8");
    await opener.click();
    const dialog = page.locator("#achievements");
    await expect(dialog).toBeVisible();
    await expect(dialog.locator("li")).toHaveCount(8);
    await expect(dialog.locator("li.earned")).toHaveCount(1);
    await expect(dialog).toContainText("Earned 2026-10-10");
    await expect(dialog).toContainText("5 of 7 so far"); // best streak towards a week
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(opener).toBeFocused();
  });

  test("focus stays inside an open dialog", async ({ page }) => {
    await page.locator("#q-progress").click();
    const dialog = page.locator("#progress");
    await expect(dialog).toBeVisible();
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press("Tab");
      // Focus is in the dialog, or on the body while it is on the browser's own controls; never on the page behind.
      expect(await page.evaluate(() => document.activeElement === document.body || !!document.activeElement.closest("dialog"))).toBe(true);
    }
    await page.keyboard.press("Escape");
    await expect(page.locator("#q-progress")).toBeFocused();
  });

  test("Download save gives the save as valid JSON named by date", async ({ page }) => {
    await page.locator("#q-progress").click();
    const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Download save" }).click()]);
    expect(download.suggestedFilename()).toMatch(/^hugi-save-\d{4}-\d{2}-\d{2}\.json$/);
    const text = readFileSync(await download.path(), "utf8");
    const parsed = JSON.parse(text);
    expect(parsed.v).toBe(1);
    expect(Object.keys(parsed.solved).sort()).toEqual(["cup-5", "heart-5"]);
    expect(parsed.skeins).toBe(17);
    await expect(page.locator("#progress [role=status]")).toContainText("Downloaded hugi-save-");
  });

  test("Load save round trip: both counts are named, then the quilt changes", async ({ page }) => {
    const other = gameSave({ skeins: 9, solved: solved(["cup-5", "heart-5", "tree-5", "boat-6"]), daily: { last: null, streak: 0, best: 0 } });
    await page.locator("#q-progress").click();
    await page.getByRole("button", { name: "Load save", exact: true }).click();
    await page.locator("#load-text").fill(JSON.stringify(other));
    await page.getByRole("button", { name: "Load", exact: true }).click();
    const dialog = page.locator("#progress");
    await expect(dialog).toContainText("You have 2 solved pictures now. This save has 4 solved pictures.");
    await expect(page.getByRole("button", { name: "Keep mine" })).toBeFocused();
    await page.getByRole("button", { name: "Load this save" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.locator(".patch.solved")).toHaveCount(4);
    await expect(page.locator("#skeins")).toHaveText("9");
    expect((await savedGame(page)).skeins).toBe(9);
    await expect(page.locator("#q-progress")).toBeFocused();
  });

  test("Load save loads a file, and shows why a bad one is refused", async ({ page }) => {
    await page.locator("#q-progress").click();
    await page.getByRole("button", { name: "Load save", exact: true }).click();
    await page.locator("#load-text").fill("this is not a save");
    await page.getByRole("button", { name: "Load", exact: true }).click();
    await expect(page.locator("#progress .error")).toHaveText(/not readable JSON/);
    await page.locator("#load-file").setInputFiles({ name: "save.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(gameSave({ solved: solved(["cup-5"]) }))) });
    await expect(page.locator("#load-text")).toHaveValue(/"cup-5"/);
    await page.getByRole("button", { name: "Load", exact: true }).click();
    await expect(page.locator("#progress")).toContainText("This save has 1 solved picture.");
    await page.getByRole("button", { name: "Keep mine" }).click();
    expect((await savedGame(page)).skeins).toBe(17); // nothing changed
  });

  test("Start over asks first, then erases", async ({ page }) => {
    await page.locator("#q-progress").click();
    await page.getByRole("button", { name: "Start over" }).click();
    await expect(page.locator("#progress")).toContainText("This erases 2 solved pictures, 17 skeins");
    await page.getByRole("button", { name: "Keep my quilt" }).click();
    expect(Object.keys((await savedGame(page)).solved)).toHaveLength(2);
    await page.getByRole("button", { name: "Start over" }).click();
    await page.getByRole("button", { name: "Erase everything" }).click();
    await expect(page.locator("#progress")).toHaveCount(0);
    await expect(page.locator(".patch.solved")).toHaveCount(0);
    await expect(page.locator(".q-prompt")).toBeVisible();
    const after = await savedGame(page);
    expect(after.solved).toEqual({});
    expect(after.skeins).toBe(5);
  });
});

for (const theme of ["light", "dark"]) {
  test.describe(`layout (${theme})`, () => {
    test.beforeEach(async ({ page }) => {
      await seedGameSave(page, gameSave({ solved: solved(["cup-5", "heart-5"], 2), progress: { "tree-5": { cells: "AAAA", seconds: 4, helped: false, at: 1 } } }));
      await open(page, { theme });
    });

    test("no sideways scroll", async ({ page }) => {
      await expectNoHorizontalScroll(page);
    });

    test("every control is at least 44 px on touch", async ({ page }, info) => {
      test.skip(!["phone", "small-phone", "tablet"].includes(info.project.name), "pointer: coarse projects only");
      expect(await smallTargets(page, 44, { scope: "#view-play" })).toEqual([]);
    });

    test("text is at least 4.5:1", async ({ page }) => {
      const rows = await contrastOf(page, ".q-blurb, .q-count, .q-daily p, .q-head h2, .q-tier:not(.locked) .patch .sz, .q-tier:not(.locked) .patch .num, .q-tier:not(.locked) .patch .under, .q-title");
      const low = rows.filter((r) => r.ratio < 4.5).map((r) => `${r.what} ${r.ratio.toFixed(2)}`);
      expect(low).toEqual([]);
    });
  });
}

test("no sideways scroll with the real pack on every size", async ({ page }) => {
  await openApp(page, "");
  await expect(page.locator(".q-page")).toBeVisible();
  await expectNoHorizontalScroll(page);
});
