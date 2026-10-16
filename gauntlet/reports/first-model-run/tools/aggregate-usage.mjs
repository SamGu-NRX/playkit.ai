#!/usr/bin/env node
/**
 * Aggregate a Gauntlet run directory into per-game measured usage.
 *
 * Reads `<runDir>/run.json` (episode list, counts, caps) and every trajectory
 * under the nested bundle layout, and reports per game:
 *
 * - episodes played / planned, and whether the game is complete in this run
 * - agent calls, invalid actions (rate), consecutive-forfeit endings
 * - input/output tokens (sums and per-call means) from step.usage
 * - wall-clock ms per agent call (mean / p50 / max) from step.ms
 * - the most common rejected (invalid) replies, with one example each
 *
 * When `--estimate <estimate.json>` is passed, also joins the pre-run
 * estimate's per-game low/high call bounds against the measured values and
 * prints the per-game error. Both sides are normalized to calls per episode:
 * the estimate's bounds are suite totals over its `jobs` episodes, so the
 * join divides them by `jobs`, and the measured side divides by the played
 * count encoded in the perGame `episodes` string. Tokens per call are
 * derived only from a *priced* estimate as usdLow/callsLow*1e6 (combined
 * input+output tokens per call at equal in/out rates); a zero-price
 * estimate carries usdLow === 0 and yields no token basis (null). Point
 * --estimate at the check-price estimate for the token columns.
 * Read-only over the run dir;
 * writes nothing. Node 20+, no dependencies.
 *
 * Usage:
 *   node tools/aggregate-usage.mjs <runDir> [--estimate estimate.json] [--json]
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const runDir = args[0];
if (!runDir) {
  process.stderr.write('usage: node tools/aggregate-usage.mjs <runDir> [--estimate estimate.json] [--json]\n');
  process.exit(2);
}
const estimatePath = args.includes('--estimate') ? args[args.indexOf('--estimate') + 1] : null;
const asJson = args.includes('--json');

/** @param {string} dir @returns {string[]} */
function walkTrajectories(dir) {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    const s = statSync(p);
    if (s.isDirectory()) out.push(...walkTrajectories(p));
    else if (name.endsWith('.json') && name !== 'run.json' && name !== 'suite.json') out.push(p);
  }
  return out;
}

const suite = JSON.parse(readFileSync(join(runDir, 'suite.json'), 'utf8'));
let run = {};
try {
  run = JSON.parse(readFileSync(join(runDir, 'run.json'), 'utf8'));
} catch {
  // Mid-flight run: run.json is written atomically at the end; proceed with
  // trajectory-derived aggregates only.
}

/** @type {Map<string, any>} */
const games = new Map();
for (const g of suite.games ?? []) {
  games.set(g.id, {
    gameId: g.id,
    planned: (g.tiers ?? []).reduce((n, t) => n + (t.seeds?.length ?? 0), 0),
    played: 0,
    calls: 0,
    invalid: 0,
    forfeits: 0,
    inputTokens: 0,
    outputTokens: 0,
    ms: [],
    endReasons: {},
  });
}

let totalCalls = 0, totalInvalid = 0, totalIn = 0, totalOut = 0, totalMs = 0;
const rejections = new Map(); // text -> {count, example}

for (const file of walkTrajectories(runDir)) {
  const t = JSON.parse(readFileSync(file, 'utf8'));
  const g = t.game?.id ?? t.gameId;
  const rec = games.get(g) ?? { gameId: g, planned: 0, played: 0 };
  games.set(g, rec);
  rec.played += 1;
  rec.calls = rec.calls || 0;
  rec.invalid = rec.invalid || 0;
  rec.forfeits = rec.forfeits || 0;
  rec.inputTokens = rec.inputTokens || 0;
  rec.outputTokens = rec.outputTokens || 0;
  rec.ms = rec.ms || [];
  rec.endReasons = rec.endReasons || {};

  if (t.end?.reason) rec.endReasons[t.end.reason] = (rec.endReasons[t.end.reason] ?? 0) + 1;
  if (t.end?.reason === 'forfeit-invalid') rec.forfeits += 1;

  for (const step of t.steps ?? []) {
    if (step.by !== 'agent') continue;
    rec.calls += 1;
    totalCalls += 1;
    if (typeof step.ms === 'number') { rec.ms.push(step.ms); totalMs += step.ms; }
    const u = step.usage;
    if (u) {
      rec.inputTokens += u.inputTokens ?? 0;
      rec.outputTokens += u.outputTokens ?? 0;
      totalIn += u.inputTokens ?? 0;
      totalOut += u.outputTokens ?? 0;
    }
    if (step.invalid) {
      rec.invalid += 1;
      totalInvalid += 1;
      const text = String(step.reply?.text ?? '');
      const key = text.length > 0 ? text : '(empty reply)';
      const r = rejections.get(key) ?? { count: 0, example: { text: key, game: g, tier: t.tier, seed: t.seed } };
      r.count += 1;
      rejections.set(key, r);
    }
  }
}

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const pct = (a, p) => (a.length ? [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor((a.length - 1) * p))] : null);
const r6 = (v) => (typeof v === 'number' ? Number(v.toFixed(6)) : v);

const perGame = [...games.values()].map((g) => ({
  gameId: g.gameId,
  episodes: `${g.played}/${g.planned}`,
  complete: g.played === g.planned,
  calls: g.calls,
  invalid: g.invalid,
  invalidRate: g.calls ? r6(g.invalid / g.calls) : null,
  forfeits: g.forfeits ?? 0,
  endReasons: g.endReasons,
  inputTokens: g.inputTokens,
  outputTokens: g.outputTokens,
  inputTokPerCall: g.calls ? r6(g.inputTokens / g.calls) : null,
  outputTokPerCall: g.calls ? r6(g.outputTokens / g.calls) : null,
  msPerCall: { mean: g.ms.length ? Math.round(mean(g.ms)) : null, p50: pct(g.ms, 0.5), max: g.ms.length ? Math.max(...g.ms) : null },
}));

const overall = {
  runId: run.run?.id ?? run.id ?? null,
  agent: run.agent?.spec ?? run.agent?.id ?? null,
  calls: totalCalls,
  invalidActions: totalInvalid,
  invalidRate: totalCalls ? r6(totalInvalid / totalCalls) : null,
  inputTokens: totalIn,
  outputTokens: totalOut,
  msPerCallMean: totalCalls ? Math.round(totalMs / totalCalls) : null,
  stopReason: run.stopped ?? null,
  counts: run.counts ?? null,
  caps: run.limits ?? null,
};

const topRejections = [...rejections.values()]
  .sort((a, b) => b.count - a.count)
  .slice(0, 5)
  .map((r) => ({ count: r.count, text: r.example.text.slice(0, 120), where: `${r.example.game}/${r.example.tier} @ ${r.example.seed}` }));

/** @returns {any} */
function estimatorJoin() {
  if (!estimatePath) return null;
  const est = JSON.parse(readFileSync(estimatePath, 'utf8'));
  const perGameEst = est.games ?? est.perGame ?? [];
  const list = Array.isArray(perGameEst) ? perGameEst : Object.values(perGameEst);
  return list.map((e) => {
    const id = e.gameId ?? e.game;
    const m = perGame.find((g) => g.gameId === id);
    const jobs = e.jobs ?? null;
    const lowCalls = e.calls?.low ?? e.callsLow ?? null;
    const highCalls = e.calls?.high ?? e.callsHigh ?? null;
    // The estimate's call bounds are suite totals over `jobs` episodes;
    // normalize both sides to calls per episode before comparing.
    const lowCallsPerEp = lowCalls != null && jobs ? lowCalls / jobs : null;
    const highCallsPerEp = highCalls != null && jobs ? highCalls / jobs : null;
    // perGame records the played count inside the "played/planned" episodes
    // string; there is no numeric `played` field.
    const played = m ? Number(String(m.episodes ?? '').split('/')[0]) : 0;
    const complete = m?.complete === true && played > 0;
    const callsPerEp = complete ? r6(m.calls / played) : null;
    // Tokens per call only from a priced estimate: combined (in+out) tokens
    // per call = usdLow / callsLow * 1e6 at equal in/out rates. The
    // zero-price official estimate has usdLow === 0, i.e. no token basis.
    const usdLow = e.usd?.low ?? e.usdLow ?? null;
    const estInPerCall = usdLow > 0 && lowCalls ? r6((usdLow / lowCalls) * 1e6) : null;
    return {
      gameId: id,
      estLowCallsPerEp: lowCallsPerEp === null ? null : r6(lowCallsPerEp),
      estHighCallsPerEp: highCallsPerEp === null ? null : r6(highCallsPerEp),
      measuredCallsPerEpisode: callsPerEp,
      callErrorVsLowPct:
        callsPerEp !== null && lowCallsPerEp ? r6((callsPerEp - lowCallsPerEp) / lowCallsPerEp * 100) : null,
      estInputTokPerCall: estInPerCall,
      measuredInputTokPerCall: m?.inputTokPerCall ?? null,
      inputTokPerCallErrorPct:
        estInPerCall !== null && m?.inputTokPerCall ? r6((m.inputTokPerCall - estInPerCall) / estInPerCall * 100) : null,
    };
  });
}

const result = { overall, perGame, topRejections, estimatorJoin: estimatorJoin() };
if (asJson) process.stdout.write(JSON.stringify(result, null, 2) + '\n');
else {
  process.stdout.write(`# Usage aggregate — ${runDir}\n\n`);
  process.stdout.write(`agent ${overall.agent} · calls ${overall.calls} · invalid ${overall.invalidActions} (${(100 * overall.invalidRate).toFixed(1)}%) · in ${overall.inputTokens} tok · out ${overall.outputTokens} tok · ${overall.msPerCallMean} ms/call mean\n\n`);
  process.stdout.write('| game | eps | calls | invalid | in tok/call | out tok/call | ms/call mean/p50/max | ends |\n|---|---|---:|---:|---:|---:|---|---|\n');
  for (const g of perGame) {
    process.stdout.write(`| ${g.gameId} | ${g.episodes} | ${g.calls} | ${g.invalid} (${(100 * g.invalidRate).toFixed(1)}%) | ${g.inputTokPerCall ?? '—'} | ${g.outputTokPerCall ?? '—'} | ${g.msPerCall.mean}/${g.msPerCall.p50}/${g.msPerCall.max} | ${Object.entries(g.endReasons).map(([k, v]) => `${k}:${v}`).join(' ') || '—'} |\n`);
  }
  process.stdout.write('\nTop rejected replies:\n');
  for (const r of topRejections) process.stdout.write(`- ${r.count}× ${JSON.stringify(r.text)} (${r.where})\n`);
  if (result.estimatorJoin) {
    process.stdout.write('\nEstimator check (measured vs pre-run estimate):\n\n| game | est calls/ep low–high | measured calls/ep | call err vs low | est in tok/call | measured in tok/call | tok err |\n|---|---|---:|---:|---:|---:|---:|\n');
    for (const e of result.estimatorJoin) {
      process.stdout.write(`| ${e.gameId} | ${e.estLowCallsPerEp ?? '—'}–${e.estHighCallsPerEp ?? '—'} | ${e.measuredCallsPerEpisode ?? '—'} | ${e.callErrorVsLowPct === null ? '—' : e.callErrorVsLowPct + '%'} | ${e.estInputTokPerCall ?? '—'} | ${e.measuredInputTokPerCall ?? '—'} | ${e.inputTokPerCallErrorPct === null ? '—' : e.inputTokPerCallErrorPct + '%'} |\n`);
    }
  }
}
