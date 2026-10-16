#!/usr/bin/env node
/**
 * Re-render `calibration/REPORT.md` from the committed calibration tables
 * without re-running any game.
 *
 * The tracked report must match the committed tables (calibration.test.js
 * pins this), but a full `calibration/run.js` run takes wall-time most
 * table-change packets do not need: the tables are already on disk and the
 * report is a pure function of them. This script loads every committed
 * `calibration/tables/<id>.json` plus its `.meta.json` run record, recomputes
 * the ordering checks with the same `runChecks()` the runner uses, and
 * re-renders the report through the same `renderReport()` the runner uses —
 * so a re-render is byte-equivalent to what the runner would have written for
 * these tables, minus the run-clock provenance.
 *
 * Run-section honesty: everything the renderer prints about the run (wall
 * time, episodes, caps) comes from the committed per-game meta files, not
 * from this process. Environment and provenance lines describe the machine
 * and HEAD at render time.
 *
 * Usage (from `gauntlet/`):
 *
 *   node calibration/render-report.js
 *   node calibration/render-report.js --report=/tmp/REPORT.md
 *
 * @module
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { availableParallelism, cpus, platform, release, arch, totalmem } from 'node:os';
import { execSync } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runChecks } from './checks.js';
import { renderReport } from './report.js';

const here = dirname(fileURLToPath(import.meta.url));
const tablesDir = join(here, 'tables');

/** Default per-game wall cap reported when the run's cap is not recoverable from metas. */
const DEFAULT_TIME_CAP_SEC = 1200;

/**
 * Shallow git query with a fallback value, mirroring run.js.
 *
 * @param {string} cmd
 * @param {string} fallback
 * @returns {string}
 */
function git(cmd, fallback) {
  try {
    return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || fallback;
  } catch {
    return fallback;
  }
}

// ---- Flags -----------------------------------------------------------------

/** @type {{ report: string, timeCapSec: number }} */
const options = { report: join(here, 'REPORT.md'), timeCapSec: DEFAULT_TIME_CAP_SEC };
for (const arg of process.argv.slice(2)) {
  const match = /^--([a-z-]+)(?:=(.*))?$/.exec(arg);
  if (!match) {
    console.error(`render-report: unrecognized argument ${JSON.stringify(arg)}`);
    process.exit(2);
  }
  const [, flag, value] = match;
  if (flag === 'report' && value) {
    options.report = resolve(value);
  } else if (flag === 'time-cap' && value) {
    const n = Number(value);
    if (!(n > 0)) {
      console.error(`render-report: --time-cap must be a positive number of seconds (got ${JSON.stringify(value)})`);
      process.exit(2);
    }
    options.timeCapSec = n;
  } else {
    console.error(`render-report: unrecognized or malformed argument ${JSON.stringify(arg)}`);
    process.exit(2);
  }
}

// ---- Load committed tables and their run metas ------------------------------

const tableFiles = readdirSync(tablesDir)
  .filter((f) => f.endsWith('.json') && !f.endsWith('.meta.json'))
  .sort();
if (tableFiles.length === 0) {
  console.error('render-report: no calibration tables in calibration/tables — nothing to render');
  process.exit(1);
}

/** @type {*} */
const tables = [];
/** @type {{ gameId: string, wallTimeSec: number, episodesRun: number, capHit: boolean }[]} */
const metas = [];
/** @type {string[]} */
const missingMetas = [];

for (const f of tableFiles) {
  const table = JSON.parse(readFileSync(join(tablesDir, f), 'utf8'));
  tables.push(table);
  const metaPath = join(tablesDir, `${f}.meta.json`);
  if (!existsSync(metaPath)) {
    missingMetas.push(table.game.id);
    continue;
  }
  metas.push(JSON.parse(readFileSync(metaPath, 'utf8')));
}

if (missingMetas.length > 0) {
  console.error(
    `render-report: no .meta.json run record for ${missingMetas.join(', ')} — those game sections will not carry a _Run:_ line (produce one with node calibration/run.js)`
  );
}

// ---- Re-render ---------------------------------------------------------------

const violations = runChecks(/** @type {*} */ (tables));

// Wall time is the sum of the committed per-game worker times — the honest
// aggregation available at render time (the runner's own wall clock covered
// the workers in parallel, so this may exceed the original run's wall time).
const wallTimeSec = Math.round(metas.reduce((sum, m) => sum + (m.wallTimeSec ?? 0), 0) * 10) / 10;

const parentShas = git('git log --format=%P -1 HEAD', '').split(/\s+/).filter(Boolean);

const report = renderReport({
  tables,
  violations,
  metas,
  failures: [],
  seedsLimit: null,
  timeCapSec: options.timeCapSec,
  wallTimeSec,
  env: {
    node: process.version,
    platform: `${platform()} ${release()} ${arch()}`,
    cpu: cpus()[0]?.model.trim() ?? 'unknown',
    cores: cpus().length,
    parallelismUsed: Math.max(1, availableParallelism() - 1),
    memoryGiB: Math.round((totalmem() / 2 ** 30) * 10) / 10,
    headSha: git('git rev-parse --short=12 HEAD', 'not-a-git-checkout'),
    baseSha: git('git rev-parse --short=12 obv/burst5-playkit-scoring-leaderboard 2>/dev/null', 'unknown'),
    mergeParents: parentShas,
    runAt: new Date().toISOString(),
  },
});

writeFileSync(options.report, report);

const errorCount = violations.filter((v) => v.severity === 'violation').length;
const warningCount = violations.length - errorCount;
console.error(`[render-report] ${tables.length} table(s) from calibration/tables`);
console.error(`[render-report] report at ${options.report}`);
console.error(
  `[render-report] checks: ${errorCount} violation(s), ${warningCount} within-noise warning(s)`
);
