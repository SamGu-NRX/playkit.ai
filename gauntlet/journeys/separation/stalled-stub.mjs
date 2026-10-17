#!/usr/bin/env node
/**
 * stalled-stub.mjs — journey D helper for the separation journey.
 *
 * An Anthropic-Messages-shaped HTTP stub that accepts a request and NEVER
 * replies: it holds the connection open so the episode can only end through
 * `--episode-time-limit-ms`. It logs the request and, when the runner's
 * abort closes the connection under it (the #103 dispose-and-abort path),
 * it logs that the client closed the connection.
 *
 * Listens on 127.0.0.1 only, validates no API key, makes no outbound
 * requests, and spends nothing.
 *
 * Usage: node stalled-stub.mjs --port 8092 [--log <file>]
 *
 * @module
 */

import http from 'node:http';
import { appendFileSync } from 'node:fs';

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const port = Number(flag('port') ?? 8092);
const logFile = flag('log');

/** @param {string} line */
function log(line) {
  const stamped = `${new Date().toISOString()} ${line}`;
  console.log(stamped);
  if (logFile) appendFileSync(logFile, `${stamped}\n`);
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && (req.url === '/ping' || req.url === '/v1/ping')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
    return;
  }
  let body = '';
  req.on('data', (chunk) => {
    body += chunk;
  });
  req.on('end', () => {
    log(
      `stall: ${req.method} ${req.url} accepted (${body.length} bytes) — holding the connection open, no reply will be sent`
    );
    const closed = () => {
      log(
        'stall: connection closed by the client before any reply (the runner aborted the in-flight call)'
      );
    };
    req.on('close', () => {
      // 'close' fires on normal completion too; with no reply ever written it
      // can only mean the client went away.
      closed();
    });
    // Deliberately never call res.end(): the reply stalls forever.
  });
});

server.listen(port, '127.0.0.1', () => {
  log(`stalled-stub listening on http://127.0.0.1:${port} (never replies)`);
});
