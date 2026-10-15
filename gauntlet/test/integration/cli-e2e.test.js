/**
 * Integration: the real CLI, as a subprocess, end to end.
 *
 * 1. `suite build --split public --seeds-per-tier 1` writes a manifest whose
 *    tiers carry exactly one public seed each.
 * 2. `run --agent random --limit 1` covers that manifest fully (one episode
 *    per game-tier) and writes one trajectory per episode plus `_run.json`.
 * 3. `verify` replays every trajectory cleanly.
 * 4. `leaderboard` ranks the random agent #1 in the baseline track with a
 *    numeric benchmark score.
 * 5. The same suite with a dry-run scripted model agent (`--dry-run
 *    --script`) produces official-track trajectories that verify, and the
 *    leaderboard flags the entry as a dry run and leaves it unranked.
 *
 * @module
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const gauntletRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const cli = join(gauntletRoot, 'cli', 'gauntlet.js');

/**
 * @param {...string} args
 * @returns {{ stdout: string, status: number }}
 */
function gauntlet(...args) {
  const stdout = execFileSync(process.execPath, [cli, ...args], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return { stdout, status: 0 };
}

test('cli end-to-end: suite build → run → verify → leaderboard', { timeout: 10 * 60 * 1000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'gauntlet-e2e-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const suiteFile = join(root, 'suite.json');

  // 1. Build a one-seed-per-tier public suite through the real CLI.
  gauntlet('suite', 'build', '--split', 'public', '--seeds-per-tier', '1', '--out', suiteFile);
  const suite = JSON.parse(readFileSync(suiteFile, 'utf8'));
  assert.equal(suite.format, 'playkit-gauntlet-suite/1');
  assert.equal(suite.split, 'public');
  const episodeCount = suite.games.reduce(
    (/** @type {number} */ n, /** @type {*} */ g) => n + g.tiers.reduce(
      (/** @type {number} */ m, /** @type {*} */ tier) => m + tier.seeds.length, 0), 0);
  assert.ok(episodeCount >= suite.games.length, 'every tier carries at least one seed');

  // 2. Run the random agent; --limit 1 covers the manifest exactly once.
  const runDir = join(root, 'run-random');
  gauntlet('run', '--suite', suiteFile, '--agent', 'random', '--limit', '1', '--out', runDir);
  const files = readdirSync(runDir).filter((name) => name.endsWith('.json') && !name.startsWith('_'));
  assert.equal(files.length, episodeCount, 'one trajectory per manifest episode');

  // 3. Verify every trajectory through the real CLI.
  const verify = gauntlet('verify', runDir);
  assert.match(verify.stdout, new RegExp(`${episodeCount}/${episodeCount} trajectories verified`));

  // 4. The baseline track ranks the random agent.
  const lbDir = join(root, 'lb-random');
  gauntlet('leaderboard', '--suite', suiteFile, '--out', lbDir, runDir);
  const board = JSON.parse(readFileSync(join(lbDir, 'leaderboard.json'), 'utf8'));
  assert.equal(board.format, 'playkit-gauntlet-leaderboard/1');
  const baseline = board.tracks.baseline;
  assert.equal(baseline.length, 1, 'one baseline entry');
  assert.equal(baseline[0].agent.id, 'random');
  assert.equal(baseline[0].ranked, true, 'full manifest coverage ranks the entry');
  assert.equal(baseline[0].rank, 1);
  assert.equal(typeof baseline[0].benchmarkScore?.value, 'number');
  assert.match(readFileSync(join(lbDir, 'leaderboard.md'), 'utf8'), /random/);

  // 5. Dry-run scripted model agent: verifies, but is flagged and unranked.
  const script = join(root, 'pass-script.mjs');
  writeFileSync(script, "export default () => 'pass';\n");
  const dryDir = join(root, 'run-dry');
  gauntlet(
    'run', '--suite', suiteFile,
    '--agent', 'model:anthropic/claude-sonnet-4-5',
    '--dry-run', '--script', script,
    '--out', dryDir
  );
  const dryTrajectory = JSON.parse(
    readFileSync(join(dryDir, readdirSync(dryDir).find((n) => n.startsWith('tictactoe') && n.endsWith('.json')) ?? ''), 'utf8')
  );
  assert.equal(dryTrajectory.agent.id, 'model:anthropic/claude-sonnet-4-5');
  assert.equal(dryTrajectory.agent.track, 'official');
  assert.equal(dryTrajectory.agent.dryRun, true);
  assert.equal(dryTrajectory.end.reason, 'forfeit-invalid', "three 'pass' replies are never legal, so the runner forfeits it");
  const dryVerify = gauntlet('verify', dryDir);
  assert.match(dryVerify.stdout, new RegExp(`${episodeCount}/${episodeCount} trajectories verified`));

  const lb2Dir = join(root, 'lb-mixed');
  gauntlet('leaderboard', '--suite', suiteFile, '--out', lb2Dir, runDir, dryDir);
  const board2 = JSON.parse(readFileSync(join(lb2Dir, 'leaderboard.json'), 'utf8'));
  assert.equal(board2.tracks.baseline.length, 1);
  assert.equal(board2.tracks.baseline[0].ranked, true);
  assert.equal(board2.tracks.official.length, 1);
  const official = board2.tracks.official[0];
  assert.equal(official.ranked, false, 'a dry-run trajectory is never ranked');
  assert.equal(official.rank, null);
  assert.match(official.unrankedReason ?? '', /dry-run/i);
  // The leaderboard agent record is { id, track, model?, provider? } by
  // contract; dry-run-ness lives on the trajectory and in unrankedReason.
  assert.equal(dryTrajectory.agent.dryRun, true);
});
