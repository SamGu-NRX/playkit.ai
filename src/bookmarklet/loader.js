// Bookmarklet loader for 2048 HUD
// Usage: host a minified bundle (same code as src/extension/content.js wrapped in an IIFE)
// and paste this as a bookmark URL after replacing CDN_URL.

/*
javascript:(async()=>{const src='CDN_URL/2048-hud.min.js';try{if(!window.__T48__){let s=document.createElement('script');s.src=src;s.async=true;s.onload=()=>console.log('HUD loaded');document.documentElement.appendChild(s);}else{window.__T48__.toggle();}}catch(e){alert('Load failed: '+e);}})();
*/

// See src/extension/README.md for build/hosting notes.

