/**
 * Integration: the community-assisted spec through the real CLI, end to end.
 *
 * 1. A dry-run `community-assisted:` agent whose script answers with an
 *    invalid action first and a legal one on retry plays every episode to a
 *    non-forfeit terminal — the wrapper's in-turn retry loop carries the
 *    runner through — and the trajectory records the community track, the
 *    assisted agent id (retries suffix included) and dry-run-ness. `verify`
 *    replays it cleanly and the leaderboard files the entry under the
 *    community track with the official track empty.
 * 2. A live `community-assisted:openai-chat/...` agent against a local stub
 *    chat-completions server plays the same suite for real (no paid calls):
 *    the wrapper feeds the legal actions, the stub's legal replies are
 *    accepted on the first attempt, and usage flows into the trajectory from
 *    the inner model agent.
 * 3. A live openai-chat assisted spec without --base-url is refused at spec
 *    parse, like the model spec.
 *
 * @module
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startStubServer, sendJson } from '../../harness/stub-server.js';

const gauntletRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const cli = join(gauntletRoot, 'cli', 'gauntlet.js');

/**
 * Run the CLI as a subprocess and await its exit. Async spawn keeps this
 * process's event loop free — the stub server lives here.
 *
 * @param {...string} args
 * @returns {Promise<{ stdout: string, stderr: string, status: number }>}
 */
function gauntlet(...args) {
  return new Promise((resolve, reject) => {
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
    child.on('close', (code) => resolve({ stdout, stderr, status: code ?? -1 }));
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

test('community-assisted end to end: dry-run retry, verify, leaderboard separation', { timeout: 5 * 60 * 1000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'gauntlet-community-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const suiteFile = join(root, 'suite.json');

  // One game, one seed per tier: fast, no engine dependencies, full coverage.
  await gauntlet('suite', 'build', '--split', 'public', '--seeds-per-tier', '1', '--games', 'connect4', '--out', suiteFile);
  const suite = JSON.parse(readFileSync(suiteFile, 'utf8'));
  const episodeCount = suite.games.reduce(
    (/** @type {number} */ n, /** @type {*} */ g) => n + g.tiers.reduce(
      (/** @type {number} */ m, /** @type {*} */ tier) => m + tier.seeds.length, 0), 0);
  assert.ok(episodeCount >= 1);

  // Dry-run assisted agent: the script's first reply each turn is invalid;
  // once the wrapper feeds back the referee reason (ctx.feedback is set on
  // retries only), it plays 'pass', a legal tictactoe action. Every episode
  // must therefore reach a non-forfeit terminal through the retry loop.
  const script = join(root, 'retry-script.mjs');
  writeFileSync(
    script,
    [
      'export default (ctx) => {',
      '  if (ctx && ctx.feedback) {',
      '    const m = ctx.observation.text.match(/Legal actions \\(\\d+\\):\\n([^\\n]+)/);',
      '    if (m) return m[1].split(", ")[0];',
      '  }',
      '  return "not-a-move";',
      '};',
      '',
    ].join('\n')
  );
  const runDir = join(root, 'run-dry');
  const run = await gauntlet(
    'run', '--suite', suiteFile,
    '--agent', 'community-assisted:openai-chat/stub-model:retries=1',
    '--dry-run', '--script', script,
    '--out', runDir
  );
  assert.equal(run.status, 0, run.stderr);
  /** @type {string[]} */
  const files = [];
  collectTrajectories(runDir, files);
  assert.equal(files.length, episodeCount, 'one trajectory per manifest episode');
  for (const file of files) {
    const trajectory = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(trajectory.agent.id, 'community-assisted:openai-chat/stub-model:retries=1');
    assert.equal(trajectory.agent.track, 'community');
    assert.equal(trajectory.agent.dryRun, true);
    assert.notEqual(trajectory.end.reason, 'forfeit-invalid', 'every turn recovers within one retry');
    for (const step of trajectory.steps) {
      if (step.by !== 'agent') continue; // opponent steps carry no reply
      assert.equal(step.reply.meta.assisted.attempts, 2, 'each turn needed the retry');
      assert.equal(step.reply.meta.assisted.retried, true);
    }
  }

  const verify = await gauntlet('verify', runDir);
  assert.equal(verify.status, 0, verify.stdout + verify.stderr);
  assert.match(verify.stdout, new RegExp(`${episodeCount}/${episodeCount} trajectories verified`));

  // The leaderboard files the run under the community track and leaves the
  // official track untouched.
  const lbDir = join(root, 'lb');
  const lb = await gauntlet('leaderboard', '--suite', suiteFile, '--out', lbDir, runDir);
  assert.equal(lb.status, 0, lb.stdout + lb.stderr);
  const board = JSON.parse(readFileSync(join(lbDir, 'leaderboard.json'), 'utf8'));
  assert.equal(board.format, 'playkit-gauntlet-leaderboard/1');
  assert.equal(board.tracks.official.length, 0, 'the community run never lands in the official table');
  const community = board.tracks.community;
  assert.equal(community.length, 1, 'one community entry');
  assert.equal(community[0].agent.id, 'community-assisted:openai-chat/stub-model:retries=1');
  assert.equal(community[0].agent.track, 'community');
  assert.equal(community[0].ranked, false, 'dry-run entries are unranked by design');
  assert.match(/** @type {string} */ (community[0].unrankedReason), /dry-run/);
});

test('community-assisted end to end: live openai-chat run against a local stub server', { timeout: 5 * 60 * 1000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'gauntlet-community-live-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const suiteFile = join(root, 'suite.json');
  await gauntlet('suite', 'build', '--split', 'public', '--seeds-per-tier', '1', '--games', 'connect4', '--out', suiteFile);

  /** @type {string[]} */
  const bodies = [];
  const stub = await startStubServer(
    /** @param {*} body */
    (req, res, body) => {
      bodies.push(JSON.stringify(body));
      // Answer with the first legal action the wrapper listed in the prompt.
      // ('pass' is not a legal tictactoe action.)
      let reply = 'not-a-move';
      const messages = /** @type {{messages?: Array<{content?: string}>}} */ (body)?.messages ?? [];
      const prompt = messages.map((m) => m.content ?? '').join('\n');
      const m = prompt.match(/Legal actions \(\d+\):\n([^\n]+)/);
      if (m) reply = m[1].split(', ')[0];
      sendJson(res, 200, {
        id: 'chatcmpl-stub',
        object: 'chat.completion',
        created: 1,
        model: /** @type {{model?: string}} */ (body)?.model ?? 'stub-model',
        choices: [
          { index: 0, message: { role: 'assistant', content: reply }, finish_reason: 'stop' },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 10 },
      });
    }
  );
  t.after(() => stub.close());

  const runDir = join(root, 'run-live');
  const run = await gauntlet(
    'run', '--suite', suiteFile,
    '--agent', 'community-assisted:openai-chat/stub-model',
    '--base-url', stub.url,
    '--out', runDir
  );
  assert.equal(run.status, 0, run.stderr);

  /** @type {string[]} */
  const files = [];
  collectTrajectories(runDir, files);
  assert.ok(files.length >= 1);
  for (const file of files) {
    const trajectory = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(trajectory.agent.id, 'community-assisted:openai-chat/stub-model:retries=2');
    assert.equal(trajectory.agent.track, 'community');
    assert.equal(trajectory.agent.dryRun, false);
    assert.notEqual(trajectory.end.reason, 'forfeit-invalid');
    for (const step of trajectory.steps) {
      if (step.by !== 'agent') continue; // opponent steps carry no reply
      // the stub's first legal action is always accepted on the first attempt
      assert.equal(step.reply.meta.assisted.attempts, 1);
      assert.ok(step.reply.usage.inputTokens === null || step.reply.usage.inputTokens > 0);
    }
  }
  // The stub really saw the augmented prompt: legal actions in every request.
  assert.ok(bodies.length >= 1);
  assert.ok(bodies.every((b) => b.includes('Legal actions (')));
});

test('community-assisted end to end: a live openai-chat spec without --base-url is refused', { timeout: 60 * 1000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'gauntlet-community-refused-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const suiteFile = join(root, 'suite.json');
  await gauntlet('suite', 'build', '--split', 'public', '--seeds-per-tier', '1', '--games', 'connect4', '--out', suiteFile);
  const refused = await gauntlet(
    'run', '--suite', suiteFile,
    '--agent', 'community-assisted:openai-chat/stub-model',
    '--limit', '1',
    '--out', join(root, 'run-refused')
  );
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /requires --base-url/);
});
