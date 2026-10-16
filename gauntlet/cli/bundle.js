/**
 * `gauntlet bundle verify`: check a results bundle written by `gauntlet run`
 * without replaying episodes — trajectory re-verification, manifest-hash
 * match, stray-file detection, and a recomputed score — through
 * `gauntlet/runs/bundle.js`. Exit code 1 when any check fails, so shell
 * pipelines can gate on it.
 *
 * Node-only.
 *
 * @module
 */

import { listGames } from '../games/index.js';
import { verifyBundle } from '../runs/bundle.js';

/**
 * @typedef {object} BundleOptions
 * @property {string} outDir The results bundle directory (`run`'s --out).
 * @property {boolean} [json] --json: print the full report as JSON (default
 *   prints a human-readable verdict).
 */

/**
 * Verify a bundle and print the verdict.
 *
 * @param {BundleOptions} options
 * @returns {Promise<import('../runs/bundle.js').BundleReport>}
 */
export async function printBundleVerify(options) {
  const report = await verifyBundle(options.outDir, listGames());

  if (options.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    return report;
  }

  const lines = [`bundle   ${report.outDir}`];
  lines.push(
    `manifest ${report.manifestHash.ok ? 'ok' : 'MISMATCH'} — recorded ${
      report.manifestHash.recorded ?? 'none'
    }, recomputed ${report.manifestHash.actual}`
  );
  const failed = report.trajectories.filter((t) => !t.ok);
  lines.push(
    `episodes ${report.trajectories.length - failed.length}/${report.trajectories.length} verified${
      failed.length > 0 ? `, ${failed.length} FAILED` : ''
    }`
  );
  for (const failure of failed) {
    lines.push(`  FAIL  ${failure.key} — ${failure.reason ?? 'unspecified'}`);
  }
  lines.push(
    `strays   ${report.stray.length === 0 ? 'none' : report.stray.join(', ')}`
  );
  if (report.score) {
    lines.push(`score    recomputed (see ${options.outDir}/run.json provenance)`);
  } else {
    lines.push(`score    not recomputed — ${report.scoreError ?? 'unknown reason'}`);
  }
  lines.push(report.ok ? 'verdict  ok' : 'verdict  FAILED');
  process.stdout.write(lines.join('\n') + '\n');
  return report;
}
