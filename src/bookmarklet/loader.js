// Bookmarklet loader for 2048 HUD
// Usage: host a minified bundle (same code as src/extension/content.js wrapped in an IIFE)
// and paste this as a bookmark URL after replacing CDN_URL.

/*
javascript:(async()=>{const src='CDN_URL/2048-hud.min.js';try{if(!window.__T48__){let s=document.createElement('script');s.src=src;s.async=true;s.onload=()=>console.log('HUD loaded');document.documentElement.appendChild(s);}else{window.__T48__.toggle();}}catch(e){alert('Load failed: '+e);}})();
*/

// Hosting layout (required by the WASM engine):
//   CDN_URL/2048-hud.min.js   the bookmarklet bundle (dist/2048-hud.min.js)
//   CDN_URL/wasm/solver.mjs   Emscripten glue      (dist/wasm/solver.mjs)
//   CDN_URL/wasm/solver.wasm  compiled solver      (dist/wasm/solver.wasm)
//
// The bundle resolves both solver assets against its own script URL (the bundle
// origin), not against the host page's base URI — a page at /2048/ therefore
// never asks its own origin for /2048/solver.mjs. `node scripts/build-phase0.js`
// produces exactly this dist/ layout (bundle at dist/2048-hud.min.js, assets at
// dist/wasm/). Serve CDN_URL with `Access-Control-Allow-Origin: *` so the
// cross-origin module import and fetch succeed.

// See src/extension/README.md for build/hosting notes.
