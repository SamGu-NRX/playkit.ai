/**
 * Integration: the bundle-wide dollar cap through the real CLI against the
 * local stub provider. A run with `--max-usd-total` stops budget-shaped, the
 * ledger records every call (kept or unwound), a resume without the flag
 * carries the recorded cap, a resume with a new one records the raise, and
 * `bundle verify` checks the ledger against the trajectories — catching a
 * naive ledger edit even after re-chaining.
 *
 * Local stub on 127.0.0.1 only; no paid calls.
 *
 * @module
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { startStubServer, sendJson } from '../../harness/stub-server.js';
import { createHash } from 'node:crypto';

const gauntletRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const cli = join(gauntletRoot, 'cli', 'gauntlet.js');

/**
 * A stub chat-completions server that answers `take` with fixed usage after a
 * short hold — the same shape run-cap.test.js uses: with `--max-output-tokens
 * 10` and `outputPerMTok: 5000`, every call quotes and settles at exactly
 * $0.05.
 *
 * @returns {Promise<{ url: string, close: () => Promise<void> }>}
 */
async function startCapStub() {
  const stub = await startStubServer(
    /** @param {import('node:http').IncomingMessage} _req @param {import('node:http').ServerResponse} res */
    (_req, res) => {
      setTimeout(() => {
        sendJson(res, 200, {
          id: 'chatcmpl-cap',
          object: 'chat.completion',
          created: 1,
          model: 'cap-model',
          choices: [
            { index: 0, message: { role: 'assistant', content: 'take' }, finish_reason: 'stop' },
          ],
          usage: { prompt_tokens: 100, completion_tokens: 10 },
        });
      }, 25);
    }
  );
  return { url: stub.url, close: stub.close };
}

/**
 * Runs the CLI and collects its streams.
 *
 * @param {string[]} args
 * @returns {Promise<{ status: number, stdout: string, stderr: string }>}
 */
function gauntlet(...args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ status: code ?? -1, stdout, stderr }));
  });
}

test('cli run --max-usd-total: budget stop, carried cap, recorded raise, verified ledger', { timeout: 8 * 60 * 1000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'gauntlet-spend-e2e-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const stub = await startCapStub();
  t.after(() => stub.close());

  // 2048: benchmark-true (so bundle verify recomputes the score) and needs no
  // engine binary, and the stub's 'take' is not a legal action anywhere, so
  // every episode takes exactly three priced calls ($0.05 each) and ends in a
  // replay-verifiable forfeit. Deterministic call counts, no engine needed.
  const suiteFile = join(dir, 'suite.json');
  const built = await gauntlet('suite', 'build', '--split', 'public', '--games', '2048', '--seeds-per-tier', '1', '--out', suiteFile);
  assert.equal(built.status, 0, `suite build failed:\n${built.stderr}`);
  const suite = JSON.parse(await readFile(suiteFile, 'utf8'));
  const episodeCount = suite.games.reduce(
    (/** @type {number} */ n, /** @type {*} */ g) => n + g.tiers.reduce(
      (/** @type {number} */ m, /** @type {*} */ tier) => m + tier.seeds.length, 0), 0);
  assert.ok(episodeCount >= 2, 'the smoke game contributes at least two episodes');

  const pricesFile = join(dir, 'prices.json');
  await writeFile(pricesFile, JSON.stringify({
    'openai-chat/cap-model': { inputPerMTok: 0, outputPerMTok: 5000, source: 'stub prices', checked: '2026-10-17' },
  }, null, 2) + '\n');

  const runArgs = [
    'run', '--suite', suiteFile,
    '--agent', 'model:openai-chat/cap-model',
    '--base-url', stub.url,
    '--prices', pricesFile,
    '--max-output-tokens', '10',
    '--out', join(dir, 'run'),
  ];
  const ledgerPath = join(dir, 'run', 'spend.jsonl');

  const readLedger = async () => {
    const text = await readFile(ledgerPath, 'utf8');
    return text.split('\n').filter((l) => l.trim().length > 0).map((l) => JSON.parse(l));
  };

  // 1. A total cap below the full bundle stops budget-shaped with the ledger
  //    written and nothing over the cap.
  const capped = await gauntlet(...runArgs, '--max-usd-total', '0.20');
  assert.equal(capped.status, 1, 'a capped run that cannot finish exits 1');
  assert.match(capped.stdout, /stopped\s+budget/);
  assert.match(capped.stdout, /ledger\s+/, 'the summary reports the bundle ledger');
  const cappedRecord = JSON.parse(await readFile(join(dir, 'run', 'run.json'), 'utf8'));
  assert.equal(cappedRecord.stopped, 'budget');
  assert.equal(cappedRecord.ledger.cap, 0.2);
  assert.ok(cappedRecord.ledger.totalUsd <= 0.2 + 1e-9, 'the ledger never exceeded the total cap');
  assert.ok(cappedRecord.ledger.unwoundCalls >= 1, 'the stop threw away a mid-episode attempt');
  const firstLines = await readLedger();
  assert.equal(firstLines.filter((l) => l.kind === 'cap').length, 1, 'the cap is recorded');
  assert.equal(firstLines.filter((l) => l.kind === 'invocation').length, 1);

  // 2. A resume without the flag carries the recorded cap: nothing new runs.
  const carried = await gauntlet(...runArgs, '--resume');
  assert.equal(carried.status, 1, 'the carried cap still refuses to spend');
  assert.match(carried.stdout, /stopped\s+budget/);
  const carriedRecord = JSON.parse(await readFile(join(dir, 'run', 'run.json'), 'utf8'));
  assert.equal(carriedRecord.limits.maxUsdTotal, 0.2, 'run.json records the carried cap');
  assert.equal(carriedRecord.run ? carriedRecord.run.calls : carriedRecord.calls, 0, 'no call was admitted');
  const carriedLines = await readLedger();
  assert.equal(carriedLines.filter((l) => l.kind === 'invocation').length, 2, 'the refused resume is still recorded');

  // 3. Raising the cap is a recorded ledger fact and lets the bundle finish.
  const raised = await gauntlet(...runArgs, '--resume', '--max-usd-total', '5');
  assert.equal(raised.status, 0, `the raised resume completes:\n${raised.stdout}\n${raised.stderr}`);
  assert.match(raised.stdout, /done\s+every planned episode has a trajectory/);
  const raisedRecord = JSON.parse(await readFile(join(dir, 'run', 'run.json'), 'utf8'));
  assert.equal(raisedRecord.stopped, null);
  assert.equal(raisedRecord.counts.unplayed, 0);
  assert.equal(raisedRecord.limits.maxUsdTotal, 5);
  assert.ok(raisedRecord.ledger.totalUsd <= 5 + 1e-9);
  const raisedLines = await readLedger();
  assert.equal(raisedLines.filter((l) => l.kind === 'cap').length, 2, 'the raise is a recorded fact');
  assert.equal(raisedLines.filter((l) => l.kind === 'invocation').length, 3);

  // 4. The finished bundle verifies, ledger included.
  const verified = await gauntlet('bundle', 'verify', join(dir, 'run'));
  assert.equal(verified.status, 0, `bundle verify failed:\n${verified.stdout}\n${verified.stderr}`);
  assert.match(verified.stdout, /verdict\s+ok/);
  assert.match(verified.stdout, /ledger/);

  // 5. A naive ledger edit (drop a line, re-chain the hashes) still fails:
  //    the kept episode then has trajectory steps no ledger line accounts for.
  const victimIndex = raisedLines.findIndex((l) => l.kind === 'call' && l.kept);
  assert.ok(victimIndex >= 0, 'the ledger has a kept call to drop');
  const tampered = raisedLines.filter((_, i) => i !== victimIndex);
  /** @type {string | null} */
  let prev = null;
  const retext = tampered.map((value) => {
    const line = JSON.stringify({ ...value, prev });
    prev = createHash('sha256').update(line).digest('hex');
    return line;
  });
  await writeFile(ledgerPath, retext.join('\n') + '\n', 'utf8');

  const caught = await gauntlet('bundle', 'verify', join(dir, 'run'));
  assert.equal(caught.status, 1, 'a re-chained ledger edit is still caught');
  assert.match(caught.stdout, /ledger/);

  // 6. The flag needs prices: a total cap must price every recorded call.
  const priced = await gauntlet('run', '--suite', suiteFile, '--agent', 'model:openai-chat/cap-model', '--base-url', stub.url, '--max-usd-total', '1', '--out', join(dir, 'run2'));
  assert.equal(priced.status, 1);
  assert.match(priced.stderr, /--max-usd-total requires --prices/);
});
