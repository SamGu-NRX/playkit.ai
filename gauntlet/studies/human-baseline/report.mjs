#!/usr/bin/env node
/**
 * Human-baseline kit: verify a folder of human-played trajectories and report
 * per tier the solved fraction and the action count against par.
 *
 * This is the reporting half of the human-baseline workflow. The playing half
 * is the human agent itself (`gauntlet play --agent human`, agents/human.js):
 * a person plays an episode at the terminal, the recording verifies like any
 * other, and this script turns a folder of those recordings into the numbers
 * the RHAE human baseline needs (docs/DESIGN.md section 5: the scoring `h` is
 * ARC-AGI's "solved pass@2 by at least two humans" — Gauntlet substitutes
 * solver par for `h` because, until now, no person could play an episode).
 *
 * What it does, per trajectory file:
 *   1. Replays and verifies it with `verifyTrajectory` (core/trajectory.js) —
 *      the same verifier `gauntlet verify` uses, so a folder that passes here
 *      passes there. Unverified or wrong-version recordings are reported and
 *      fail the run (exit 1); they never contribute to the report rows.
 *   2. Aggregates it into its (game, tier) row: episode count, solved
 *      fraction, mean episode score (the outcome the runner recorded), mean
 *      agent actions (invalid attempts included, exactly as scoring counts
 *      them), and where the tier's outcomes carry a par (efficiency tiers),
 *      the mean actions-versus-par ratio.
 *
 * What it does NOT do: it never changes scoring. No profile, floor, or
 * leaderboard rule is touched or re-implemented — the report reads the
 * recorded outcomes and counts, and presents them. The open floor-profile
 * decision (#36) lives in scoring, not here.
 *
 * Usage:
 *   node report.mjs <file-or-dir>... [--json] [--out <file>]
 *
 *   <file-or-dir>  A trajectory file, or a directory walked recursively for
 *                  *.json (run bundles, `gauntlet run --out` dirs, and plain
 *                  folders of recordings all work; run.json, suite.json,
 *                  leaderboard.json and _* files are skipped).
 *   --json         Print the report as JSON instead of a table.
 *   --out <file>   Also write the report (JSON) to a file.
 *
 * Exit status: 0 when every trajectory verified, 1 otherwise (the report is
 * still printed/written, with the failures listed).
 *
 * @module
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { getGame } from '../../games/index.js';
import { verifyTrajectory } from '../../core/trajectory.js';

/**
 * Every *.json trajectory file under a path: files are used as-is
 * (name-checked), directories walked recursively.
 *
 * @param {string} path
 * @param {string[]} out
 * @returns {void}
 */
function collectTrajectoryFiles(path, out) {
  const stat = statSync(path);
  if (!stat.isDirectory()) {
    out.push(path);
    return;
  }
  for (const name of readdirSync(path).sort()) {
    if (name.startsWith('_') || name === 'run.json' || name === 'suite.json' || name === 'leaderboard.json') {
      continue;
    }
    const child = join(path, name);
    if (statSync(child).isDirectory()) {
      collectTrajectoryFiles(child, out);
      continue;
    }
    if (name.endsWith('.json')) out.push(child);
  }
}

/**
 * @typedef {object} TierRow
 * @property {string} game Game id.
 * @property {string} tier Tier id.
 * @property {number} episodes Verified episodes in the row.
 * @property {number} solved Episodes whose outcome.solved is true (efficiency
 *   tiers set it; outcome tiers leave it undefined and count 0 here — their
 *   score is the outcome itself, see meanScore).
 * @property {number} solvedFraction solved / episodes.
 * @property {number} meanScore Mean of outcome.normalized[agentSeat] — the
 *   episode score exactly as the runner recorded it.
 * @property {number} meanActions Mean agent actions per episode (invalid
 *   attempts included, the same count scoring uses).
 * @property {number} meanInvalidActions Mean invalid attempts per episode.
 * @property {number | null} meanPar Mean recorded par (null when no episode
 *   on the tier carried one — outcome tiers).
 * @property {number | null} meanActionsVsPar Mean of agentActions / par per
 *   episode (null when no par); 1.0 is par play, 2.0 twice par.
 */

/**
 * @typedef {object} Report
 * @property {{ total: number, verified: number, failed: number }} trajectories
 * @property {{ file: string, reason: string }[]} failures
 * @property {TierRow[]} tiers
 */

const args = process.argv.slice(2);
const paths = [];
let json = false;
let outFile = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--json') {
    json = true;
  } else if (args[i] === '--out') {
    outFile = args[++i];
  } else if (args[i] === '--help' || args[i] === '-h') {
    process.stdout.write(
      'usage: node report.mjs <trajectory-file-or-dir>... [--json] [--out <file>]\n' +
        '\nVerifies every trajectory (the same verifyTrajectory gauntlet verify ' +
        'uses) and reports per tier: solved fraction, mean score, mean agent ' +
        'actions, and actions vs par. Reads only; changes no scoring.\n'
    );
    process.exit(0);
  } else {
    paths.push(args[i]);
  }
}
if (paths.length === 0) {
  process.stderr.write('usage: node report.mjs <trajectory-file-or-dir>... [--json] [--out <file>]\n');
  process.exit(2);
}

/** @type {string[]} */
const files = [];
for (const p of paths) {
  collectTrajectoryFiles(resolve(p), files);
}
if (files.length === 0) {
  process.stderr.write('no trajectory files found under the given paths\n');
  process.exit(2);
}

/** @type {Report['failures']} */
const failures = [];

/**
 * One verified trajectory folded into its tier accumulator.
 *
 * @type {Map<string, { game: string, tier: string, n: number, solved: number, scoreSum: number, actionsSum: number, invalidSum: number, parSum: number, parN: number, vsParSum: number }>}
 */
const rows = new Map();

for (const file of files) {
  /** @type {any} */
  let trajectory;
  try {
    trajectory = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    failures.push({ file, reason: `unreadable JSON: ${err instanceof Error ? err.message : String(err)}` });
    continue;
  }
  if (trajectory?.format !== 'playkit-gauntlet-trajectory/1') {
    failures.push({ file, reason: 'not a playkit-gauntlet-trajectory/1 file' });
    continue;
  }
  /** @type {ReturnType<typeof getGame> | null} */
  let game = null;
  try {
    game = getGame(trajectory.game?.id);
  } catch {
    game = null;
  }
  if (!game) {
    failures.push({ file, reason: `unknown game "${trajectory.game?.id}"` });
    continue;
  }
  const verdict = await verifyTrajectory(game, trajectory);
  if (!verdict.ok) {
    failures.push({
      file,
      reason: `replay verification failed at step ${verdict.step}: ${verdict.reason}`,
    });
    continue;
  }

  const tierId = String(trajectory.tier);
  const key = `${trajectory.game.id}/${tierId}`;
  if (!rows.has(key)) {
    rows.set(key, { game: trajectory.game.id, tier: tierId, n: 0, solved: 0, scoreSum: 0, actionsSum: 0, invalidSum: 0, parSum: 0, parN: 0, vsParSum: 0 });
  }
  const row = rows.get(key);
  const seat = trajectory.agent?.seat ?? 0;
  const outcome = trajectory.end?.outcome;
  const par = outcome && outcome.par != null ? Number(outcome.par) : null;
  row.n += 1;
  if (outcome?.solved === true) row.solved += 1;
  row.scoreSum += Number(outcome?.normalized?.[seat] ?? 0);
  row.actionsSum += Number(trajectory.end?.agentActions ?? 0);
  row.invalidSum += Number(trajectory.end?.invalidActions ?? 0);
  if (par !== null) {
    row.parSum += par;
    row.parN += 1;
    row.vsParSum += trajectory.end.agentActions / par;
  }
}

/** @type {TierRow[]} */
const tierRows = [...rows.values()]
  .sort((a, b) => (a.game === b.game ? a.tier.localeCompare(b.tier) : a.game.localeCompare(b.game)))
  .map((row) => ({
    game: row.game,
    tier: row.tier,
    episodes: row.n,
    solved: row.solved,
    solvedFraction: row.solved / row.n,
    meanScore: row.scoreSum / row.n,
    meanActions: row.actionsSum / row.n,
    meanInvalidActions: row.invalidSum / row.n,
    meanPar: row.parN > 0 ? row.parSum / row.parN : null,
    meanActionsVsPar: row.parN > 0 ? row.vsParSum / row.parN : null,
  }));

/** @type {Report} */
const report = {
  trajectories: { total: files.length, verified: files.length - failures.length, failed: failures.length },
  failures,
  tiers: tierRows,
};

if (json) {
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
} else {
  process.stdout.write(
    [
      `human-baseline report — ${report.trajectories.verified}/${report.trajectories.total} trajectories verified, ${report.trajectories.failed} failed`,
      '',
      'game/tier                          n  solved  meanScore  meanActions  meanInvalid  par   actions/par',
    ].join('\n') + '\n'
  );
  for (const row of tierRows) {
    const par = row.meanPar === null ? '—' : row.meanPar.toFixed(1);
    const vsPar = row.meanActionsVsPar === null ? '—' : row.meanActionsVsPar.toFixed(2);
    process.stdout.write(
      [
        `${row.game}/${row.tier}`.padEnd(34),
        String(row.episodes).padStart(2),
        row.solvedFraction.toFixed(2).padStart(6),
        row.meanScore.toFixed(3).padStart(9),
        row.meanActions.toFixed(1).padStart(12),
        row.meanInvalidActions.toFixed(1).padStart(12),
        par.padStart(5),
        vsPar.padStart(12),
      ].join('') + '\n'
    );
  }
  process.stdout.write(
    '\nsolved counts outcome.solved (efficiency tiers); outcome-tier results read meanScore. ' +
      'meanActions counts invalid attempts, exactly as scoring does. Report only — no scoring rule is changed.\n'
  );
  for (const failure of failures) {
    process.stdout.write(`FAIL ${failure.file}\n     ${failure.reason}\n`);
  }
}
if (outFile) {
  writeFileSync(outFile, JSON.stringify(report, null, 2) + '\n');
}
if (failures.length > 0) process.exit(1);
