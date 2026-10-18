/**
 * Unit tests for the `gauntlet estimate` CLI stage (cli/estimate.js).
 *
 * What is pinned here is the STREAM CONTRACT: with --json the estimate JSON
 * is the only thing on stdout (so `gauntlet estimate --json | jq` parses),
 * and diagnostics — an unpriced-model note, the written-files line — go to
 * stderr. The estimate numbers themselves are runs/estimate.js's concern and
 * are pinned there.
 */

import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { getGame } from '../games/index.js';
import { buildSuite } from '../scoring/suite.js';
import { buildEstimate } from './estimate.js';

const SUITE = buildSuite([getGame('cube')], { split: 'public' });

/**
 * Capture one buildEstimate call's stdout and stderr separately by
 * temporarily swapping the process streams' write methods (the CLI writes
 * through `process.stdout.write` directly, not a pluggable logger).
 *
 * @param {Parameters<typeof buildEstimate>[0]} options
 * @returns {Promise<{ stdout: string, stderr: string, estimate: * }>}
 */
async function capture(options) {
  /** @type {string[]} */
  const out = [];
  /** @type {string[]} */
  const err = [];
  const realOut = process.stdout.write.bind(process.stdout);
  const realErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = (/** @type {*} */ chunk) => {
    out.push(String(chunk));
    return true;
  };
  process.stderr.write = (/** @type {*} */ chunk) => {
    err.push(String(chunk));
    return true;
  };
  try {
    const estimate = await buildEstimate(options);
    return { stdout: out.join(''), stderr: err.join(''), estimate };
  } finally {
    process.stdout.write = realOut;
    process.stderr.write = realErr;
  }
}

test('--json prints ONLY the estimate on stdout; an unpriced-model note goes to stderr', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gauntlet-estimate-'));
  const suitePath = join(dir, 'suite.json');
  const pricesPath = join(dir, 'prices.json');
  await writeFile(suitePath, JSON.stringify(SUITE));
  await writeFile(
    pricesPath,
    JSON.stringify({ 'other-provider/other-model': { inPerMtok: 1, outPerMtok: 2 } })
  );

  const { stdout, stderr } = await capture({
    suitePath,
    agentSpecText: 'model:openai-chat/stub-model',
    prices: pricesPath,
    noProbes: true,
    json: true,
  });

  // stdout parses as exactly the estimate — no note mixed in.
  const parsed = JSON.parse(stdout);
  assert.ok(parsed && typeof parsed === 'object');
  assert.ok(stderr.includes('note:'), `the unpriced note belongs on stderr, got: ${stderr}`);
  assert.match(stderr, /openai-chat\/stub-model/);
});

test('default output: stdout is pure Markdown, nothing else touches it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gauntlet-estimate-'));
  const suitePath = join(dir, 'suite.json');
  await writeFile(suitePath, JSON.stringify(SUITE));

  const { stdout, stderr } = await capture({
    suitePath,
    agentSpecText: 'model:openai-chat/stub-model',
    noProbes: true,
  });

  assert.ok(stdout.includes('|'), 'stdout is the markdown estimate table');
  assert.equal(stderr, '');
});

test('--out writes the bundle and reports it on stderr, stdout stays empty', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gauntlet-estimate-'));
  const suitePath = join(dir, 'suite.json');
  const outDir = join(dir, 'estimate-out');
  await writeFile(suitePath, JSON.stringify(SUITE));

  const { stdout, stderr } = await capture({
    suitePath,
    agentSpecText: 'model:openai-chat/stub-model',
    noProbes: true,
    outDir,
  });

  assert.equal(stdout, '', 'nothing on stdout when the estimate is written to files');
  assert.match(stderr, /wrote .*estimate\.json and .*estimate\.md/);
});
