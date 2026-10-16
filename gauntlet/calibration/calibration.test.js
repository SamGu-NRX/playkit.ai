/**
 * Calibration kit tests: two properties, from the brief.
 *
 * 1. Reduced calibration runs (tictactoe + mastermind, 2 seeds per tier) are
 *    byte-identical across runs — same seeds and code, same tables.
 * 2. The tier-ordering checks flag misordered fixtures: greedy below random,
 *    engine below greedy, a random score rising with tier rank, and an engine
 *    solving below 95% on an efficiency tier — and pass a well-ordered one.
 *
 * Runs the real runner as a subprocess (no network calls).
 *
 * @module
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

import { runChecks } from './checks.js';

const here = dirname(fileURLToPath(import.meta.url));
const gauntletRoot = dirname(here);

/** @import { CalibrationTable } from './checks.js' */

/**
 * Run the calibration runner into a fresh output directory.
 *
 * @param {string} outDir
 * @param {string[]} games
 * @param {number} seeds
 * @returns {void}
 */
function runCalibration(outDir, games, seeds) {
  execFileSync(
    process.execPath,
    [
      join(here, 'run.js'),
      `--games=${games.join(',')}`,
      `--seeds=${seeds}`,
      `--out=${outDir}`,
      `--report=${join(outDir, 'REPORT.md')}`,
      '--per-game-cap=600',
      '--keep-trajectories',
    ],
    { cwd: gauntletRoot, stdio: 'pipe', maxBuffer: 16 * 1024 * 1024 }
  );
}

test('reduced calibration runs are byte-identical across runs', { timeout: 300_000 }, () => {
  const dirA = mkdtempSync(join(tmpdir(), 'gauntlet-calib-a-'));
  const dirB = mkdtempSync(join(tmpdir(), 'gauntlet-calib-b-'));
  try {
    runCalibration(dirA, ['tictactoe', 'mastermind'], 2);
    runCalibration(dirB, ['tictactoe', 'mastermind'], 2);
    for (const gameId of ['tictactoe', 'mastermind']) {
      const a = readFileSync(join(dirA, `${gameId}.json`));
      const b = readFileSync(join(dirB, `${gameId}.json`));
      assert.ok(a.equals(b), `${gameId}.json differs between two identical runs`);
      const table = JSON.parse(a.toString('utf8'));
      assert.equal(table.format, 'playkit-gauntlet-calibration-table/1');
      for (const kind of ['random', 'greedy', 'engine']) {
        const blocks = Object.values(table.baselines[kind].tiers);
        assert.ok(
          blocks.every((block) => /** @type {{episodes: number}} */ (block).episodes > 0),
          `${gameId}/${kind} has empty tiers`
        );
      }
    }
    assert.ok(readFileSync(join(dirA, 'REPORT.md'), 'utf8').includes('# Gauntlet calibration report'));
  } finally {
    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
  }
});

/**
 * One fixture tier row.
 *
 * @typedef {object} FixtureTier
 * @property {string} id
 * @property {number} rank
 * @property {'outcome' | 'efficiency'} scoring
 * @property {number} random
 * @property {number} greedy
 * @property {number} engine
 * @property {number | null} [engineSolved]
 * @property {[number, number] | null} [randomCi]
 * @property {[number, number] | null} [greedyCi]
 * @property {[number, number] | null} [engineCi]
 */

/**
 * Build a calibration-table fixture.
 *
 * @param {string} gameId
 * @param {FixtureTier[]} tiers
 * @returns {CalibrationTable}
 */
function fixtureTable(gameId, tiers) {
  /** @type {Record<string, { tiers: Record<string, *> }>} */
  const baselines = {};
  const ciOf = /** @type {Record<'random' | 'greedy' | 'engine', (t: FixtureTier) => [number, number] | null>} */ ({
    random: (t) => t.randomCi ?? null,
    greedy: (t) => t.greedyCi ?? null,
    engine: (t) => t.engineCi ?? null,
  });
  const kinds = /** @type {['random' | 'greedy' | 'engine', (t: FixtureTier) => number][]} */ ([
    ['random', (t) => t.random],
    ['greedy', (t) => t.greedy],
    ['engine', (t) => t.engine],
  ]);
  for (const [key, pick] of kinds) {
    /** @type {Record<string, *>} */
    const mapped = {};
    for (const tier of tiers) {
      mapped[tier.id] = {
        id: tier.id,
        rank: tier.rank,
        scoring: tier.scoring,
        score: { value: pick(tier), ci95: ciOf[key](tier) },
        solvedFraction: key === 'engine' ? (tier.engineSolved ?? null) : null,
        episodes: 5,
      };
    }
    baselines[key] = { tiers: mapped };
  }
  return {
    format: 'playkit-gauntlet-calibration-table/1',
    game: { id: gameId, version: '1.0.0', benchmark: true },
    split: 'public',
    seedsPerTier: 5,
    baselines,
  };
}

test('checks flag a well-ordered fixture as clean', () => {
  const table = fixtureTable('holdem', [
    { id: 'micro', rank: 1, scoring: 'outcome', random: 0.1, greedy: 0.3, engine: 0.6 },
    { id: 'mid', rank: 2, scoring: 'outcome', random: 0.08, greedy: 0.25, engine: 0.55 },
    {
      id: 'blitz',
      rank: 3,
      scoring: 'efficiency',
      random: 0.05,
      greedy: 0.2,
      engine: 0.5,
      engineSolved: 0.97,
    },
  ]);
  assert.deepEqual(runChecks([table]), []);
});

test('checks flag greedy below random on a tier', () => {
  const table = fixtureTable('minesweeper', [
    {
      id: 'novice',
      rank: 1,
      scoring: 'outcome',
      random: 0.5,
      greedy: 0.4,
      engine: 0.9,
      // Disjoint intervals: the inversion is demonstrated, not noise.
      randomCi: [0.45, 0.55],
      greedyCi: [0.3, 0.44],
      engineCi: [0.85, 0.95],
    },
  ]);
  const violations = runChecks([table]);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].check, 'a-order');
  assert.equal(violations[0].severity, 'violation');
  assert.match(violations[0].detail, /greedy .* < random /);
  assert.match(violations[0].proposal, /re-tune the heuristic/);
});

test('a point inversion with overlapping intervals warns instead of failing', () => {
  const table = fixtureTable('minesweeper', [
    {
      id: 'novice',
      rank: 1,
      scoring: 'outcome',
      random: 0.5,
      greedy: 0.4,
      engine: 0.9,
      // Overlapping intervals: point inversion visible, but within noise.
      randomCi: [0.35, 0.55],
      greedyCi: [0.3, 0.45],
      engineCi: [0.85, 0.95],
    },
  ]);
  const violations = runChecks([table]);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].severity, 'warning');
  assert.match(violations[0].detail, /0\.4 \[0\.3, 0\.45\]/);
});

test('a point inversion with no interval warns instead of failing', () => {
  const table = fixtureTable('minesweeper', [
    { id: 'novice', rank: 1, scoring: 'outcome', random: 0.5, greedy: 0.4, engine: 0.9 },
  ]);
  const violations = runChecks([table]);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].severity, 'warning');
  assert.match(violations[0].detail, /no interval/);
});

test('checks flag engine below greedy on a tier', () => {
  const table = fixtureTable('chess', [
    {
      id: 'paper',
      rank: 1,
      scoring: 'outcome',
      random: 0.0,
      greedy: 0.5,
      engine: 0.3,
      randomCi: [0.0, 0.05],
      greedyCi: [0.45, 0.55],
      engineCi: [0.2, 0.4],
    },
  ]);
  const violations = runChecks([table]);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].check, 'a-order');
  assert.equal(violations[0].severity, 'violation');
  assert.match(violations[0].detail, /engine .* < greedy /);
  assert.match(violations[0].proposal, /engine-side strength/);
});

test('checks flag a random score rising with tier rank', () => {
  const table = fixtureTable('connect4', [
    {
      id: 'bronze',
      rank: 1,
      scoring: 'outcome',
      random: 0.2,
      greedy: 0.4,
      engine: 0.6,
      randomCi: [0.1, 0.3],
      greedyCi: [0.3, 0.5],
      engineCi: [0.5, 0.7],
    },
    {
      id: 'silver',
      rank: 2,
      scoring: 'outcome',
      random: 0.3,
      greedy: 0.4,
      engine: 0.6,
      // Silver's random interval lies entirely above bronze's: violation.
      randomCi: [0.35, 0.45],
      greedyCi: [0.3, 0.5],
      engineCi: [0.5, 0.7],
    },
  ]);
  const violations = runChecks([table]);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].check, 'b-monotonic');
  assert.equal(violations[0].severity, 'violation');
  assert.match(violations[0].detail, /random rises/);
  assert.equal(violations[0].tier, 'silver');
});

test('a rising score with overlapping intervals warns instead of failing', () => {
  const table = fixtureTable('connect4', [
    {
      id: 'bronze',
      rank: 1,
      scoring: 'outcome',
      random: 0.2,
      greedy: 0.4,
      engine: 0.6,
      randomCi: [0.1, 0.3],
      greedyCi: [0.3, 0.5],
      engineCi: [0.5, 0.7],
    },
    {
      id: 'silver',
      rank: 2,
      scoring: 'outcome',
      random: 0.3,
      greedy: 0.4,
      engine: 0.6,
      // Silver's random interval overlaps bronze's: within noise.
      randomCi: [0.25, 0.4],
      greedyCi: [0.3, 0.5],
      engineCi: [0.5, 0.7],
    },
  ]);
  const violations = runChecks([table]);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].severity, 'warning');
});

test('checks flag an engine solving below 95% on an efficiency tier', () => {
  const table = fixtureTable('sokoban', [
    {
      id: 'mini',
      rank: 1,
      scoring: 'efficiency',
      random: 0.0,
      greedy: 0.1,
      engine: 0.4,
      engineSolved: 0.8,
    },
  ]);
  const violations = runChecks([table]);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].check, 'c-solved');
  assert.equal(violations[0].severity, 'violation');
  assert.match(violations[0].detail, /solves 0\.8 .* floor is 0\.95/);
});

test('the tracked REPORT.md matches the committed tables', () => {
  // Pins the tracked report to the committed tables so the two cannot drift
  // apart silently: every table's versioned section header must be present,
  // and the checks section must list exactly the violations recomputed from
  // the committed tables by runChecks() — no stale ones, none missing.
  const tablesDir = join(here, 'tables');
  const tables = readdirSync(tablesDir)
    .filter((f) => f.endsWith('.json') && !f.endsWith('.meta.json'))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(tablesDir, f), 'utf8')));
  assert.ok(tables.length > 0, 'committed calibration tables exist');

  const report = readFileSync(join(here, 'REPORT.md'), 'utf8');

  for (const table of tables) {
    assert.ok(
      report.includes(`### ${table.game.id} (v${table.game.version}`),
      `REPORT.md has a section for ${table.game.id} (v${table.game.version})`,
    );
  }

  const violations = runChecks(tables);
  const expectedErrors = violations
    .filter((v) => v.severity === 'violation')
    .map((v) => `- **${v.game} — ${v.check}** (${v.tier ?? 'cross-tier'}): ${v.detail}`)
    .sort();
  const expectedWarnings = violations
    .filter((v) => v.severity !== 'violation')
    .map((v) => `- ⚠️ ${v.game} — ${v.check} (${v.tier ?? 'cross-tier'}): ${v.detail}`)
    .sort();
  const reportLines = report.split('\n');
  const reported = reportLines
    .filter((line) => /^- \*\*[^*]+ — (a-order|b-monotonic|c-solved)\*\*/.test(line))
    .sort();
  const reportedWarnings = reportLines
    .filter((line) => /^- ⚠️ [^ ]+ — (a-order|b-monotonic|c-solved) \(/.test(line))
    .sort();
  assert.deepEqual(reported, expectedErrors);
  assert.deepEqual(reportedWarnings, expectedWarnings);
});
