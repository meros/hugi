# End-to-end tests

Browser tests of the Hugi web app with Playwright, mobile first. Every spec runs on four projects:

| project | viewport | input |
|---|---|---|
| `phone` | 360x740, scale 3 | touch |
| `small-phone` | 320x568, scale 3 | touch |
| `tablet` | 768x1024, scale 2 | touch |
| `desktop` | 1280x800 | mouse |

## Run

Needs `web/hugi_web.wasm` (`web/build.sh`).

```sh
web/e2e/nix-test.sh                       # NixOS: everything, all projects
web/e2e/nix-test.sh --project=phone       # one project
web/e2e/nix-test.sh tests/board.spec.mjs  # one file
```

Elsewhere: `cd web/e2e && npm ci && npx playwright install chromium && npx playwright test`.
The config serves `web/` with `static-server.mjs` (a plain node server; it sends `application/wasm`, which
`WebAssembly.compileStreaming` needs).

`@playwright/test` is pinned to 1.63.0, the version of `nixpkgs#playwright-driver`, so the nix-store
browsers work. When you bump nixpkgs, bump the pin (`nix eval --raw nixpkgs#playwright-driver.version`).
`CHROME_PATH` overrides the browser (`nix-test.sh` sets it to the nix-store headless shell).

## Specs

| file | covers |
|---|---|
| `router.spec.mjs` | hash router, legacy share links, nav, theme persistence |
| `maker.spec.mjs` | draw by touch and mouse, clear, examples, import, share round trip, Copy link |
| `board.spec.mjs` | `web/test/board.html`: fill, mark, axis lock, undo and redo, keyboard, clue colours, reveal, 40x40 scroll |
| `layout.spec.mjs` | no sideways scroll, tap targets, clipped text, contrast, reduced motion, dialog |
| `screens.spec.mjs` | full-page screenshots into `screens/` (git-ignored) and colour and geometry checks |

Every test also fails on a `console.error`, an uncaught page error, a failed request or an HTTP status of 400
or more (the `problems` fixture in `helpers/fixtures.mjs`).

`test.fixme` entries name the reason: a defect in a file this directory does not own, or a screen that is not
built yet. Enable them when the cause is fixed. Screens to enable when they land: Play quilt (WP7a),
puzzle screen (WP7b), shared puzzle (WP9). `helpers/app.mjs` has `seedGameSave` for a fixture save.

## Screenshots, and why there are no pixel baselines

`screens.spec.mjs` writes `screens/<project>-<view>-<day|night>.png` for every view. Look at them after a
layout change. Fonts differ between machines and CI (the page uses Palatino or URW Palladio, then Georgia),
and the board animates, so a pixel diff would fail on font alone. The tests assert computed geometry and
colours instead. If you add `toHaveScreenshot`, restrict it to one project and one OS, and make the
baselines there.
