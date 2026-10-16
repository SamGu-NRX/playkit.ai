// Bookmarklet loaders for the 2048 HUD.
//
// 1. SELF-CONTAINED (default — no host): dist/2048-hud-bookmarklet.txt
//
//    Built by `node scripts/build-phase0.js` from src/bookmarklet/standalone.js.
//    One single-line javascript: URL that carries the whole runtime AND the
//    WASM solver (solver.mjs + solver.wasm, base64-inlined), so it needs no
//    host, CDN, or extension. Install:
//
//      a. Create a new bookmark in your browser.
//      b. Paste the entire contents of dist/2048-hud-bookmarklet.txt as the
//         bookmark's URL (~450 KB; the payload is plain base64 wrapped in
//         atob()+eval(), which survives browser URL normalization untouched).
//      c. Open a 2048 page and click the bookmark. The HUD auto-detects the
//         game and the solver reports "WASM ready" — the full-strength
//         engine, not the JS fallback.
//
//    The URL form: javascript:(function(){(0,eval)(atob("<base64>"))})();
//    Everything inside the quotes is the standalone bundle from
//    dist/2048-hud-standalone.js; see src/extension/README.md for details.
//
// 2. HOSTED (small URL — needs a static file server):
//
/*
javascript:(async()=>{const src='CDN_URL/2048-hud.min.js';try{if(!window.__T48__){let s=document.createElement('script');s.src=src;s.async=true;s.onload=()=>console.log('HUD loaded');document.documentElement.appendChild(s);}else{window.__T48__.toggle();}}catch(e){alert('Load failed: '+e);}})();
*/
//
//    Hosting layout (required by the WASM engine):
//      CDN_URL/2048-hud.min.js   the bookmarklet bundle (dist/2048-hud.min.js)
//      CDN_URL/wasm/solver.mjs   Emscripten glue      (dist/wasm/solver.mjs)
//      CDN_URL/wasm/solver.wasm  compiled solver      (dist/wasm/solver.wasm)
//
//    The bundle resolves both solver assets against its own script URL (the bundle
//    origin), not against the host page's base URI — a page at /2048/ therefore
//    never asks its own origin for /2048/solver.mjs. `node scripts/build-phase0.js`
//    produces exactly this dist/ layout (bundle at dist/2048-hud.min.js, assets at
//    dist/wasm/). Serve CDN_URL with `Access-Control-Allow-Origin: *` so the
//    cross-origin module import and fetch succeed.
//
// Prefer form 1 unless you specifically need a tiny URL: the hosted form is
// the one that silently fell back to the JS engine when solver.wasm was not
// reachable from the bookmarklet's injection context (PR #86 journey F).

// See src/extension/README.md for build and install notes.
