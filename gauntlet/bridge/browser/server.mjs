/**
 * Local static server for the browser bridge fixture. Binds 127.0.0.1 only —
 * the browser tests must never talk to anything else.
 *
 * Routes:
 *  - `/gauntlet/<path>`  the repo's `gauntlet/` package (so the page can
 *    `import('/gauntlet/bridge/session.js')` and play a bridge session in the
 *    page, through the real overlay code);
 *  - `/bookmarklet/2048-hud.min.js` the bookmarklet bundle built by the
 *    repo's own bundler (`scripts/build-phase0.js` → `dist/2048-hud.min.js`);
 *  - `/2048/<path>`      the vendored game (`vendor/2048/`, pin in
 *    `vendor/PIN.md`), served verbatim;
 *  - `/2048-faulty/<path>` the same vendored tree with exactly one line of
 *    `js/game_manager.js` patched through `faulty-copy.mjs`.
 *
 * @module
 */

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { patchGameManagerSource } from './faulty-copy.mjs';

const thisDir = fileURLToPath(new URL('.', import.meta.url));
const browserPkgDir = resolve(thisDir);
/** Repo root: gauntlet/bridge/browser → up three levels. */
export const repoRoot = resolve(browserPkgDir, '..', '..', '..');
const vendorRoot = resolve(browserPkgDir, 'vendor', '2048');
const gauntletRoot = resolve(repoRoot, 'gauntlet');
const srcRoot = resolve(repoRoot, 'src');
const bookmarkletBundlePath = resolve(repoRoot, 'dist', '2048-hud.min.js');

/** @type {Record<string, string>} */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.md': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

/**
 * Resolve a URL path inside a root directory, refusing traversal outside it.
 *
 * @param {string} urlPath e.g. `/2048/js/game_manager.js`
 * @param {string} root Absolute root directory.
 * @returns {string | null} Absolute file path, or null when out of bounds.
 */
function safeJoin(urlPath, root) {
  const relative = decodeURIComponent(urlPath).replace(/^\//, '');
  const target = normalize(join(root, relative));
  if (target !== root && !target.startsWith(root + sep)) return null;
  return target;
}

/**
 * @param {string} urlPath
 * @returns {{ file: string, patch?: boolean } | null}
 */
function route(urlPath) {
  if (urlPath === '/bookmarklet/2048-hud.min.js') {
    return { file: bookmarkletBundlePath };
  }
  if (urlPath === '/2048/' || urlPath === '/2048') {
    return { file: join(vendorRoot, 'index.html') };
  }
  if (urlPath.startsWith('/2048/')) {
    const file = safeJoin(urlPath.slice('/2048/'.length), vendorRoot);
    return file === null ? null : { file };
  }
  if (urlPath === '/2048-faulty/' || urlPath === '/2048-faulty') {
    return { file: join(vendorRoot, 'index.html'), patch: false };
  }
  if (urlPath.startsWith('/2048-faulty/')) {
    const relative = urlPath.slice('/2048-faulty/'.length);
    const file = safeJoin(relative, vendorRoot);
    if (file === null) return null;
    const patch = relative === 'js/game_manager.js';
    return { file, patch };
  }
  if (urlPath === '/gauntlet/') {
    return { file: join(gauntletRoot, 'index.html') };
  }
  if (urlPath.startsWith('/gauntlet/')) {
    const file = safeJoin(urlPath.slice('/gauntlet/'.length), gauntletRoot);
    if (file === null) return null;
    // Never serve the gauntlet package's own installed dependencies.
    if (!file.startsWith(gauntletRoot + sep) || file.includes(`${sep}node_modules${sep}`)) return null;
    return { file };
  }
  if (urlPath.startsWith('/src/')) {
    // The overlay's own sources under native ESM. The harness uses this to
    // expose the real globalAdapterRegistry before the bundle runs — see
    // the re-export note in harness.mjs.
    const file = safeJoin(urlPath.slice('/src/'.length), srcRoot);
    return file === null ? null : { file };
  }
  return null;
}

/**
 * Start the fixture server on 127.0.0.1 on an ephemeral port.
 *
 * @returns {Promise<{ port: number, close: () => Promise<void> }>}
 */
export async function startFixtureServer() {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const route_ = route(url.pathname);
      if (!route_) {
        res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
        return;
      }
      const info = await stat(route_.file).catch(() => null);
      if (info === null || !info.isFile()) {
        res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
        return;
      }
      let body = await readFile(route_.file);
      if (route_.patch) {
        body = Buffer.from(patchGameManagerSource(body.toString('utf8')), 'utf8');
      }
      res.writeHead(200, {
        'content-type': MIME[extname(route_.file).toLowerCase()] ?? 'application/octet-stream',
        // The fixture pages are local; nothing should be cached across tests.
        'cache-control': 'no-store',
      });
      res.end(body);
    } catch (error) {
      res.writeHead(500, { 'content-type': 'text/plain' }).end(`fixture server error: ${error}`);
    }
  });

  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolveListen(undefined));
  });

  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('fixture server: unexpected address');
  }

  return {
    port: address.port,
    close: () =>
      new Promise((resolveClose, rejectClose) => {
        server.close((error) => (error ? rejectClose(error) : resolveClose(undefined)));
      }),
  };
}

export {};
