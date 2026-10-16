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

import { readFileSync, readdirSync, statSync } from 'node:fs';
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

/** Recursively list trajectory .json files under the run dir (not run.json). */
function walkTrajectories() {
  const out = [];
  const stack = [runDir];
  while (stack.length > 0) {
    const dir = stack.pop();
    for (const name of readdirSync(dir)) {
      const p = `${dir}/${name}`;
      if (statSync(p).isDirectory()) stack.push(p);
      else if (name.endsWith('.json') && name !== 'run.json' && name !== 'suite.json') out.push(p);
    }
  }
  return out;
}

// run.json's calls/spendUsd cover only the invocation that wrote it. After a
// --resume that is a partial-run figure, so when the bundle says it skipped
// episodes (verified from an earlier invocation), aggregate the full run from
// the trajectories themselves, which carry per-step usage.
let calls = run.calls;
let spendUsd = run.spendUsd;
let actualSource = 'run.json (this invocation only)';
if ((run.counts?.skipped ?? 0) > 0) {
  let trajCalls = 0;
  let trajSpend = 0;
  let files = 0;
  for (const entry of walkTrajectories()) {
    files += 1;
    const t = readJson(entry);
    if (!t || !t.steps) continue;
    for (const step of t.steps) {
      if (step.usage) {
        trajCalls += 1;
        if (Number.isFinite(step.usage.costUsd)) trajSpend += step.usage.costUsd;
      }
    }
  }
  if (files > 0) {
    calls = trajCalls;
    spendUsd = trajSpend;
    actualSource = `${files} trajectories (full bundle across resumes)`;
  }
}

const lines = [];
lines.push('estimate vs actual');
lines.push(`  calls  actual ${calls}  | estimated low ${totals.callsLow ?? '—'} / high ${totals.callsHigh}`);
lines.push(`         actual from ${actualSource}`);
if (Number.isFinite(totals.callsLow)) {
  lines.push(`         error vs low ${pct(calls, totals.callsLow)}, vs high ${pct(calls, totals.callsHigh)}`);
}
if (spendUsd !== undefined) {
  const usdLow = totals.usdLow ?? null;
  const usdHigh = totals.usdHigh ?? null;
  const fmt = (v) => (Number.isFinite(v) ? `$${v.toFixed(4)}` : '—');
  lines.push(`  spend  actual $${Number(spendUsd).toFixed(6)}  | estimated low ${fmt(usdLow)} / high ${fmt(usdHigh)}`);
  if (Number.isFinite(usdLow)) {
    lines.push(`         error vs low ${pct(spendUsd, usdLow)}, vs high ${pct(spendUsd, usdHigh)}`);
  }
}
if (run.unknownCostSteps > 0) {
  lines.push(`  note   ${run.unknownCostSteps} step(s) reported usage without a priced cost — actual spend is understated`);
}
if (run.counts?.unplayed > 0) {
  lines.push(`  note   ${run.counts.unplayed} episode(s) unplayed in this bundle — actual is a partial-run figure`);
}
console.log(lines.join('\n'));
