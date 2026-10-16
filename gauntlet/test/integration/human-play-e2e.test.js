/**
 * Integration: `gauntlet play --agent human` through the real CLI, end to
 * end, with scripted stdin standing in for a person (the human agent works
 * without a TTY).
 *
 * 1. A scripted player solves sokoban/one-box: the winning move list is
 *    derived in-process by BFS over the game's own pure API, then fed line by
 *    line through stdin — with `help`, an empty line and an out-of-range
 *    number interleaved, proving re-prompts never consume an action. The
 *    recording verifies with `gauntlet verify` and the episode ends solved.
 * 2. A scripted player plays tictactoe against its random-opponent tier by
 *    always taking legal action #1 (the number maps into whatever the current
 *    legal list is, so every reply is legal whatever seat the agent draws).
 *    The episode reaches a terminal win/loss/draw and verifies.
 * 3. A scripted player quits mid-game: the recording ends forfeit-shaped
 *    (forfeit-invalid, agent 0), every forfeit step carries meta.human.quit,
 *    and verifies.
 * 4. The human-baseline kit (studies/human-baseline/report.mjs) verifies the
 *    folder and reports per tier — solved fraction and actions against par —
 *    and a tampered recording fails the run without contributing a row.
 *
 * @module
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getGame } from '../../games/index.js';
import { publicSeed } from '../../core/seeds.js';

const gauntletRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const cli = join(gauntletRoot, 'cli', 'gauntlet.js');
const reportScript = join(gauntletRoot, 'studies', 'human-baseline', 'report.mjs');

/**
 * Run the CLI as a subprocess with a scripted stdin, and await its exit.
 * Async spawn keeps this process's event loop free.
 *
 * @param {string[]} args
 * @param {string[]} stdinLines Lines piped to the process, then EOF.
 * @returns {Promise<{ stdout: string, stderr: string, status: number }>}
 */
function gauntlet(args, stdinLines = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ stdout, stderr, status: code ?? -1 }));
    if (stdinLines.length > 0) {
      child.stdin.write(stdinLines.join('\n') + '\n');
    }
    child.stdin.end();
  });
}

/**
 * Shortest winning action list for a solitaire efficiency tier, by BFS over
 * the game's own pure API (the same reset/step the runner replays). `undo` is
 * excluded so the search is acyclic.
 *
 * @param {ReturnType<typeof getGame>} game
 * @param {*} tier
 * @param {string} seed
 * @returns {string[]}
 */
function solveByBfs(game, tier, seed) {
  const start = game.reset(tier, seed);
  const queue = [{ state: start, path: /** @type {string[]} */ ([]) }];
  let visited = 0;
  while (queue.length > 0) {
    const head = queue.shift();
    if (!head) break;
    const { state, path } = head;
    if (game.toAct(state) === null) {
      const outcome = game.outcome(state);
      if (outcome && outcome.solved === true) return path;
      continue; // terminal but not solved: dead end
    }
    if (path.length >= tier.maxActions) continue;
    const legal = game.legalActions(state, 0).filter((a) => a !== 'undo');
    for (const action of legal) {
      const next = game.step(state, 0, action);
      if (++visited > 200000) throw new Error('BFS exceeded 200k states');
      queue.push({ state: next, path: [...path, action] });
    }
  }
  throw new Error('no winning line found within the action budget');
}

test('a scripted player solves sokoban/one-box at the terminal; the recording verifies', { timeout: 5 * 60 * 1000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'gauntlet-human-sokoban-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const game = getGame('sokoban');
  const tier = game.spec.tiers.find((tier) => tier.id === 'one-box');
  const seed = publicSeed('sokoban', 'one-box', 0);
  const solution = solveByBfs(game, tier, seed);
  assert.ok(solution.length > 0, 'the seed has a winning line');

  // The scripted player asks for help, sends junk an out-of-range number —
  // re-prompts that must never consume an action — then plays the winning
  // line as action text.
  const lines = ['help', '', '9', ...solution];
  const outFile = join(root, 'sokoban-one-box-0.json');
  const run = await gauntlet(
    ['play', '--game', 'sokoban', '--tier', 'one-box', '--seed', seed, '--agent', 'human', '--out', outFile],
    lines
  );
  assert.equal(run.status, 0, run.stderr);

  const trajectory = JSON.parse(readFileSync(outFile, 'utf8'));
  assert.equal(trajectory.game.id, 'sokoban');
  assert.equal(trajectory.tier, 'one-box');
  assert.equal(trajectory.agent.id, 'human');
  assert.equal(trajectory.agent.track, 'community');
  assert.equal(trajectory.end.reason, 'terminal', 'the episode ends solved, not by budget or forfeit');
  assert.equal(trajectory.end.outcome.solved, true);
  assert.equal(trajectory.end.agentActions, solution.length, 're-prompts consumed nothing');
  assert.equal(trajectory.end.invalidActions, 0);

  // The terminal UI went to stderr; stdout stayed machine-readable.
  assert.match(run.stderr, /human at the terminal/);
  assert.match(run.stderr, /legal actions \(\d+\):/);
  assert.match(run.stderr, /Classic Sokoban/);
  assert.match(run.stderr, /\(no legal action number 9/);
  assert.match(run.stdout, /agent    human at seat 0 \(track community\)/);
  assert.doesNotMatch(run.stdout, /legal actions/);

  const verify = await gauntlet(['verify', outFile]);
  assert.equal(verify.status, 0, verify.stdout + verify.stderr);
  assert.match(verify.stdout, /1\/1 trajectories verified/);
});

test('a scripted player plays tictactoe against the random-opponent tier; the recording verifies', { timeout: 5 * 60 * 1000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'gauntlet-human-tictactoe-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  // Always take legal action #1: the number maps into the current list, so
  // every reply is legal whichever seat the agent draws and whatever the
  // seeded opponent takes. Six inputs cover any seat assignment (five agent
  // moves is the maximum).
  const outFile = join(root, 'tictactoe-random-0.json');
  const run = await gauntlet(
    ['play', '--game', 'tictactoe', '--tier', 'random-opponent', '--agent', 'human', '--out', outFile],
    ['1', '1', '1', '1', '1', '1']
  );
  assert.equal(run.status, 0, run.stderr);

  const trajectory = JSON.parse(readFileSync(outFile, 'utf8'));
  assert.equal(trajectory.game.id, 'tictactoe');
  assert.equal(trajectory.tier, 'random-opponent');
  assert.equal(trajectory.agent.track, 'community');
  assert.ok([0, 1].includes(trajectory.agent.seat));
  assert.equal(trajectory.end.reason, 'terminal', 'win, loss or draw — never a forfeit');
  assert.ok(trajectory.end.agentActions <= 5);
  assert.equal(trajectory.end.invalidActions, 0, 'number input is always a legal action');
  for (const step of trajectory.steps) {
    if (step.by !== 'agent') continue;
    assert.equal(step.invalid, false);
    assert.ok(step.reply.usage == null, 'a human turn records no token usage');
  }

  const verify = await gauntlet(['verify', outFile]);
  assert.equal(verify.status, 0, verify.stdout + verify.stderr);
  assert.match(verify.stdout, /1\/1 trajectories verified/);
});

test('a scripted player quits mid-game; the recording ends forfeit-shaped and verifies', { timeout: 5 * 60 * 1000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'gauntlet-human-quit-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const outFile = join(root, 'tictactoe-quit.json');
  const run = await gauntlet(
    ['play', '--game', 'tictactoe', '--tier', 'random-opponent', '--agent', 'human:sam', '--out', outFile],
    ['quit']
  );
  assert.equal(run.status, 0, run.stderr);

  const trajectory = JSON.parse(readFileSync(outFile, 'utf8'));
  assert.equal(trajectory.agent.id, 'human:sam', 'the optional name records who played');
  assert.equal(trajectory.end.reason, 'forfeit-invalid');
  assert.equal(trajectory.end.outcome.normalized[trajectory.agent.seat], 0, 'a forfeit scores the agent 0');
  assert.equal(trajectory.end.agentActions, 3, 'the runner\u2019s standard 3-invalid forfeit path');
  for (const step of trajectory.steps) {
    if (step.by !== 'agent') continue;
    assert.deepEqual(step.reply.meta, { human: { quit: true } });
  }
  // No further prompting after quitting: exactly one turn block was rendered.
  assert.equal(run.stderr.split('--- turn ').length - 1, 1);

  const verify = await gauntlet(['verify', outFile]);
  assert.equal(verify.status, 0, verify.stdout + verify.stderr);
  assert.match(verify.stdout, /1\/1 trajectories verified/);
});

test('the human-baseline kit verifies the folder and reports per tier; a tampered recording fails', { timeout: 5 * 60 * 1000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'gauntlet-human-kit-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const runDir = join(root, 'runs');
  mkdirSync(runDir, { recursive: true });

  // Play the three recordings of the previous tests into one folder.
  const game = getGame('sokoban');
  const tier = game.spec.tiers.find((tier) => tier.id === 'one-box');
  const seed = publicSeed('sokoban', 'one-box', 0);
  const solution = solveByBfs(game, tier, seed);
  const sokoban = await gauntlet(
    ['play', '--game', 'sokoban', '--tier', 'one-box', '--seed', seed, '--agent', 'human', '--out', join(runDir, 'sokoban-one-box-0.json')],
    [...solution]
  );
  assert.equal(sokoban.status, 0, sokoban.stderr);
  const played = await gauntlet(
    ['play', '--game', 'tictactoe', '--tier', 'random-opponent', '--agent', 'human', '--out', join(runDir, 'tictactoe-random-0.json')],
    ['1', '1', '1', '1', '1', '1']
  );
  assert.equal(played.status, 0, played.stderr);
  const quit = await gauntlet(
    ['play', '--game', 'tictactoe', '--tier', 'random-opponent', '--agent', 'human:sam', '--out', join(runDir, 'tictactoe-quit.json')],
    ['quit']
  );
  assert.equal(quit.status, 0, quit.stderr);

  // The kit: verify + per-tier report over the folder.
  const report = await gauntletKit([runDir]);
  assert.equal(report.status, 0, report.stdout + report.stderr);
  assert.match(report.stdout, /3\/3 trajectories verified, 0 failed/);
  // sokoban/one-box: solved at par (the BFS line is optimal).
  assert.match(report.stdout, /sokoban\/one-box\s+1\s+1\.00/);
  assert.match(report.stdout, /tictactoe\/random-opponent\s+2\s+/);
  // The two tictactoe episodes share one tier row: the played one and the quit.
  const jsonRun = await gauntletKit([runDir, '--json']);
  assert.equal(jsonRun.status, 0);
  const parsed = JSON.parse(jsonRun.stdout);
  assert.equal(parsed.trajectories.verified, 3);
  assert.equal(parsed.tiers.length, 2);
  const sokobanRow = parsed.tiers.find((/** @type {{ game: string }} */ r) => r.game === 'sokoban');
  assert.equal(sokobanRow.solvedFraction, 1);
  assert.ok(Math.abs(sokobanRow.meanActionsVsPar - 1) < 1e-9, 'the BFS line lands exactly on par');

  // A tampered recording fails the kit run, is named, and contributes no row.
  const tamperedDir = join(root, 'tampered');
  mkdirSync(tamperedDir, { recursive: true });
  writeFileSync(join(tamperedDir, 'bad.json'), JSON.stringify({ ...JSON.parse(readFileSync(join(runDir, 'tictactoe-quit.json'), 'utf8')), game: { id: 'tictactoe', version: '9.9.9' } }, null, 2));
  const bad = await gauntletKit([tamperedDir, '--json']);
  assert.equal(bad.status, 1);
  const badReport = JSON.parse(bad.stdout);
  assert.equal(badReport.trajectories.failed, 1);
  assert.equal(badReport.tiers.length, 0, 'unverified recordings contribute no row');
  assert.match(badReport.failures[0].reason, /version/);
});

/**
 * Run the kit script as a subprocess.
 *
 * @param {string[]} args
 * @returns {Promise<{ stdout: string, stderr: string, status: number }>}
 */
function gauntletKit(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [reportScript, ...args], {
      cwd: gauntletRoot,
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
