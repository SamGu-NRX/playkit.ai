import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, copyFileSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const gauntletRoot = resolve(here, '..');
const script = join(gauntletRoot, 'calibration/render-report.js');
const sampleTable = join(gauntletRoot, 'calibration/tables/tictactoe.json');

/**
 * Fixture tables dir: one committed table plus a hand-written meta. The
 * renderer resolves the report's per-game cap from these metas (or the
 * --time-cap flag) — these tests pin that resolution.
 */
/**
 * @param {{ gameId: string, wallTimeSec: number, episodesRun: number, capHit: boolean, failure: string | null, timeCapSec?: number }} meta
 */
function fixture(meta) {
  const dir = mkdtempSync(join(tmpdir(), 'render-cap-'));
  copyFileSync(sampleTable, join(dir, 'tictactoe.json'));
  writeFileSync(join(dir, 'tictactoe.json.meta.json'), `${JSON.stringify(meta)}\n`);
  return dir;
}

/**
 * @param {string} dir
 * @param {string[]} args
 */
function render(dir, args = []) {
  const outReport = join(dir, 'REPORT.md');
  const r = spawnSync('node', [script, `--report=${outReport}`, ...args], {
    encoding: 'utf8',
    cwd: gauntletRoot,
    env: { ...process.env, GAUNTLET_CALIBRATION_TABLES: dir },
    timeout: 60000,
  });
  const report = existsSync(outReport) ? readFileSync(outReport, 'utf8') : null;
  return { ...r, outReport, report };
}

test('refuses a capped run whose cap is not recoverable (pre-recording metas)', () => {
  const dir = fixture({ gameId: 'tictactoe', wallTimeSec: 1, episodesRun: 1, capHit: true, failure: null });
  const r = render(dir);
  assert.equal(r.status, 1, `stderr: ${r.stderr}`);
  assert.match(r.stderr, /--time-cap/, 'must say what the operator should pass');
  rmSync(dir, { recursive: true, force: true });
});

test('an explicit --time-cap renders even when metas carry no recorded cap', () => {
  const dir = fixture({ gameId: 'tictactoe', wallTimeSec: 1, episodesRun: 1, capHit: true, failure: null });
  const r = render(dir, ['--time-cap=900']);
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  assert.match(r.report ?? '', /\| Per-game wall cap \| 900s \|/);
  rmSync(dir, { recursive: true, force: true });
});

test('the cap recorded in the metas is used without a flag', () => {
  const dir = fixture({ gameId: 'tictactoe', wallTimeSec: 1, episodesRun: 1, capHit: true, failure: null, timeCapSec: 900 });
  const r = render(dir);
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  assert.match(r.report ?? '', /\| Per-game wall cap \| 900s \|/);
  rmSync(dir, { recursive: true, force: true });
});

test('an explicit --time-cap overrides a recorded cap', () => {
  const dir = fixture({ gameId: 'tictactoe', wallTimeSec: 1, episodesRun: 1, capHit: true, failure: null, timeCapSec: 900 });
  const r = render(dir, ['--time-cap=1200']);
  // operator flag wins even against a recorded cap
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  assert.match(r.report ?? '', /\| Per-game wall cap \| 1200s \|/);
  rmSync(dir, { recursive: true, force: true });
});

test('conflicting recorded caps refuse without an explicit flag', () => {
  const dir = mkdtempSync(join(tmpdir(), 'render-cap-'));
  copyFileSync(sampleTable, join(dir, 'tictactoe.json'));
  writeFileSync(join(dir, 'tictactoe.json.meta.json'), `${JSON.stringify({ gameId: 'tictactoe', capHit: false, timeCapSec: 900 })}\n`);
  // a second game table with a different recorded cap
  copyFileSync(sampleTable, join(dir, '2048.json'));
  writeFileSync(join(dir, '2048.json.meta.json'), `${JSON.stringify({ gameId: '2048', capHit: false, timeCapSec: 600 })}\n`);
  const r = render(dir);
  assert.equal(r.status, 1, `stderr: ${r.stderr}`);
  assert.match(r.stderr, /conflicting per-game caps/);
  rmSync(dir, { recursive: true, force: true });
});

test('an uncapped run with no recorded cap keeps the historical 1200 default', () => {
  const dir = fixture({ gameId: 'tictactoe', wallTimeSec: 1, episodesRun: 1, capHit: false, failure: null });
  const r = render(dir);
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  assert.match(r.report ?? '', /\| Per-game wall cap \| 1200s \|/);
  rmSync(dir, { recursive: true, force: true });
});
