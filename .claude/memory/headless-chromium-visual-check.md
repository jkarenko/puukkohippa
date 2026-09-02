---
name: headless-chromium-visual-check
description: How to screenshot the running game headlessly on this machine (Playwright Chromium cache lacks nss libs; fetch them without root)
metadata:
  type: reference
---

Playwright's Chromium is cached at `~/.cache/ms-playwright/chromium_headless_shell-1234/` but
`libnss3` / `libnspr4` are not installed system-wide, so it fails to launch.

**How to apply:** without sudo, run `apt-get download libnss3 libnspr4` into the scratchpad,
`dpkg -x` each .deb, then launch with `LD_LIBRARY_PATH=<extracted>/usr/lib/x86_64-linux-gnu`
and `executablePath` pointing at `chrome-headless-shell-linux64/chrome-headless-shell`
via a scratchpad-local `playwright-core`. Add `--use-gl=swiftshader --enable-unsafe-swiftshader`.
Serve the game from `PORT=8799 pnpm exec tsx server/index.ts` after `pnpm build`.
Keyboard joins are reliable only in the foreground tab; use raw WebSocket clients
(Node's global `WebSocket`) to test multi-client rooms instead of multiple tabs.
