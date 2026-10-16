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
import { mkdtempSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

import { runChecks, TABLE_FORMAT } from './checks.js';
import { renderReport } from './report.js';

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
      assert.equal(table.format, TABLE_FORMAT);
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
    format: TABLE_FORMAT,
    game: { id: gameId, version: '1.0.0', benchmark: true },
    split: 'public',
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

// ---------------------------------------------------------------------------
// Review pins (PR #30 independent review): each assertion below pins a fix and
// was demonstrated to fail against the pre-fix source.
// ---------------------------------------------------------------------------

/** Tolerance for score-ordering comparisons on point estimates. */
const ORDER_EPSILON = 1e-9;

/**
 * Assert random <= greedy <= engine on every tier of a produced table. This is
 * the assertion that pins the negamax mover-perspective terminal fix: with the
 * bug, the tictactoe engine prefers losing lines at odd plies and scores below
 * greedy on perfect-opponent.
 *
 * @param {string} gameId
 * @param {import('./checks.js').CalibrationTable} table
 * @returns {void}
 */
function assertBaselineOrdering(gameId, table) {
  const tierIds = Object.keys(table.baselines.random.tiers);
  assert.ok(tierIds.length > 0, `${gameId} table has no tiers`);
  for (const tierId of tierIds) {
    const random = table.baselines.random.tiers[tierId]?.score.value;
    const greedy = table.baselines.greedy.tiers[tierId]?.score.value;
    const engine = table.baselines.engine.tiers[tierId]?.score.value;
    assert.equal(table.baselines.random.tiers[tierId].episodes > 0, true, `${gameId}/${tierId} random has no episodes`);
    if (typeof random === 'number' && typeof greedy === 'number') {
      assert.ok(
        greedy >= random - ORDER_EPSILON,
        `${gameId}/${tierId}: greedy ${greedy} < random ${random} — baseline ordering broken`
      );
    }
    if (typeof greedy === 'number' && typeof engine === 'number') {
      assert.ok(
        engine >= greedy - ORDER_EPSILON,
        `${gameId}/${tierId}: engine ${engine} < greedy ${greedy} — an engine that prefers losing lines produces exactly this`
      );
    }
  }
}

test('produced tictactoe table orders random <= greedy <= engine on every tier', { timeout: 300_000 }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'gauntlet-calib-order-'));
  try {
    runCalibration(dir, ['tictactoe'], 2);
    const table = JSON.parse(readFileSync(join(dir, 'tictactoe.json'), 'utf8'));
    assertBaselineOrdering('tictactoe', table);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--per-game-cap rejects non-positive and non-finite values', { timeout: 60_000 }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'gauntlet-calib-capflag-'));
  try {
    for (const bad of ['-1', 'abc']) {
      let status = 0;
      let stderr = '';
      try {
        execFileSync(
          process.execPath,
          [
            join(here, 'run.js'),
            '--games=tictactoe',
            `--per-game-cap=${bad}`,
            `--out=${dir}`,
            `--report=${join(dir, 'REPORT.md')}`,
          ],
          { cwd: gauntletRoot, stdio: 'pipe', maxBuffer: 16 * 1024 * 1024 }
        );
      } catch (err) {
        status = /** @type {*} */ (err).status ?? -1;
        stderr = /** @type {Buffer} */ (/** @type {*} */ (err).stderr).toString('utf8');
      }
      assert.equal(status, 1, `--per-game-cap=${bad} must fail the run, got exit ${status}`);
      assert.match(stderr, /--per-game-cap must be a positive/);
      assert.ok(!existsSync(join(dir, 'tictactoe.json')), `--per-game-cap=${bad} must not write a table`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('tables record executed episode coverage, not the requested seed limit', { timeout: 300_000 }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'gauntlet-calib-coverage-'));
  try {
    // tictactoe ships 8 public seeds per tier: requesting 100 must not record 100.
    runCalibration(dir, ['tictactoe'], 100);
    const table = JSON.parse(readFileSync(join(dir, 'tictactoe.json'), 'utf8'));
    assert.ok(!('seedsPerTier' in table), 'table must not carry a requested-seeds field that reads as coverage');
    for (const kind of ['random', 'greedy', 'engine']) {
      const blocks = Object.values(table.baselines[kind].tiers);
      assert.ok(blocks.length > 0);
      const counts = blocks.map((b) => /** @type {{episodes: number}} */ (b).episodes);
      assert.ok(counts.every((n) => n > 0), `${kind} has empty tiers in a full reduced run`);
      assert.equal(new Set(counts).size, 1, `${kind} tiers disagree on executed episode counts`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a capped partial table skips the ordering-pass line and says checks were skipped', () => {
  // Chess-shaped fixture: random and greedy ran, the engine rung never did.
  const tiers = {
    paper: { id: 'paper', rank: 1, scoring: /** @type {'outcome'} */ ('outcome'), score: { value: 0.02, ci95: /** @type {[number, number]} */ ([0, 0.1]) }, solvedFraction: null, episodes: 20 },
    norms: { id: 'norms', rank: 2, scoring: /** @type {'outcome'} */ ('outcome'), score: { value: 0.3, ci95: /** @type {[number, number]} */ ([0.1, 0.5]) }, solvedFraction: null, episodes: 16 },
    deep: { id: 'deep', rank: 3, scoring: /** @type {'outcome'} */ ('outcome'), score: { value: null, ci95: null }, solvedFraction: null, episodes: 0 },
  };
  const table = {
    format: TABLE_FORMAT,
    game: { id: 'chess', version: '1.0.0', benchmark: true },
    split: /** @type {'public'} */ ('public'),
    baselines: {
      random: { tiers: { paper: { ...tiers.paper }, norms: { ...tiers.norms }, deep: { ...tiers.deep } } },
      greedy: { tiers: { paper: { ...tiers.paper }, norms: { ...tiers.norms }, deep: { ...tiers.deep } } },
      engine: { tiers: { paper: { ...tiers.paper, score: { value: null, ci95: null } }, norms: { ...tiers.norms, score: { value: null, ci95: null } }, deep: { ...tiers.deep } } },
    },
  };
  const md = renderReport({
    tables: [table],
    violations: [],
    metas: [{ gameId: 'chess', wallTimeSec: 1381.2, episodesRun: 36, capHit: true }],
    failures: [],
    seedsLimit: null,
    timeCapSec: 1200,
    wallTimeSec: 1381.6,
    env: {
      node: 'test', platform: 'test', cpu: 'test', cores: 1, parallelismUsed: 1, memoryGiB: 1,
      headSha: 'test', baseSha: 'test', mergeParents: [], runAt: '2026-01-01T00:00:00.000Z',
    },
  });
  const chessSection = md.slice(md.indexOf('### chess'));
  assert.doesNotMatch(chessSection, /✅/, 'a table with empty cells must not print the ordering-pass line');
  assert.match(chessSection, /checks skipped/i);
});

test('a fully-run table with no violations still gets the ordering-pass line', () => {
  const table = fixtureTable('holdem', [
    { id: 'micro', rank: 1, scoring: 'outcome', random: 0.1, greedy: 0.3, engine: 0.6 },
  ]);
  const md = renderReport({
    tables: [table],
    violations: [],
    metas: [{ gameId: 'holdem', wallTimeSec: 12, episodesRun: 15, capHit: false }],
    failures: [],
    seedsLimit: null,
    timeCapSec: 1200,
    wallTimeSec: 12,
    env: {
      node: 'test', platform: 'test', cpu: 'test', cores: 1, parallelismUsed: 1, memoryGiB: 1,
      headSha: 'test', baseSha: 'test', mergeParents: [], runAt: '2026-01-01T00:00:00.000Z',
    },
  });
  const section = md.slice(md.indexOf('### holdem'));
  assert.match(section, /✅ ordering checks pass/);
});

test('worker fails fast when an episode wedges past its deadline', { timeout: 30_000 }, async () => {
  // Lazy import: the worker module registers the nine games on load.
  const { runWorker } = await import('./worker.js');
  const dir = mkdtempSync(join(tmpdir(), 'gauntlet-calib-wedge-'));
  try {
    const never = () => new Promise(() => {});
    const result = await runWorker(
      {
        gameId: 'tictactoe',
        seedsLimit: 2,
        tablePath: join(dir, 'tictactoe.json'),
        trajDir: join(dir, 'trajectories'),
        timeCapSec: 1,
      },
      { runEpisodeImpl: /** @type {*} */ (never), episodeGraceSec: 0.2 }
    );
    assert.match(String(result.failure), /exceeded its deadline/, 'a wedged episode must fail the worker');
    assert.equal(result.capHit, true);
    assert.ok(existsSync(join(dir, 'tictactoe.json')), 'the worker writes its partial table for forensics before failing');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
