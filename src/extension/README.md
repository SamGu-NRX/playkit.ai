2048 HUD Solver (MV3)

What’s included
- `manifest.json`: MV3 manifest to inject a content script on all pages.
- `content.js`: Generated bundle from the shared runtime (`node scripts/build-phase0.js`). Includes the Shadow DOM HUD, adapter registry, driver, mutation observer, and runtime glue code.

Load as an unpacked extension
1. Open Chrome/Edge/Brave → `chrome://extensions`.
2. Enable Developer mode.
3. Click “Load unpacked” and select this directory: `src/extension`.
4. Visit a 2048 page (e.g., play2048.co) → click “Detect” then “Auto‑solve”.

Notes
- HUD runs in a Shadow DOM with a high `z-index` and is draggable.
- Extend functionality by editing the source modules in `src/` (e.g., `src/adapters`, `src/hud`, `src/runtime`) and regenerate the bundle via `node scripts/build-phase0.js`.
- The driver throttles to ~130ms per attempt and only advances when the board DOM changes.
- For mobile-only clones, adapters also simulate swipe gestures when available.

Bookmarklet (optional)
- See `src/bookmarklet/loader.js` for a bookmarklet loader. You’ll need to host a minified build of `content.js` and replace `CDN_URL` in the snippet.

Future integration with C++/WASM
- The existing C++ solver in `solver/` can be compiled to WebAssembly and integrated behind the HUD. The current content script isolates the UI/driver so a WASM solver can be swapped in later via a small interface.
