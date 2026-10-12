// The test object of all specs. It collects console errors, uncaught page errors, failed requests and
// HTTP errors, and fails the test at the end when there is one. A spec that expects an error pushes a
// RegExp to `allowed`.
import { test as base, expect } from "@playwright/test";

export const test = base.extend({
  allowed: [async ({}, use) => use([]), { auto: false }],
  problems: [
    async ({ page, allowed }, use) => {
      const found = [];
      const note = (kind, text) => {
        if (!allowed.some((re) => re.test(text))) found.push(`${kind}: ${text}`);
      };
      page.on("console", (m) => m.type() === "error" && note("console.error", m.text()));
      page.on("pageerror", (e) => note("pageerror", e.message));
      page.on("requestfailed", (r) => note("requestfailed", `${r.url()} ${r.failure()?.errorText}`));
      page.on("response", (r) => r.status() >= 400 && note("http " + r.status(), r.url()));
      await use(found);
      expect(found, "console errors, page errors and failed requests").toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };
