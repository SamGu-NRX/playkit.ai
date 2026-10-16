/**
 * Integration: the engine-backed CLI surface (`gauntlet/runs/` behind the
 * CLI), as real subprocesses, against a local stub chat-completions server.
 * No external services; the only network traffic is to 127.0.0.1.
 *
 * 1. `run --agent model:openai-chat/<model> --base-url http://127.0.0.1:<port>`
 *    plays a suite against the stub, writes run.json plus nested trajectories,
 *    and sends the `Authorization: Bearer <key>` header read from the
 *    environment variable named by `--api-key-env`.
 * 2. `--max-usd` stops the run mid-flight (`stopped: budget`, exit 1) and the
 *    bundle stays valid; `bundle verify` reports the missing episodes.
 * 3. Re-running the same command with `--resume` replays only what is missing
 *    (skipped trajectories are re-verified, not recomputed) and completes.
 * 4. `bundle verify` passes on the completed bundle and fails after a
 *    trajectory is tampered with.
 * 5. `estimate` prices the suite from a price file (and stays unpriced
 *    without one).
 * 6. `leaderboard` lists the openai-chat agent on the official track once the
 *    run covers the manifest.
 *
 * @module
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startStubServer, sendJson } from '../../harness/stub-server.js';

const gauntletRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const cli = join(gauntletRoot, 'cli', 'gauntlet.js');

/** Every model reply the stub sends. */
const STUB_REPLY = 'a1';
/** Usage the stub reports per call; priced at $0.01/1k in, $0.03/1k out. */
const STUB_USAGE = { prompt_tokens: 100, completion_tokens: 10 };

/**
 * Run the CLI as a subprocess and await its exit. Async spawn keeps this
 * process's event loop free — the stub server lives here, and a spawnSync
 * here would block its responses while the child waits on them.
 *
 * @param {...string} args
 * @returns {Promise<{ stdout: string, stderr: string, status: number }>}
 */
async function gauntlet(...args) {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ stdout, stderr, status: code ?? -1 });
    });
  });
}

/**
 * Trajectory files under a run directory, recursively (bundle layout:
 * `<game>/<tier>/<seed>.json`), excluding bundle metadata.
 *
 * @param {string} root
 * @param {string[]} out
 * @returns {void}
 */
function collectTrajectories(root, out) {
  for (const name of readdirSync(root).sort()) {
    const path = join(root, name);
    if (statSync(path).isDirectory()) {
      collectTrajectories(path, out);
      continue;
    }
    if (!name.endsWith('.json') || name.startsWith('_') || name === 'run.json' || name === 'suite.json') {
      continue;
    }
    out.push(path);
  }
}

/**
 * @typedef {Record<string, unknown>} JsonObject
 */

/**
 * @typedef {object} StubHandle
 * @property {string} url
 * @property {string[]} authHeaders Every Authorization header the stub saw.
 * @property {() => Promise<void>} close
 */

/**
 * Start a local stub chat-completions server that always replies `a1` with
 * fixed usage (100 in / 10 out per call). 127.0.0.1 only, no paid calls.
 *
 * @returns {Promise<StubHandle>}
 */
async function startStub() {
  /** @type {string[]} */ const authHeaders = [];
  const stub = await startStubServer(
    /** @param {import('node:http').IncomingMessage} req @param {import('node:http').ServerResponse} res @param {*} body */
    (req, res, body) => {
      authHeaders.push(req.headers.authorization ?? '');
      sendJson(res, 200, {
        id: 'chatcmpl-stub',
        object: 'chat.completion',
        created: 1,
        model: /** @type {{model?: string}} */ (body)?.model ?? 'stub-model',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: STUB_REPLY },
            finish_reason: 'stop',
          },
        ],
        usage: { ...STUB_USAGE },
      });
    }
  );
  return { url: stub.url, authHeaders, close: stub.close };
}

test('cli engine-backed run: stub provider, budget stop, resume, bundle verify, leaderboard', { timeout: 14 * 60 * 1000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'gauntlet-runs-e2e-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const stub = await startStub();
  t.after(() => stub.close());

  // Suite: sliding only — a benchmark game, so the leaderboard scores it.
  const suiteFile = join(root, 'suite.json');
  await gauntlet('suite', 'build', '--split', 'public', '--games', 'sliding', '--seeds-per-tier', '1', '--out', suiteFile);
  const suite = JSON.parse(readFileSync(suiteFile, 'utf8'));
  const episodeCount = suite.games.reduce(
    (/** @type {number} */ n, /** @type {*} */ g) => n + g.tiers.reduce(
      (/** @type {number} */ m, /** @type {*} */ tier) => m + tier.seeds.length, 0), 0);
  assert.ok(episodeCount >= 1, 'the suite has episodes');

  // Price file: openai-chat/stub-model at $10/MTok in, $30/MTok out — with the
  // stub usage (100 in, 10 out per call), exactly $0.0013 per call.
  const pricesFile = join(root, 'prices.json');
  writeFileSync(
    pricesFile,
    JSON.stringify(
      { 'openai-chat/stub-model': { inputPerMTok: 10, outputPerMTok: 30, source: 'stub', checked: '2026-10-15' } },
      null,
      2
    )
  );

  const runDir = join(root, 'run-stub');
  const runArgs = [
    'run', '--suite', suiteFile,
    '--agent', 'model:openai-chat/stub-model',
    '--base-url', stub.url,
    '--api-key-env', 'GAUNTLET_E2E_STUB_KEY',
    '--prices', pricesFile,
    '--out', runDir,
  ];
  process.env.GAUNTLET_E2E_STUB_KEY = 'stub-secret';

  // 1. Complete run against the stub.
  const first = await gauntlet(...runArgs);
  assert.equal(first.status, 0, `run exits clean:\n${first.stdout}\n${first.stderr}`);
  assert.match(first.stdout, /done\s+every planned episode has a trajectory/);
  const runRecord = JSON.parse(readFileSync(join(runDir, 'run.json'), 'utf8'));
  assert.equal(runRecord.format, 'playkit-gauntlet-run/1');
  assert.equal(runRecord.agent.id, 'model:openai-chat/stub-model');
  assert.equal(runRecord.stopped, null);
  assert.equal(runRecord.counts.played, episodeCount);
  assert.ok(runRecord.calls > 0, 'the stub recorded agent calls');
  /** @type {string[]} */ const trajectoryFiles = [];
  collectTrajectories(runDir, trajectoryFiles);
  assert.equal(trajectoryFiles.length, episodeCount);
  // The key travels from the env var named by --api-key-env as a Bearer header.
  assert.ok(stub.authHeaders.length > 0, 'the stub saw requests');
  assert.ok(stub.authHeaders.every((h) => h === 'Bearer stub-secret'), 'every call carries the api-key-env bearer header');

  // 2. Budget stop: $0.0013 per call. A $0.005 cap lets the first episode
  // forfeit (3 calls = $0.0039, a written trajectory) and stops the second
  // before it completes.
  const cappedDir = join(root, 'run-capped');
  const capped = await gauntlet(...runArgs, '--out', cappedDir, '--max-usd', '0.005');
  assert.equal(capped.status, 1, 'a budget-stopped run exits 1');
  assert.match(capped.stdout, /stopped\s+budget/);
  const cappedRecord = JSON.parse(readFileSync(join(cappedDir, 'run.json'), 'utf8'));
  assert.equal(cappedRecord.stopped, 'budget');
  assert.ok(cappedRecord.counts.played >= 1, 'at least one episode completed before the stop');
  assert.ok(cappedRecord.counts.unplayed >= 1, 'at least one episode was left unplayed');
  assert.ok(cappedRecord.spendUsd >= 0.005 - 1e-9, 'spend reached the cap');
  const cappedVerify = await gauntlet('bundle', 'verify', cappedDir);
  assert.equal(cappedVerify.status, 1, 'an incomplete bundle fails bundle verify');

  // 3. Resume the capped bundle: skip verified episodes, replay the rest.
  const resumed = await gauntlet(...runArgs, '--out', cappedDir, '--resume');
  assert.equal(resumed.status, 0, `resume completes:\n${resumed.stdout}\n${resumed.stderr}`);
  assert.match(resumed.stdout, /done\s+every planned episode has a trajectory/);
  const resumedRecord = JSON.parse(readFileSync(join(cappedDir, 'run.json'), 'utf8'));
  assert.equal(resumedRecord.stopped, null);
  assert.ok(resumedRecord.counts.skipped >= 1, 'resume skipped the already-played episodes');
  assert.ok(resumedRecord.counts.played >= 1, 'resume played the missing episodes');
  assert.equal(resumedRecord.counts.unplayed, 0);
  /** @type {string[]} */ const resumedFiles = [];
  collectTrajectories(cappedDir, resumedFiles);
  assert.equal(resumedFiles.length, episodeCount);

  // 4. Bundle verify passes on the completed bundle; fails once tampered.
  const clean = await gauntlet('bundle', 'verify', cappedDir);
  assert.equal(clean.status, 0, `clean bundle verify:\n${clean.stdout}`);
  assert.match(clean.stdout, /manifest ok/);
  assert.match(clean.stdout, /strays\s+none/);
  assert.match(clean.stdout, /verdict\s+ok/);

  const victim = resumedFiles[0];
  const original = readFileSync(victim, 'utf8');
  const tampered = /** @type {JsonObject} */ (JSON.parse(original));
  /** @type {unknown[]} */ const steps = /** @type {*} */ (tampered).steps;
  const step0 = /** @type {JsonObject} */ (steps[0]);
  // Replay re-derives every observation hash from (game, tier, seed), so a
  // doctored hash must fail verification regardless of the steps' validity.
  /** @type {JsonObject} */ (step0).observationHash = 'f'.repeat(16);
  writeFileSync(victim, JSON.stringify(tampered, null, 2) + '\n');
  const sabotaged = await gauntlet('bundle', 'verify', cappedDir);
  assert.equal(sabotaged.status, 1, 'a tampered trajectory fails bundle verify');
  assert.match(sabotaged.stdout, /FAILED/);
  writeFileSync(victim, original);

  // 5. Estimate prices a suite from a price file — run on tictactoe, whose
  // estimate probes (par-basis baselines) finish instantly, unlike sliding's
  // optimal-solver baselines.
  const smokeSuite = join(root, 'suite-smoke.json');
  await gauntlet('suite', 'build', '--split', 'public', '--games', 'tictactoe', '--seeds-per-tier', '1', '--out', smokeSuite);
  const priced = await gauntlet(
    'estimate', '--suite', smokeSuite, '--agent', 'model:openai-chat/stub-model', '--prices', pricesFile, '--json'
  );
  assert.equal(priced.status, 0, priced.stderr);
  const pricedEstimate = JSON.parse(priced.stdout);
  assert.equal(pricedEstimate.format, 'playkit-gauntlet-estimate/1');
  assert.equal(pricedEstimate.pricing.key, 'openai-chat/stub-model');
  assert.equal(pricedEstimate.pricing.priced, true);
  assert.ok(pricedEstimate.totals.callsHigh > 0);
  assert.ok(pricedEstimate.totals.usdHigh > 0, 'a priced entry yields a USD upper bound');

  const unpriced = await gauntlet('estimate', '--suite', smokeSuite, '--agent', 'model:openai-chat/stub-model', '--json');
  assert.equal(unpriced.status, 0, unpriced.stderr);
  const unpricedEstimate = JSON.parse(unpriced.stdout);
  assert.equal(unpricedEstimate.pricing.priced, false);
  assert.equal(unpricedEstimate.totals.usdHigh, null, 'USD stays unknown without a price entry');

  // 6. The leaderboard lists the stub agent on the official track, ranked.
  const lbDir = join(root, 'lb');
  const lb = await gauntlet('leaderboard', '--suite', suiteFile, '--out', lbDir, cappedDir);
  assert.equal(lb.status, 0, lb.stderr);
  const board = JSON.parse(readFileSync(join(lbDir, 'leaderboard.json'), 'utf8'));
  assert.equal(board.format, 'playkit-gauntlet-leaderboard/1');
  assert.equal(board.tracks.official.length, 1, 'one official-track entry');
  const official = board.tracks.official[0];
  assert.equal(official.agent.id, 'model:openai-chat/stub-model');
  assert.equal(official.agent.track, 'official');
  assert.equal(official.ranked, true, 'full manifest coverage ranks the entry');
  assert.equal(official.rank, 1);
  assert.equal(typeof official.benchmarkScore?.value, 'number');
});
