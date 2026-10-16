/**
 * Tests for the calibration-table loader (`scoring/generate-baseline.js`),
 * run as a real subprocess against fixture tables directories.
 *
 * The load-bearing refusal: a table whose game version differs from the
 * registered game's version must stop the baseline generation by name — the
 * tier means encode the old rules' outcome distribution, and a baseline built
 * from one would rescale current play against stale numbers.
 *
 * @module
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GAMES } from '../games/index.js';

const gauntletRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const script = join(gauntletRoot, 'scoring', 'generate-baseline.js');
const committedTables = join(gauntletRoot, 'calibration', 'tables');

/**
 * A scratch tables directory holding one JSON table, plus the output path.
 *
 * @param {string} name Basename for the fixture table.
 * @param {unknown} table The table object to write.
 * @returns {{ dir: string, out: string }}
 */
function fixtureDir(name, table) {
  const dir = mkdtempSync(join(tmpdir(), 'gauntlet-genbaseline-'));
  writeFileSync(join(dir, name), `${JSON.stringify(table, null, 2)}\n`);
  return { dir, out: join(dir, 'out', 'random-public.json') };
}

/**
 * Run the loader against a fixture directory.
 *
 * @param {string} dir
 * @param {string} out
 * @returns {{ status: number | null, stdout: string, stderr: string }}
 */
function runLoader(dir, out) {
  return spawnSync(process.execPath, [script, `--tables=${dir}`, `--out=${out}`], {
    encoding: 'utf8',
  });
}

test('the loader accepts a table whose version matches the registered game', () => {
  const bytes = readFileSync(join(committedTables, 'tictactoe.json'), 'utf8');
  const { dir, out } = fixtureDir('tictactoe.json', JSON.parse(bytes));
  try {
    const run = runLoader(dir, out);
    assert.equal(run.status, 0, `loader exits clean:\n${run.stderr}`);
    const baseline = JSON.parse(readFileSync(out, 'utf8'));
    const registered = /** @type {{ spec: { version: string } }} */ (GAMES['tictactoe']);
    assert.equal(baseline.games['tictactoe'].version, registered.spec.version);
    const tiers = Object.values(/** @type {Record<string, { mean: number }>} */ (baseline.games['tictactoe'].tiers));
    assert.ok(tiers.length > 0, 'the baseline records the table tiers');
    assert.ok(tiers.every((t) => Number.isFinite(t.mean)), 'every tier mean is finite');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the loader refuses a table calibrated on a different game version', () => {
  const table = JSON.parse(readFileSync(join(committedTables, 'tictactoe.json'), 'utf8'));
  table.game.version = '0.0.1';
  const { dir, out } = fixtureDir('tictactoe.json', table);
  try {
    const run = runLoader(dir, out);
    assert.equal(run.status, 1, 'a stale-version table stops the generation');
    assert.match(run.stderr, /was calibrated on game version 0\.0\.1 but the installed game is version/);
    assert.match(run.stderr, /regenerate it with node calibration\/run\.js --games=tictactoe/);
    assert.equal(existsSync(out), false, 'no baseline is written from a stale table');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the loader refuses a table for a game that is not registered', () => {
  const table = JSON.parse(readFileSync(join(committedTables, 'tictactoe.json'), 'utf8'));
  table.game.id = 'not-a-game';
  const { dir, out } = fixtureDir('not-a-game.json', table);
  try {
    const run = runLoader(dir, out);
    assert.equal(run.status, 1, 'an unregistered game cannot be version-checked');
    assert.match(run.stderr, /game "not-a-game", which is not registered/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
