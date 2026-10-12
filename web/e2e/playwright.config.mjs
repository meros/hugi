// Mobile first: the phone project is the main one, the others check that nothing breaks at other sizes.
// Every project runs the same specs. CHROME_PATH (a chrome-headless-shell, see README) overrides the browser.
import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.E2E_PORT || 4173);
const executablePath = process.env.CHROME_PATH || undefined;

const touch = { isMobile: true, hasTouch: true, deviceScaleFactor: 3 };
const base = { ...devices["Desktop Chrome"], launchOptions: { executablePath } };

export default defineConfig({
  testDir: "./tests",
  outputDir: "./test-results",
  timeout: 30_000,
  expect: { timeout: 7_000 },
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: { baseURL: `http://127.0.0.1:${PORT}`, trace: "retain-on-failure", serviceWorkers: "block" },
  webServer: {
    command: `node static-server.mjs ${PORT}`,
    url: `http://127.0.0.1:${PORT}/index.html`,
    reuseExistingServer: !process.env.CI,
    timeout: 20_000,
  },
  projects: [
    { name: "phone", use: { ...base, viewport: { width: 360, height: 740 }, ...touch } },
    { name: "small-phone", use: { ...base, viewport: { width: 320, height: 568 }, ...touch } },
    { name: "tablet", use: { ...base, viewport: { width: 768, height: 1024 }, ...touch, deviceScaleFactor: 2 } },
    { name: "desktop", use: { ...base, viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 } },
  ],
});
