/**
 * The calibration runner: `node calibration/run.js` from `gauntlet/`.
 *
 * Spawns one worker process per game (`worker.js`) to use the machine's CPUs,
 * collects the per-game tables into `calibration/tables/<game>.json`, applies
 * the ordering checks from `checks.js`, and renders `calibration/REPORT.md`.
 * Trajectories are written to a temporary directory and deleted when the run
 * finishes (keep them with `--keep-trajectories`).
 *
 * Flags:
 *   --games=<csv|all>        subset of games, default all
 *   --seeds=<n|all>          first n public seeds per tier, default all
 *   --out=<dir>              table output directory, default calibration/tables
 *   --report=<path>          report path, default calibration/REPORT.md
 *   --per-game-cap=<sec>     wall-time cap per game's worker, default 1200
 *   --trajectories=<dir>     trajectory output dir, default a fresh temp dir
 *   --keep-trajectories      do not delete the trajectory dir at the end
 *
 * Exit code 0 when every game's table was produced (violations are findings,
 * reported in REPORT.md, not failures); 1 when a worker crashed.
 *
 * @module
 */

import { spawn } from 'node:child_process';
import { cpus, availableParallelism, totalmem, platform, release, arch } from 'node:os';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

import { CALIBRATION_GAMES } from './games.js';
import { runChecks } from './checks.js';
import { renderReport } from './report.js';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * @typedef {object} RunMeta
 * @property {string} gameId
 * @property {number} wallTimeSec
 * @property {number} episodesRun
 * @property {boolean} capHit
 */

const args = /** @type {Record<string, string | boolean | null>} */ ({});
for (const arg of process.argv.slice(2)) {
  const match = /^--([a-z-]+)(?:=(.*))?$/.exec(arg);
  if (match) args[match[1]] = match[2] ?? true;
}

/** @type {string[] | null} */
const gamesFilter = typeof args.games === 'string' && args.games !== 'all' ? args.games.split(',').map((s) => s.trim()) : null;
const games = gamesFilter
  ? CALIBRATION_GAMES.filter((g) => gamesFilter.includes(g.id))
  : [...CALIBRATION_GAMES];
if (games.length === 0) {
  console.error(`run.js: no games matched --games=${JSON.stringify(args.games)} (available: ${CALIBRATION_GAMES.map((g) => g.id).join(', ')})`);
  process.exit(1);
}

/** @type {number | null} */
const seedsLimit = typeof args.seeds === 'string' && args.seeds !== 'all' ? Number(args.seeds) : null;
if (seedsLimit !== null && (!Number.isInteger(seedsLimit) || seedsLimit < 1)) {
  console.error(`run.js: --seeds must be a positive integer or "all"`);
  process.exit(1);
}

const outDir = resolve(typeof args.out === 'string' ? args.out : join(here, 'tables'));
const reportPath = resolve(typeof args.report === 'string' ? args.report : join(here, 'REPORT.md'));
const timeCapSec = typeof args['per-game-cap'] === 'string' ? Number(args['per-game-cap']) : 1200;
if (!Number.isFinite(timeCapSec) || timeCapSec <= 0) {
  console.error(`run.js: --per-game-cap must be a positive number of seconds (got ${JSON.stringify(args['per-game-cap'])})`);
  process.exit(1);
}
const trajDir = typeof args.trajectories === 'string' ? resolve(args.trajectories) : mkdtempSync('/tmp/gauntlet-calibration-');
const keepTrajectories = args['keep-trajectories'] === true;
mkdirSync(outDir, { recursive: true });
mkdirSync(trajDir, { recursive: true });

/**
 * @param {string} command
 * @returns {string} Command output, or a fallback on failure.
 */
function git(command, fallback = 'unknown') {
  try {
    return execSync(command, { cwd: here, encoding: 'utf8' }).trim() || fallback;
  } catch {
    return fallback;
  }
}

const headSha = git('git rev-parse --short=12 HEAD', 'not-a-git-checkout');
const baseSha = git('git rev-parse --short=12 obv/burst5-playkit-scoring-leaderboard 2>/dev/null', 'unknown');
const parentShas = git('git log --format=%P -1 HEAD', '').split(/\s+/).filter(Boolean);

// Run workers with a pool so the machine's CPUs are used without oversubscribing.
const concurrency = Math.max(1, Math.min(games.length, availableParallelism() - 1));

// Last-resort parent watchdog: the worker enforces the cap per episode (see
// worker.js), but a wedged child that never exits would hang the whole run.
// Kill it past cap + episode grace + this slack and record a failure. Must
// stay strictly larger than the worker's own episode deadline (cap + grace),
// which lets a legitimately long final episode finish in grace the way chess
// did on the first full run (1381.5s against a 1200s cap).
const EPISODE_GRACE_SEC = Number(process.env.CALIBRATION_EPISODE_GRACE_SEC ?? 900);
const WATCHDOG_SLACK_SEC = Number(process.env.CALIBRATION_WATCHDOG_SLACK_SEC ?? 120);
/** @type {RunMeta[]} */
const metas = [];
/** @type {string[]} */
const failures = [];
const queue = [...games];
const startedAtMs = Date.now();

/**
 * @returns {Promise<void>}
 */
async function drain() {
  while (queue.length > 0) {
    const game = /** @type {(typeof queue)[number]} */ (queue.shift());
    const tablePath = join(outDir, `${game.id}.json`);
    const config = JSON.stringify({
      gameId: game.id,
      seedsLimit,
      tablePath,
      trajDir,
      timeCapSec,
    });
    const started = Date.now();
    console.error(`[run] ${game.id}: worker started (cap ${timeCapSec}s)`);
    const watchdogSec = timeCapSec + EPISODE_GRACE_SEC + WATCHDOG_SLACK_SEC;
    let watchdogFired = false;
    const code = await new Promise((resolvePromise) => {
      const child = spawn(process.execPath, [join(here, 'worker.js'), config], {
        stdio: ['ignore', 'inherit', 'inherit'],
      });
      const watchdog = setTimeout(() => {
        watchdogFired = true;
        child.kill('SIGKILL');
      }, watchdogSec * 1000);
      child.on('exit', (code) => {
        clearTimeout(watchdog);
        resolvePromise(code ?? -1);
      });
      child.on('error', () => {
        clearTimeout(watchdog);
        resolvePromise(-1);
      });
    });
    if (watchdogFired) {
      failures.push(`${game.id}: watchdog killed the worker after ${watchdogSec}s — an episode wedged past the wall cap`);
      console.error(`[run] ${game.id}: WATCHDOG KILL (no exit within ${watchdogSec}s)`);
      continue;
    }
    if (code !== 0 || !existsSync(tablePath)) {
      failures.push(`${game.id}: worker exited ${code} after ${Math.round((Date.now() - started) / 100) / 10}s`);
      console.error(`[run] ${game.id}: FAILED (exit ${code})`);
      continue;
    }
    metas.push(JSON.parse(readFileSync(`${tablePath}.meta.json`, 'utf8')));
    console.error(`[run] ${game.id}: done in ${Math.round((Date.now() - started) / 100) / 10}s`);
  }
}

await Promise.all(Array.from({ length: concurrency }, drain));

if (failures.length > 0) {
  console.error(`[run] ${failures.length} worker(s) failed:\n${failures.join('\n')}`);
}
if (!keepTrajectories) {
  try {
    rmSync(trajDir, { recursive: true, force: true });
  } catch {
    // best effort; the temp dir is not part of the deliverable
  }
}

const tables = metas
  .map((m) => join(outDir, `${m.gameId}.json`))
  .sort()
  .map((path) => JSON.parse(readFileSync(path, 'utf8')));
const violations = runChecks(/** @type {*} */ (tables));

const wallTimeSec = Math.round((Date.now() - startedAtMs) / 100) / 10;
const report = renderReport({
  tables: /** @type {*} */ (tables),
  violations,
  metas,
  failures,
  seedsLimit,
  timeCapSec,
  wallTimeSec,
  env: {
    node: process.version,
    platform: `${platform()} ${release()} ${arch()}`,
    cpu: cpus()[0]?.model.trim() ?? 'unknown',
    cores: cpus().length,
    parallelismUsed: concurrency,
    memoryGiB: Math.round((totalmem() / 2 ** 30) * 10) / 10,
    headSha,
    baseSha,
    mergeParents: parentShas,
    runAt: new Date().toISOString(),
  },
});
writeFileSync(reportPath, report);

console.error(`[run] tables in ${outDir}, report at ${reportPath}`);
console.error(`[run] wall time ${wallTimeSec}s, checks: ${violations.length} violation(s)`);
for (const violation of violations) {
  console.error(`[check:${violation.check}] ${violation.detail}`);
}
process.exit(failures.length > 0 ? 1 : 0);
