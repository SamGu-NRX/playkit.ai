/**
 * Integration: the real CLI, as a subprocess, end to end — the `rate`
 * command, `--scoring-profile`, the display-only chess rating column, the
 * mixed-profile refusal, and `bundle verify`'s tamper rejection. All spawns
 * are async (`child_process.spawn`): `spawnSync` deadlocks on large stdio in
 * this suite. Chess trajectories for `rate` are hermetic fixture files (no
 * chess episodes are played there); the leaderboard and bundle scenarios run
 * real episodes for one game each (2048, chess) to stay fast.
 *
 * @module
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const gauntletRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const cli = join(gauntletRoot, 'cli', 'gauntlet.js');

/**
 * Run the CLI as a subprocess, capturing all streams. Async spawn only:
 * spawnSync deadlocks on large stdio in this suite.
 *
 * @param {...string} args
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
 */
function gauntlet(...args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

/**
 * Run an arbitrary node script as a subprocess with captured streams.
 *
 * @param {string} script
 * @param {...string} args
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
 */
function runScript(script, ...args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

/**
 * Trajectory files under a run directory, recursively (bundle metadata and
 * `_`-prefixed summaries excluded).
 *
 * @param {string} root
 * @param {string[]} out
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
 * A hermetic chess trajectory fixture: only the shape the run-dir loader and
 * `rateAgent` read.
 *
 * @param {string} agent
 * @param {string} tier
 * @param {number} mine The agent seat's normalized score.
 */
function chessTrajectory(agent, tier, mine) {
  return {
    game: { id: 'chess', version: '1.1.0' },
    tier,
    seed: `chess/${tier}/public/0`,
    split: 'public',
    agent: { id: agent, seat: 0 },
    steps: [],
    end: {
      reason: 'checkmate',
      agentActions: 10,
      invalidActions: 0,
      outcome: { normalized: [mine, 1 - mine] },
    },
  };
}

const SYNTHETIC_LADDER = {
  meta: { anchor: { rung: 'chess-paper', rating: 1000 } },
  fit: {
    ratings: { 'chess-paper': 1000, 'chess-stockfish-sf-10k': 2800 },
    intervals: {},
    meta: {},
    error: null,
  },
};

test('rate: rates agents from fixture chess trajectories against a synthetic ladder', { timeout: 5 * 60 * 1000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'gauntlet-rate-e2e-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const ladderFile = join(root, 'ladder.json');
  writeFileSync(ladderFile, JSON.stringify(SYNTHETIC_LADDER));
  const runDir = join(root, 'runs');
  mkdirSync(runDir, { recursive: true });
  /**
   * @param {string} agent
   * @param {string} tier
   * @param {number} mine
   */
  const fixture = (agent, tier, mine) => JSON.stringify(chessTrajectory(agent, tier, mine), null, 2);
  writeFileSync(join(runDir, 'mixed-paper.json'), fixture('mixed-agent', 'paper', 1));
  writeFileSync(join(runDir, 'mixed-sf.json'), fixture('mixed-agent', 'stockfish-sf-10k', 0));
  writeFileSync(join(runDir, 'allwins-paper.json'), fixture('all-wins', 'paper', 1));
  writeFileSync(join(runDir, 'allwins-2.json'), fixture('all-wins', 'paper', 1));
  // A non-chess trajectory in the same run dir: skipped and reported, never
  // a rateAgent refusal.
  writeFileSync(
    join(runDir, 'connect4.json'),
    JSON.stringify({
      game: { id: 'connect4', version: '1.1.0' },
      tier: 'ladder-1',
      seed: 'connect4/ladder-1/public/0',
      split: 'public',
      agent: { id: 'all-wins', seat: 0 },
      steps: [],
      end: { reason: 'win', agentActions: 7, invalidActions: 0, outcome: { normalized: [1, 0] } },
    })
  );

  // JSON mode: machine-readable rows, divergent agent reported with direction.
  const jsonRun = await gauntlet('rate', runDir, '--ladder', ladderFile, '--json');
  assert.equal(jsonRun.code, 0, jsonRun.stderr);
  /** @type {{ ladder: { anchorRung: string }, agents: Array<{ agent: string, games: number, skipped: number, skippedRungs: string[], rating: number | null, direction: string | null }> }} */
  const report = JSON.parse(jsonRun.stdout);
  assert.equal(report.ladder.anchorRung, 'chess-paper');
  assert.deepEqual(report.agents.map((a) => a.agent), ['all-wins', 'mixed-agent']);
  const allWins = report.agents[0];
  assert.equal(allWins.games, 2, 'two chess trajectories rated');
  assert.equal(allWins.skipped, 1, 'the connect4 trajectory is skipped, not a refusal');
  assert.deepEqual(allWins.skippedRungs, ['connect4-ladder-1']);
  assert.equal(allWins.rating, null);
  assert.equal(allWins.direction, 'wins-everything');
  const mixed = report.agents[1];
  assert.equal(mixed.games, 2);
  assert.equal(mixed.skipped, 0);
  assert.equal(mixed.direction, null);
  assert.ok(typeof mixed.rating === 'number' && mixed.rating > 1000 && mixed.rating < 2800);

  // Table mode: one row per agent plus the skipped note.
  const table = await gauntlet('rate', runDir, '--ladder', ladderFile);
  assert.equal(table.code, 0, table.stderr);
  assert.match(table.stdout, /agent\s+games\s+rating\s+95% interval/);
  assert.match(table.stdout, /all-wins\s+2\s+—\s+wins-everything/);
  assert.match(table.stdout, /mixed-agent\s+2\s+\d+\.\d/);
  assert.match(table.stdout, /skipped all-wins: 1 not on the ladder \(connect4-ladder-1\)/);

  // A missing ladder is an error naming the fitter, not an empty rating.
  const missing = await gauntlet('rate', runDir, '--ladder', join(root, 'no-such-ladder.json'));
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /run rating\/ladder\.js first/);

  // Without --ladder the package's committed ladder applies: chess-paper and
  // chess-stockfish-sf-10k are real rungs, so the same fixtures rate.
  const defaultLadder = await gauntlet('rate', runDir, '--json');
  assert.equal(defaultLadder.code, 0, defaultLadder.stderr);
  /** @type {{ ladder: { anchorRung: string }, agents: Array<{ games: number }> }} */
  const defaultReport = JSON.parse(defaultLadder.stdout);
  assert.equal(defaultReport.ladder.anchorRung, 'chess-paper');
  assert.equal(defaultReport.agents[1].games, 2);
});

test('leaderboard --scoring-profile: one board per profile, invalid refused, rating column', { timeout: 10 * 60 * 1000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'gauntlet-profile-e2e-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const suiteFile = join(root, 'suite-2048.json');
  assert.equal(
    (await gauntlet('suite', 'build', '--split', 'public', '--seeds-per-tier', '1', '--games', '2048', '--out', suiteFile)).code,
    0
  );
  const runDir = join(root, 'run-2048');
  const run = await gauntlet('run', '--suite', suiteFile, '--agent', 'random', '--out', runDir);
  assert.equal(run.code, 0, run.stderr);

  // One leaderboard per profile, including chance-adjusted, which loads the
  // committed random baseline automatically and records its hash.
  for (const profile of ['rhae-v1', 'chance-adjusted', 'squared-outcome']) {
    const lbDir = join(root, `lb-${profile}`);
    const result = await gauntlet('leaderboard', '--suite', suiteFile, '--scoring-profile', profile, '--out', lbDir, runDir);
    assert.equal(result.code, 0, result.stderr);
    const board = JSON.parse(readFileSync(join(lbDir, 'leaderboard.json'), 'utf8'));
    assert.equal(board.scoring?.profile, profile);
    if (profile === 'chance-adjusted') {
      assert.match(board.scoring?.baselineSha256 ?? '', /^[0-9a-f]{64}$/, 'the baseline provenance names the committed file');
    }
    // Agents with no chess trajectories show '—' in the rating column.
    const row = readFileSync(join(lbDir, 'leaderboard.md'), 'utf8')
      .split('\n')
      .find((line) => line.includes('| random |'));
    assert.ok(row, 'the random agent appears in the baseline table');
    assert.ok(row.trim().endsWith('| — |'), 'an agent with no chess trajectories shows —');
  }

  // Omitting the flag stays the default board: no scoring block at all.
  const lbDefault = join(root, 'lb-default');
  const defaultRun = await gauntlet('leaderboard', '--suite', suiteFile, '--out', lbDefault, runDir);
  assert.equal(defaultRun.code, 0, defaultRun.stderr);
  const defaultBoard = JSON.parse(readFileSync(join(lbDefault, 'leaderboard.json'), 'utf8'));
  assert.equal(defaultBoard.scoring, undefined);

  // An unknown profile exits 1 naming the valid ones.
  const invalid = await gauntlet('leaderboard', '--suite', suiteFile, '--scoring-profile', 'nope', runDir);
  assert.equal(invalid.code, 1);
  assert.match(invalid.stderr, /unknown scoring profile "nope"/);
  assert.match(invalid.stderr, /rhae-v1, chance-adjusted, squared-outcome/);

  // The rating column rates a chess-only entry: real chess episodes against
  // the committed ladder — sand, paper and wood are ladder rungs; steel and
  // granite sit above the fitted ladder and are skipped.
  const chessSuite = join(root, 'suite-chess.json');
  assert.equal(
    (await gauntlet('suite', 'build', '--split', 'public', '--seeds-per-tier', '1', '--games', 'chess', '--out', chessSuite)).code,
    0
  );
  const chessRunDir = join(root, 'run-chess');
  const chessRun = await gauntlet('run', '--suite', chessSuite, '--agent', 'random', '--out', chessRunDir);
  assert.equal(chessRun.code, 0, chessRun.stderr);
  const lbChess = join(root, 'lb-chess');
  const chessLb = await gauntlet('leaderboard', '--suite', chessSuite, '--out', lbChess, chessRunDir);
  assert.equal(chessLb.code, 0, chessLb.stderr);
  const chessBoard = JSON.parse(readFileSync(join(lbChess, 'leaderboard.json'), 'utf8'));
  assert.match(readFileSync(join(lbChess, 'leaderboard.md'), 'utf8'), /Chess rating \(95% CI\)/);
  const chessEntry = chessBoard.tracks.baseline[0];
  assert.equal(chessEntry.agent.id, 'random');
  assert.ok(chessEntry.rating, 'a chess-trajectory agent carries a rating');
  assert.equal(chessEntry.rating.games, 3, 'sand, paper and wood are ladder-known; steel and granite are not');
  assert.ok(chessEntry.rating.rating !== null || chessEntry.rating.direction !== null);
  const chessRow = readFileSync(join(lbChess, 'leaderboard.md'), 'utf8')
    .split('\n')
    .find((line) => line.includes('| random |'));
  assert.ok(chessRow && !chessRow.trim().endsWith('| — |'), 'the rated entry does not show —');
});

test('a mixed-profile board is refused with the profile-mismatch error', { timeout: 5 * 60 * 1000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'gauntlet-mixed-e2e-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const suiteFile = join(root, 'suite.json');
  assert.equal(
    (await gauntlet('suite', 'build', '--split', 'public', '--seeds-per-tier', '1', '--games', '2048', '--out', suiteFile)).code,
    0
  );
  const runDir = join(root, 'run-2048');
  assert.equal((await gauntlet('run', '--suite', suiteFile, '--agent', 'random', '--out', runDir)).code, 0);

  // The CLI builds one-profile boards by design, so the mixed-profile case
  // is driven at the scoring layer through a subprocess that hands
  // leaderboard() two entries scored under different profiles.
  const driver = join(root, 'profile-mismatch-driver.mjs');
  writeFileSync(
    driver,
    [
      "import { readdirSync, readFileSync, statSync } from 'node:fs';",
      "import { join } from 'node:path';",
      "import { pathToFileURL } from 'node:url';",
      'const [pkgRoot, suitePath, runDir] = process.argv.slice(2);',
      "const { leaderboard } = await import(pathToFileURL(join(pkgRoot, 'scoring', 'leaderboard.js')).href);",
      "const { listGames } = await import(pathToFileURL(join(pkgRoot, 'games', 'index.js')).href);",
      'const suite = JSON.parse(readFileSync(suitePath, "utf8"));',
      'const trajectories = [];',
      '(function walk(dir) {',
      '  for (const name of readdirSync(dir).sort()) {',
      '    const p = join(dir, name);',
      '    if (statSync(p).isDirectory()) { walk(p); continue; }',
      "    if (!name.endsWith('.json') || name.startsWith('_') || name === 'run.json' || name === 'suite.json') continue;",
      '    trajectories.push(JSON.parse(readFileSync(p, "utf8")));',
      '  }',
      '})(runDir);',
      'const agent = { id: trajectories[0].agent.id, track: trajectories[0].agent.track };',
      'try {',
      '  await leaderboard(suite, [',
      "    { agent, trajectories, profile: 'squared-outcome' },",
      "    { agent, trajectories, profile: 'rhae-v1' },",
      '  ], listGames());',
      "  process.stdout.write('no refusal - mixed-profile board accepted\\n');",
      '  process.exit(0);',
      '} catch (err) {',
      '  process.stderr.write(`${err && err.message}\\n`);',
      "  process.exit(err && err.step === 'profile-mismatch' ? 3 : 1);",
      '}',
      '',
    ].join('\n')
  );

  const driverRun = await runScript(driver, gauntletRoot, suiteFile, runDir);
  assert.equal(driverRun.code, 3, `expected the profile-mismatch refusal, got: ${driverRun.stderr}`);
  assert.match(driverRun.stderr, /profile-mismatch/);
  assert.match(driverRun.stderr, /squared-outcome/);
  assert.match(driverRun.stderr, /rhae-v1/);
});

test('bundle verify rejects an edited trajectory', { timeout: 10 * 60 * 1000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'gauntlet-tamper-e2e-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const suiteFile = join(root, 'suite.json');
  assert.equal(
    (await gauntlet('suite', 'build', '--split', 'public', '--seeds-per-tier', '1', '--games', '2048', '--out', suiteFile)).code,
    0
  );
  const runDir = join(root, 'run-2048');
  assert.equal((await gauntlet('run', '--suite', suiteFile, '--agent', 'random', '--out', runDir)).code, 0);

  // Pristine bundle verifies clean.
  const pristine = await gauntlet('bundle', 'verify', runDir);
  assert.equal(pristine.code, 0, pristine.stdout + pristine.stderr);
  assert.match(pristine.stdout, /verdict\s+ok/);

  // Edit one recorded trajectory: flipping the recorded outcome must break
  // the bundle (replay mismatch and/or manifest-hash mismatch).
  const tampered = join(root, 'run-tampered');
  cpSync(runDir, tampered, { recursive: true });
  /** @type {string[]} */
  const files = [];
  collectTrajectories(tampered, files);
  assert.ok(files.length > 0, 'the run directory holds trajectory files');
  const victim = files[0];
  const trajectory = JSON.parse(readFileSync(victim, 'utf8'));
  const flipped = trajectory.end.outcome.normalized.slice();
  flipped[trajectory.agent.seat] = 1 - flipped[trajectory.agent.seat];
  trajectory.end.outcome.normalized = flipped;
  writeFileSync(victim, JSON.stringify(trajectory, null, 2) + '\n');

  const tamperedRun = await gauntlet('bundle', 'verify', tampered);
  assert.equal(tamperedRun.code, 1, `an edited trajectory must fail bundle verify: ${tamperedRun.stdout}`);
  assert.match(tamperedRun.stdout, /verdict\s+FAILED/);
});
