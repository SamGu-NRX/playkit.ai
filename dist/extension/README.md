2048 AI Solver — MV3 package

What ships in `src/extension/`
- `manifest.json`: MV3 manifest with targeted host permissions for common 2048 implementations and `<all_urls>` access only for static assets (`web_accessible_resources`).
- `content.js`: Bundle generated from the shared runtime (`node scripts/build-phase0.js`). Contains the Shadow DOM HUD, adapter registry, driver, mutation observer, and runtime glue.
- `assets/` & `wasm/`: Staging folders for icons or compiled WebAssembly binaries; everything under these directories is copied into the `dist/extension` package.

Rebuilding & packaging
1. Run `node scripts/build-phase0.js` from the repository root.
2. The script rebuilds `src/extension/content.js`, produces bookmarklet outputs in `dist/`, and mirrors the MV3 payload into `dist/extension` (manifest, content script, static assets).
3. Zip `dist/extension` if you need an installable archive (`zip -r dist/2048-ai-solver.zip dist/extension`).

Load as an unpacked extension
1. Chrome/Edge/Brave → open `chrome://extensions` and enable *Developer mode*.
2. Click **Load unpacked** and point to either `src/extension` (dev flow) or `dist/extension` (build artifact).
3. Navigate to a supported 2048 board (e.g., `https://play2048.co`, `https://mitchgu.github.io/GetMIT/`). The HUD exposes *Detect*, *Auto-solve*, *Step*, and direction priority controls.

Parity & performance notes
- Shared runtime: bookmarklet (`dist/2048-hud.min.js`) and MV3 content script originate from the same source modules, preventing logic drift.
- Runtime size: `dist/extension/content.js` is ~121 KB uncompressed (~22 KB gzipped) and has no third-party dependencies or network calls.
- Host scope: content scripts are limited to URLs that contain “2048” plus the explicit target hosts. Adjust `manifest.json` if you need broader detection.
- WASM solver: run `node scripts/build-wasm.js --release` to compile the C++ solver (requires `emcc`). The generated `solver.mjs`/`solver.wasm` land in `src/extension/wasm/` and are copied into the MV3 package on the next `build-phase0` run.

Bookmarklet (optional)
- See `src/bookmarklet/loader.js` for a bookmarklet loader. Host `dist/2048-hud.min.js` and update the CDN placeholder accordingly.
