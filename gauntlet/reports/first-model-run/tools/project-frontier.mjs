#!/usr/bin/env node
/**
 * Project the cost of running the first-model suite against frontier models.
 *
 * Method (all inputs are measured or estimator-produced artifacts — no calls
 * are made to frontier providers):
 *
 * 1. From the local run aggregate (`aggregate-usage.mjs --json run-qwen >
 *    usage-qwen.json`): measured input/output tokens per agent call, per game,
 *    and measured calls per episode for games the run completed.
 * 2. From the official zero-price estimate (`estimate-local/estimate.json`):
 *    the estimator's per-game low/high call bounds (engine/greedy-baseline
 *    basis) for the same suite.
 * 3. From the check-price estimate (`estimate-local-check/estimate.json`,
 *    $1/$1 measurement key): back out the estimator's estimated tokens per
 *    call per tier as usdLow/callsLow * 1e6 (input+output combined, equal
 *    rates). Split combined tokens into input/output shares using the local
 *    run's measured per-game in/out ratio.
 * 4. For each frontier price entry in prices.frontier.json, project:
 *      cost(game) = callsPerEpisode * (inTok * priceIn + outTok * priceOut) / 1e6
 *    summed over the suite's episodes per game, under two call bases:
 *      - floor: the estimator's low calls (baseline-basis episode lengths)
 *      - qwen-corrected: floor * (measured calls/episode / floor), per game
 *        where the local run completed, else the median completed-game ratio.
 *    Caveat: for engine-opponent strategy games a stronger model typically
 *    survives longer, so its episodes run LONGER than the engine baseline's
 *    (more calls, not fewer). The qwen-corrected column inherits the 1.5B
 *    model's fast-forfeit behavior and understates frontier strategy-game
 *    calls; the floor understates everything. Treat the two columns as a
 *    bracket, not a point estimate.
 *
 * Usage:
 *   node tools/project-frontier.mjs --usage usage-qwen.json \
 *     --estimate estimate-local/estimate.json \
 *     --check estimate-local-check/estimate.json \
 *     --prices prices.frontier.json [--json]
 */
import { readFileSync } from 'node:fs';

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? null : process.argv[i + 1];
};
const usagePath = arg('usage');
const estimatePath = arg('estimate');
const checkPath = arg('check');
const pricesPath = arg('prices');
const asJson = process.argv.includes('--json');

if (!usagePath || !estimatePath || !checkPath || !pricesPath) {
  process.stderr.write('usage: node tools/project-frontier.mjs --usage usage.json --estimate estimate.json --check checkEstimate.json --prices prices.json [--json]\n');
  process.exit(2);
}

const usage = JSON.parse(readFileSync(usagePath, 'utf8'));
const estimate = JSON.parse(readFileSync(estimatePath, 'utf8'));
const check = JSON.parse(readFileSync(checkPath, 'utf8'));
const prices = JSON.parse(readFileSync(pricesPath, 'utf8'));

// Measured per-game token/call and calls/episode from the local run.
const measured = new Map();
for (const g of usage.perGame) {
  if (g.calls > 0) {
    const combined = (g.inputTokPerCall ?? 0) + (g.outputTokPerCall ?? 0);
    measured.set(g.gameId, {
      inPerCall: g.inputTokPerCall ?? 0,
      outPerCall: g.outputTokPerCall ?? 0,
      combined,
      inShare: combined ? (g.inputTokPerCall ?? 0) / combined : 0.9,
      callsPerEp: g.complete ? g.calls / g.episodes.split('/')[0] : null,
    });
  }
}

// Estimator per-game call bounds (official estimate) and episodes.
const estGames = new Map();
for (const g of estimate.games) {
  estGames.set(g.gameId, { jobs: g.jobs, callsLow: g.callsLow, callsHigh: g.callsHigh });
}

// Estimator tokens-per-call per game from the check-price estimate (usd basis).
// Per game: totalTokLow = sum over tiers(usdLowTier / callsLowTier * 1e6 * callsLowTier)
//        -> weighted mean tok/call = sum(usdLowTier) / sum(callsLowTier) * 1e6
const tokPerCall = new Map();
for (const g of check.games) {
  if (g.callsLow && g.usdLow) {
    tokPerCall.set(g.gameId, (g.usdLow / g.callsLow) * 1e6);
  } else {
    tokPerCall.set(g.gameId, measured.get(g.gameId)?.combined ?? null);
  }
}

// Qwen correction ratio per completed game; median fallback.
const ratios = [];
for (const [gameId, m] of measured) {
  const est = estGames.get(gameId);
  if (m.callsPerEp && est?.callsLow) ratios.push(m.callsPerEp / (est.callsLow / est.jobs));
}
ratios.sort((a, b) => a - b);
// Median: average the two middle values for an even-length array instead of
// picking the upper middle.
const medianRatio = ratios.length
  ? (ratios.length % 2
      ? ratios[(ratios.length - 1) / 2]
      : (ratios[ratios.length / 2 - 1] + ratios[ratios.length / 2]) / 2)
  : 1;

const rows = [];
for (const [gameId, est] of estGames) {
  const m = measured.get(gameId);
  const tpc = tokPerCall.get(gameId) ?? 0;
  const inShare = m?.inShare ?? 0.9;
  const floorCalls = est.callsLow === null ? null : est.callsLow / est.jobs;
  const ratio = m?.callsPerEp && est.callsLow ? m.callsPerEp / (est.callsLow / est.jobs) : medianRatio;
  rows.push({
    gameId,
    episodes: est.jobs,
    estCallsLowPerEp: floorCalls === null ? null : Number(floorCalls.toFixed(1)),
    estCallsHighPerEp: Number((est.callsHigh / est.jobs).toFixed(1)),
    estTokPerCall: tpc === null ? null : Math.round(tpc),
    measuredCallsPerEp: m?.callsPerEp === null || m === undefined ? null : Number(m.callsPerEp.toFixed(1)),
    qwenRatio: Number(ratio.toFixed(2)),
  });
}

const projections = Object.entries(prices).map(([key, p]) => {
  let floor = 0, corrected = 0, covered = 0;
  for (const r of rows) {
    if (r.estCallsLowPerEp === null || r.estTokPerCall === null) continue;
    const inTok = r.estTokPerCall * (r.gameId && measured.get(r.gameId)?.inShare !== undefined ? (measured.get(r.gameId)?.inShare ?? 0.9) : 0.9);
    const outTok = r.estTokPerCall - inTok;
    const costPerCall = (inTok * p.inputPerMTok + outTok * p.outputPerMTok) / 1e6;
    floor += r.estCallsLowPerEp * costPerCall * r.episodes;
    corrected += r.estCallsLowPerEp * r.qwenRatio * costPerCall * r.episodes;
    covered += r.episodes;
  }
  return {
    model: key,
    inputPerMTok: p.inputPerMTok,
    outputPerMTok: p.outputPerMTok,
    usdFloor: Number(floor.toFixed(2)),
    usdQwenCorrected: Number(corrected.toFixed(2)),
    episodesCovered: covered,
    source: p.source.slice(0, 80) + '…',
  };
});

const result = {
  method: 'floor = estimator low calls (engine/greedy baseline basis) x estimator tokens/call (check-price back-out) at frontier prices. qwen-corrected = floor x per-game measured/floor call ratio where the local run completed the game (median ratio otherwise). Bracket, not point estimate: stronger models survive longer in engine-opponent games, pushing calls above the corrected column; invalid-action forfeits push them below.',
  qwenMedianRatio: Number(medianRatio.toFixed(2)),
  perGame: rows,
  projections,
};

if (asJson || process.argv.includes('--json')) process.stdout.write(JSON.stringify(result, null, 2) + '\n');
else {
  process.stdout.write('# Frontier cost projection — first-model suite (42 episodes)\n\n');
  process.stdout.write(`Qwen call-ratio vs estimator low basis: median ${result.qwenMedianRatio}x (completed games: ${ratios.length})\n\n`);
  process.stdout.write('| Model | $/MTok in | $/MTok out | USD floor | USD qwen-corrected |\n|---|---:|---:|---:|---:|\n');
  for (const p of projections) {
    process.stdout.write(`| ${p.model} | ${p.inputPerMTok} | ${p.outputPerMTok} | ${p.usdFloor.toFixed(2)} | ${p.usdQwenCorrected.toFixed(2)} |\n`);
  }
  process.stdout.write('\nPer-game estimator inputs:\n\n| game | eps | est calls low/ep | est calls high/ep | est tok/call | measured calls/ep | qwen ratio |\n|---|---:|---:|---:|---:|---:|---:|\n');
  for (const r of rows) {
    process.stdout.write(`| ${r.gameId} | ${r.episodes} | ${r.estCallsLowPerEp ?? '—'} | ${r.estCallsHighPerEp} | ${r.estTokPerCall ?? '—'} | ${r.measuredCallsPerEp ?? '—'} | ${r.qwenRatio} |\n`);
  }
}
