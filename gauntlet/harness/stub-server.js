/**
 * Test-only local stub servers for the provider APIs. node:http on
 * 127.0.0.1 with an ephemeral port; nothing leaves the machine and no test
 * makes a paid call. Imported only by *.test.js files.
 *
 * @module
 */

import http from 'node:http';

/**
 * Start a stub server. The handler receives (req, res, parsedBody, rawBody)
 * and may be async; an unhandled handler error becomes an HTTP 500 carrying
 * the message so the test fails visibly.
 *
 * @param {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, body: *, raw: string) => void | Promise<void>} handler
 * @returns {Promise<{ server: import('node:http').Server, url: string, close: () => Promise<void> }>}
 */
export function startStubServer(handler) {
  return new Promise((resolve, reject) => {
    /** @type {import('node:http').Server | null} */
    let server = null;
    server = http.createServer((req, res) => {
      /** @type {Buffer[]} */
      const chunks = [];
      req.on('data', (chunk) => chunks.push(/** @type {Buffer} */ (chunk)));
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let body = null;
        try {
          body = JSON.parse(raw);
        } catch {
          body = null;
        }
        Promise.resolve(handler(req, res, body, raw)).catch((err) => {
          if (!res.headersSent) {
            res.writeHead(500, { 'content-type': 'application/json' });
          }
          res.end(JSON.stringify({ stubServerError: String(err instanceof Error ? err.message : err) }));
        });
      });
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = /** @type {import('node:net').AddressInfo} */ (server?.address());
      resolve({
        server: /** @type {import('node:http').Server} */ (server),
        url: `http://127.0.0.1:${address.port}`,
        close: () =>
          new Promise((resolveClose, rejectClose) => {
            /** @type {import('node:http').Server} */ (server).close((err) =>
              err ? rejectClose(err) : resolveClose()
            );
          }),
      });
    });
  });
}

/**
 * Send a JSON response and end it.
 *
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {*} payload
 * @returns {void}
 */
export function sendJson(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
}
