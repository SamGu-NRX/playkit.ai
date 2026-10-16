/**
 * Unit: bounded model calls. `--call-timeout-ms` bounds one provider attempt
 * with an AbortSignal: against a stub that never answers, the call fails
 * after timeout x (retries + 1), the episode is recorded failed and never
 * scored, and the error names the provider, the model and the timeout.
 * `--max-output-tokens` reaches the wire as the request's max_tokens. Both
 * settings are recorded in run.json's `limits`.
 *
 * Local hanging server on 127.0.0.1 only; no paid calls.
 *
 * @module
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { buildSuite } from '../scoring/suite.js';
import { takeOrPass } from '../scoring/fixtures.js';
import { createModelAgent } from '../harness/model-agent.js';
import { getGame } from '../games/index.js';
import { runSuite } from './run.js';

const gauntletRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const cli = join(gauntletRoot, 'cli', 'gauntlet.js');

const SUITE = buildSuite([takeOrPass], { split: 'public' });
const GAMES = [takeOrPass];

// The CLI resolves the manifest's games through the registered game registry,
// so the subprocess leg needs a registered game: cube, limited to one seed per
// tier (--limit 1, four episodes) because a hanging provider fails slowly.
const CLI_SUITE = buildSuite([getGame('cube')], { split: 'public' });

/**
 * A local HTTP server that reads every request body and never answers. Its
 * sockets are tracked so close() can tear the connections down instead of
 * waiting on them.
 *
 * @param {(raw: string) => void} [onBody]
 * @returns {Promise<{ url: string, close: () => Promise<void> }>}
 */
async function startHangingStub(onBody) {
  /** @type {Set<import('node:net').Socket>} */
  const sockets = new Set();
  const server = createServer((req, res) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      if (onBody) onBody(raw);
      // Never respond: the point of the stub.
    });
  });
  server.on('connection', (socket) => sockets.add(socket));
  await new Promise((resolve, reject) => {
    server.once('listening', () => resolve(undefined));
    server.once('error', reject);
    server.listen(0, '127.0.0.1');
  });
  const address = /** @type {import('node:net').AddressInfo} */ (server.address());
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

test('a call that never answers fails the episode within timeout x (retries + 1) plus 5 s', { timeout: 60 * 1000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'gauntlet-limits-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  /** @type {string[]} */
  const bodies = [];
  const stub = await startHangingStub((raw) => bodies.push(raw));
  t.after(() => stub.close());

  const started = Date.now();
  const result = await runSuite({
    suite: SUITE,
    games: GAMES,
    outDir: dir,
    // Mirror the CLI, which passes both flags to the engine as well: run.json
    // records the configuration the run was given, alongside what the agent
    // layer enforces.
    maxOutputTokens: 77,
    callTimeoutMs: 200,
    concurrency: 2,
    agentFactory: () =>
      createModelAgent({
        provider: 'openai-chat',
        model: 'limits-model',
        baseUrl: stub.url,
        maxOutputTokens: 77,
        callTimeoutMs: 200,
        // Instant backoff keeps the test fast; the attempt bound itself is
        // what is under test.
        sleep: async () => {},
      }),
  });
  const elapsed = Date.now() - started;

  assert.equal(result.run.counts.failed, 2, 'both episodes failed');
  assert.equal(result.run.counts.played, 0, 'no episode was scored');
  assert.equal(result.stopped, null, 'episode failures do not stop the run');
  assert.ok(
    elapsed < 200 * (3 + 1) + 5000,
    `the run ended within timeout x (retries + 1) plus 5 s (took ${elapsed} ms)`
  );
  const error = result.failed[0]?.error ?? '';
  assert.match(error, /model agent: openai-chat/);
  assert.match(error, /"limits-model"/);
  assert.match(error, /timed out after 200ms/);
  assert.match(error, /after 3 retries/);
  // max_output_tokens reached the wire even though no answer ever came.
  assert.ok(bodies.length >= 2, 'the stub saw the attempts');
  for (const raw of bodies) {
    assert.equal(JSON.parse(raw).max_tokens, 77, 'every attempt sends max_tokens 77');
  }
  assert.equal(result.run.limits.maxOutputTokens, 77);
  assert.equal(result.run.limits.callTimeoutMs, 200);
});

test('run --max-output-tokens and --call-timeout-ms plumb through the CLI to the wire and run.json', { timeout: 60 * 1000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'gauntlet-limits-cli-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  /** @type {string[]} */
  const bodies = [];
  const stub = await startHangingStub((raw) => bodies.push(raw));
  t.after(() => stub.close());

  const suiteFile = join(dir, 'suite.json');
  await writeFile(suiteFile, JSON.stringify(CLI_SUITE, null, 2) + '\n');

  const started = Date.now();
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      cli, 'run',
      '--suite', suiteFile,
      '--agent', 'model:openai-chat/limits-model',
      '--base-url', stub.url,
      '--out', join(dir, 'run'),
      '--limit', '1',
      '--max-output-tokens', '77',
      '--call-timeout-ms', '100',
      '--concurrency', '2',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
  const elapsed = Date.now() - started;

  const record = JSON.parse(await readFile(join(dir, 'run', 'run.json'), 'utf8'));
  assert.equal(record.counts.failed, 4, 'every episode fails (--limit 1 on cube: four episodes)');
  assert.equal(record.counts.played, 0, 'no episode was scored');
  assert.ok(
    elapsed < 3 * (100 * (3 + 1) + 5000),
    'the subprocess ended within episodes x (timeout x (retries + 1) plus 5 s)'
  );
  const error = record.failed[0]?.error ?? '';
  assert.match(error, /model agent: openai-chat/);
  assert.match(error, /"limits-model"/);
  assert.match(error, /timed out after 100ms/);
  assert.ok(bodies.length >= 3, 'the stub saw the attempts');
  for (const raw of bodies) {
    assert.equal(JSON.parse(raw).max_tokens, 77, 'the CLI flag reaches the wire as max_tokens');
  }
  assert.equal(record.limits.maxOutputTokens, 77, 'run.json records the output-token cap');
  assert.equal(record.limits.callTimeoutMs, 100, 'run.json records the call timeout');
});
