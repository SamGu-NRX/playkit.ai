/**
 * Integration: `gauntlet run --episode-time-limit-ms` over a small suite with
 * a deliberately slow agent, as a real subprocess. The agent is a
 * `model:openai-chat` spec against a local stub chat-completions server whose
 * second reply per episode is delayed far past the episode limit, so every
 * episode ends with the runner's `time-limit` end reason. No external
 * services; the only network traffic is to 127.0.0.1.
 *
 * Checks:
 * 1. The run exits clean with every episode played (a timed-out episode is a
 *    played episode, not a failure), and run.json records the limit.
 * 2. Every trajectory ends with reason `time-limit`, the recorded limit, a
 *    self-reported elapsed time, and the forfeit-shaped outcome; the steps
 *    recorded before the deadline replay (`bundle verify` passes).
 * 3. `leaderboard` scores the bundle (a timed-out episode scores 0).
 * 4. `--resume` skips the timed-out episodes as already played.
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

/** Delay for the stub's second-and-later replies of an episode, far past the limit. */
const SLOW_MS = 300;

/**
 * Run the CLI as a subprocess and await its exit.
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
 * Trajectory files under a run directory, recursively.
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

test('cli run --episode-time-limit-ms: slow agent, replayable timeouts, leaderboard, resume', { timeout: 3 * 60 * 1000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'gauntlet-time-limit-e2e-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  // The stub replies instantly to an episode's first call (so each trajectory
  // records a real, replayable step) and delays every later call past the
  // episode limit. The model agent carries its previous reply into the next
  // request, so the messages array grows one turn per call: a length of 2 is
  // the episode's first call.
  const stub = await startStubServer(
    /** @param {import('node:http').IncomingMessage} req @param {import('node:http').ServerResponse} res @param {*} body */
    (req, res, body) => {
      const messages = /** @type {{ messages?: unknown[] }} */ (body)?.messages ?? [];
      const reply = () =>
        sendJson(res, 200, {
          id: 'chatcmpl-stub',
          object: 'chat.completion',
          created: 1,
          model: 'stub-model',
          choices: [
            { index: 0, message: { role: 'assistant', content: 'a1' }, finish_reason: 'stop' },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 1 },
        });
      if (messages.length <= 2) {
        reply();
      } else {
        setTimeout(reply, SLOW_MS);
      }
    }
  );
  t.after(() => stub.close());

  const suiteFile = join(root, 'suite.json');
  await gauntlet('suite', 'build', '--split', 'public', '--games', 'tictactoe', '--seeds-per-tier', '1', '--out', suiteFile);
  const suite = JSON.parse(readFileSync(suiteFile, 'utf8'));
  const episodeCount = suite.games.reduce(
    (/** @type {number} */ n, /** @type {*} */ g) => n + g.tiers.reduce(
      (/** @type {number} */ m, /** @type {*} */ tier) => m + tier.seeds.length, 0), 0);
  assert.ok(episodeCount >= 1, 'the suite has episodes');

  const runDir = join(root, 'run');
  const runArgs = [
    'run', '--suite', suiteFile,
    '--agent', 'model:openai-chat/stub-model',
    '--base-url', stub.url,
    '--api-key-env', 'GAUNTLET_TIME_LIMIT_E2E_KEY',
    '--out', runDir,
    '--episode-time-limit-ms', '100',
  ];
  process.env.GAUNTLET_TIME_LIMIT_E2E_KEY = 'stub-secret';

  // 1. Every episode times out and still counts as played.
  const run = await gauntlet(...runArgs);
  assert.equal(run.status, 0, `run exits clean:\n${run.stdout}\n${run.stderr}`);
  assert.match(run.stdout, /done\s+every planned episode has a trajectory/);
  const runRecord = JSON.parse(readFileSync(join(runDir, 'run.json'), 'utf8'));
  assert.equal(runRecord.counts.played, episodeCount);
  assert.equal(runRecord.counts.failed, 0);
  assert.equal(runRecord.counts.unplayed, 0);
  assert.equal(runRecord.limits.episodeTimeLimitMs, 100, 'run.json records the episode limit');

  // 2. Each trajectory ends time-limit at the limit, with the forfeit-shaped
  // outcome, and the steps recorded before the deadline replay.
  /** @type {string[]} */ const trajectoryFiles = [];
  collectTrajectories(runDir, trajectoryFiles);
  assert.equal(trajectoryFiles.length, episodeCount);
  for (const file of trajectoryFiles) {
    const trajectory = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(trajectory.end.reason, 'time-limit', file);
    assert.equal(trajectory.end.timeLimitMs, 100, file);
    assert.ok(trajectory.end.elapsedMs >= 100, `elapsed below the limit in ${file}`);
    assert.equal(/** @type {*} */ (trajectory).end.outcome.solved, false, file);
    assert.ok(trajectory.steps.length >= 1, `a step was recorded before the deadline in ${file}`);
    assert.equal(trajectory.agent.id, 'model:openai-chat/stub-model', file);
  }
  const verify = await gauntlet('bundle', 'verify', runDir);
  assert.equal(verify.status, 0, `bundle verify on the timed-out bundle:\n${verify.stdout}\n${verify.stderr}`);
  assert.match(verify.stdout, /verdict\s+ok/);

  // 3. The leaderboard scores the bundle; a timed-out episode scores 0.
  const lbDir = join(root, 'lb');
  const lb = await gauntlet('leaderboard', '--suite', suiteFile, '--out', lbDir, runDir);
  assert.equal(lb.status, 0, lb.stderr);
  const board = JSON.parse(readFileSync(join(lbDir, 'leaderboard.json'), 'utf8'));
  assert.equal(board.tracks.official.length, 1);
  const official = board.tracks.official[0];
  assert.equal(official.agent.id, 'model:openai-chat/stub-model');
  assert.equal(official.ranked, true);
  assert.equal(official.benchmarkScore?.value, 0, 'a timed-out episode scores 0');

  // 4. Resume counts the timed-out episodes as played: everything is skipped.
  const resumed = await gauntlet(...runArgs, '--resume');
  assert.equal(resumed.status, 0, `resume exits clean:\n${resumed.stdout}\n${resumed.stderr}`);
  const resumedRecord = JSON.parse(readFileSync(join(runDir, 'run.json'), 'utf8'));
  assert.equal(resumedRecord.counts.skipped, episodeCount);
  assert.equal(resumedRecord.counts.played, 0);
  assert.equal(resumedRecord.counts.unplayed, 0);
});
