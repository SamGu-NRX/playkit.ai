#!/usr/bin/env node
/**
 * estimate-check.mjs — compare an estimate written before a run with the
 * run's own provenance record, and print the error.
 *
 * Usage: node estimate-check.mjs <run-dir> <estimate-dir>
 *
 * Reads <estimate-dir>/estimate.json (playkit-gauntlet-estimate/1, totals in
 * jobs/calls/callsLow/callsHigh/usdLow/usdHigh) and <run-dir>/run.json
 * (playkit-gauntlet-run/1: calls, spendUsd). Exit code is 0 either way; this
 * is a report, not a gate.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

const [runDir, estimateDir] = process.argv.slice(2);
if (!runDir || !estimateDir) {
  console.error('usage: node estimate-check.mjs <run-dir> <estimate-dir>');
  process.exit(2);
}

function readJson(p) {
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

const run = readJson(path.join(runDir, 'run.json'));
const estimate = readJson(path.join(estimateDir, 'estimate.json'));
if (!run) {
  console.error(`estimate-check: no run.json under ${runDir} (was the run started?)`);
  process.exit(1);
}
if (!estimate) {
  console.error(`estimate-check: no estimate.json under ${estimateDir} — run the estimator first`);
  process.exit(1);
}

const totals = estimate.totals ?? {};
const pct = (actual, predicted) =>
  predicted && Number.isFinite(predicted) && predicted !== 0
    ? `${(((actual - predicted) / predicted) * 100).toFixed(1)}%`
    : 'n/a';

const lines = [];
lines.push('estimate vs actual');
lines.push(`  calls  actual ${run.calls}  | estimated low ${totals.callsLow ?? '—'} / high ${totals.callsHigh}`);
if (Number.isFinite(totals.callsLow)) {
  lines.push(`         error vs low ${pct(run.calls, totals.callsLow)}, vs high ${pct(run.calls, totals.callsHigh)}`);
}
if (run.spendUsd !== undefined) {
  const usdLow = totals.usdLow ?? null;
  const usdHigh = totals.usdHigh ?? null;
  const fmt = (v) => (Number.isFinite(v) ? `$${v.toFixed(4)}` : '—');
  lines.push(`  spend  actual $${Number(run.spendUsd).toFixed(6)}  | estimated low ${fmt(usdLow)} / high ${fmt(usdHigh)}`);
  if (Number.isFinite(usdLow)) {
    lines.push(`         error vs low ${pct(run.spendUsd, usdLow)}, vs high ${pct(run.spendUsd, usdHigh)}`);
  }
}
if (run.unknownCostSteps > 0) {
  lines.push(`  note   ${run.unknownCostSteps} step(s) reported usage without a priced cost — actual spend is understated`);
}
if (run.counts?.unplayed > 0) {
  lines.push(`  note   ${run.counts.unplayed} episode(s) unplayed in this bundle — actual is a partial-run figure`);
}
console.log(lines.join('\n'));
