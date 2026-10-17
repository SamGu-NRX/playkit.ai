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
  if (report.pageOnly) {
    lines.push('manifest n/a — standalone page-session bundle (no suite manifest)');
  } else {
    lines.push(
      `manifest ${report.manifestHash.ok ? 'ok' : 'MISMATCH'} — recorded ${
        report.manifestHash.recorded ?? 'none'
      }, recomputed ${report.manifestHash.actual}`
    );
  }
  if (!report.pageOnly) {
    const failed = report.trajectories.filter((t) => !t.ok);
    lines.push(
      `episodes ${report.trajectories.length - failed.length}/${report.trajectories.length} verified${
        failed.length > 0 ? `, ${failed.length} FAILED` : ''
      }`
    );
    for (const failure of failed) {
      lines.push(`  FAIL  ${failure.key} — ${failure.reason ?? 'unspecified'}`);
    }
  }
  // Page sessions are reported separately from trajectories: a live page is
  // unseeded and never scores, so their logs are audited, not scored.
  if (report.pageSessions.length > 0) {
    const failedPages = report.pageSessions.filter((p) => !p.ok);
    lines.push(
      `page sessions ${report.pageSessions.length - failedPages.length}/${report.pageSessions.length} verified${
        failedPages.length > 0 ? `, ${failedPages.length} FAILED` : ''
      }`
    );
    for (const failure of failedPages) {
      lines.push(`  FAIL  ${failure.file} — ${failure.reason ?? 'unspecified'}`);
    }
  }
  lines.push(
    `strays   ${report.stray.length === 0 ? 'none' : report.stray.join(', ')}`
  );
  // The spend ledger: one summary line when it verifies, per-problem lines
  // when it does not. Absent (present: false) on bundles written before the
  // ledger existed — those stay quiet so old bundles verify unchanged.
  if (report.ledger?.present) {
    if (report.ledger.ok) {
      lines.push(
        `ledger   ok — ${report.ledger.calls} call(s) checked, totalUsd ${report.ledger.totalUsd.toFixed(6)}${report.ledger.cap !== null ? ` / cap ${report.ledger.cap}` : ''}${report.ledger.unwoundCalls > 0 ? `, ${report.ledger.unwoundCalls} unwound (${report.ledger.unwoundUsd.toFixed(6)})` : ''}`
      );
    } else {
      lines.push('ledger   FAILED');
      for (const problem of report.ledger.problems) {
        lines.push(`  FAIL  ${problem}`);
      }
    }
  }
  if (report.pageOnly) {
    lines.push('score    n/a — page sessions are refereed logs, never scored');
  } else if (report.score) {
    lines.push(`score    recomputed (see ${options.outDir}/run.json provenance)`);
  } else {
    lines.push(`score    not recomputed — ${report.scoreError ?? 'unknown reason'}`);
  }
  lines.push(report.ok ? 'verdict  ok' : 'verdict  FAILED');
  process.stdout.write(lines.join('\n') + '\n');
  return report;
}
