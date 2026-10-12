#!/usr/bin/env bash
# Run the e2e tests on NixOS, where no browser is installed globally. Arguments go to `playwright test`.
#   web/e2e/nix-test.sh --project=phone
# Needs web/hugi_web.wasm (web/build.sh). Elsewhere run `npx playwright test` after `npx playwright install chromium`.
set -euo pipefail
cd "$(dirname "$0")"
browsers=$(nix eval --raw nixpkgs#playwright-driver.browsers)
shell=$(find -L "$browsers" -maxdepth 3 -type f -name chrome-headless-shell -print -quit)
exec nix shell nixpkgs#nodejs_22 --command env \
  PLAYWRIGHT_BROWSERS_PATH="$browsers" PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS=true \
  PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 CHROME_PATH="$shell" \
  npx playwright test "$@" </dev/null
