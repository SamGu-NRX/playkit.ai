2048 HUD Solver (MV3)

What’s included
- `manifest.json`: MV3 manifest to inject a content script on all pages.
- `content.js`: Shadow‑DOM HUD, detectors (play2048 + generic numeric), and a naive driver that dispatches arrow keys and synthetic swipes.

Load as an unpacked extension
1. Open Chrome/Edge/Brave → `chrome://extensions`.
2. Enable Developer mode.
3. Click “Load unpacked” and select this directory: `src/extension`.
4. Visit a 2048 page (e.g., play2048.co) → click “Detect” then “Auto‑solve”.

Notes
- HUD runs in a Shadow DOM with a high `z-index` and is draggable.
- Adapters are pluggable. To add one, push an object with `canAttach`, `readBoard`, `sendMove` into the `adapters` array in `content.js`.
- The driver throttles to ~130ms per attempt and only advances when the board DOM changes.
- For mobile-only clones, `sendMove` also simulates a swipe gesture.

Bookmarklet (optional)
- See `src/bookmarklet/loader.js` for a bookmarklet loader. You’ll need to host a minified build of `content.js` and replace `CDN_URL` in the snippet.

Future integration with C++/WASM
- The existing C++ solver in `solver/` can be compiled to WebAssembly and integrated behind the HUD. The current content script isolates the UI/driver so a WASM solver can be swapped in later via a small interface.

