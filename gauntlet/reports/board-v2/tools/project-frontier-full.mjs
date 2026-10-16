// Board-v2 frontier cost projection: pilot suite (one seed per tier, 49
// episodes) and FULL official public suite (every public seed of every tier).
//
// Reuses the first-model-board method (reports/first-model-run/tools/
// project-frontier.mjs) for the pilot floor/corrected columns and extends it:
//
// - full floor      = sum over games of publicSeeds(game) x estCallsLowPerEp
//                     x costPerCall(game, model). Games with no estimator low
//                     basis (no bundled baseline, no par) contribute 0, exactly
//                     as in the first-model projection.
// - full corrected  = sum over games of publicSeeds(game) x measuredCallsPerEp
//                     x costPerCall(game, model). Covers ALL 13 games because
//                     the local qwen run completed every episode; this is the
//                     median-expectation column the floor column cannot give.
// - full budget cap = sum over games of publicSeeds(game) x estCallsHighPerEp
//                     x costPerCall(game, model): a weak model that burns its
//                     full action budget everywhere.
//
// Inputs: estimate-local/estimate.json (calls low/high per game),
// estimate-local-check/estimate.json (tokens-per-call back-out),
// usage-qwen.json (measured calls/episode and token split per game),
// prices.frontier.json (rates re-checked 2026-10-16).
//
// Estimates, not measurements. Real runs may cost more.

import { readFileSync, writeFileSync } from 'node:fs';
import { getGame } from '../../../games/index.js';

const estimate = JSON.parse(readFileSync(new URL('../estimates/estimate-local/estimate.json', import.meta.url)));
const check = JSON.parse(readFileSync(new URL('../estimates/estimate-local-check/estimate.json', import.meta.url)));
const usage = JSON.parse(readFileSync(new URL('../usage-qwen.json', import.meta.url)));
const prices = JSON.parse(readFileSync(new URL('../prices.frontier.json', import.meta.url)));
const suite = JSON.parse(readFileSync(new URL('../suite.public.boardv2.json', import.meta.url)));

// Public seeds per game, from the game specs themselves (the committed suite
// manifest only carries the pilot's one seed per tier).
const seedsPerGame = new Map();
for (const g of suite.games) {
  const game = getGame(g.id);
  let n = 0;
  for (const t of game.spec.tiers) n += t.publicSeeds;
  seedsPerGame.set(g.id, n);
}

// Measured per-game calls/episode and token split from the local qwen run.
const measured = new Map();
for (const g of usage.perGame) {
  if (g.calls > 0) {
    const combined = (g.inputTokPerCall ?? 0) + (g.outputTokPerCall ?? 0);
    measured.set(g.gameId, {
      callsPerEp: g.calls / g.episodes.split('/')[0],
      inShare: combined ? (g.inputTokPerCall ?? 0) / combined : 0.9,
    });
  }
}

// Tokens per call: check-price back-out where the estimator has a low basis,
// measured combined tokens otherwise (same fallback as the first-model tool).
const tokPerCall = new Map();
for (const g of check.games) {
  tokPerCall.set(g.gameId, g.callsLow && g.usdLow ? (g.usdLow / g.callsLow) * 1e6 : measured.get(g.gameId)?.combined ?? null);
}

const estGames = new Map(estimate.games.map((g) => [g.gameId, g]));

// Qwen correction ratio per game with an estimator low basis (median fallback),
// identical to the first-model tool.
const ratios = [];
for (const [gameId, m] of measured) {
  const est = estGames.get(gameId);
  if (m.callsPerEp && est?.callsLow) ratios.push(m.callsPerEp / (est.callsLow / est.jobs));
}
ratios.sort((a, b) => a - b);
const medianRatio = ratios.length % 2 ? ratios[(ratios.length - 1) / 2] : (ratios[ratios.length / 2 - 1] + ratios[ratios.length / 2]) / 2;

const rows = [];
for (const [gameId, est] of estGames) {
  const m = measured.get(gameId);
  const tpc = tokPerCall.get(gameId) ?? 0;
  rows.push({
    gameId,
    seeds: seedsPerGame.get(gameId) ?? 0,
    estCallsLowPerEp: est.callsLow === null ? null : est.callsLow / est.jobs,
    estCallsHighPerEp: est.callsHigh / est.jobs,
    estTokPerCall: tpc === null ? null : Math.round(tpc),
    measuredCallsPerEp: m ? Number(m.callsPerEp.toFixed(1)) : null,
    qwenRatio: m?.callsPerEp && est.callsLow ? Number((m.callsPerEp / (est.callsLow / est.jobs)).toFixed(2)) : Number(medianRatio.toFixed(2)),
    inShare: m?.inShare ?? 0.9,
  });
}

const projections = Object.entries(prices).map(([key, p]) => {
  let pilotFloor = 0, pilotCorrected = 0, fullFloor = 0, fullCorrected = 0, fullCap = 0, fullCorrectedCalls = 0, fullCapCalls = 0;
  for (const r of rows) {
    if (r.estTokPerCall === null) continue;
    const inTok = r.estTokPerCall * r.inShare;
    const outTok = r.estTokPerCall - inTok;
    const costPerCall = (inTok * p.inputPerMTok + outTok * p.outputPerMTok) / 1e6;
    const pilotSeeds = 1; // one seed per tier in the pilot suite
    if (r.estCallsLowPerEp !== null) {
      pilotFloor += r.estCallsLowPerEp * costPerCall * pilotSeeds;
      fullFloor += r.estCallsLowPerEp * costPerCall * r.seeds;
    }
    pilotCorrected += (r.measuredCallsPerEp ?? r.estCallsLowPerEp * r.qwenRatio ?? 0) * costPerCall * pilotSeeds;
    fullCorrected += (r.measuredCallsPerEp ?? 0) * costPerCall * r.seeds;
    fullCap += r.estCallsHighPerEp * costPerCall * r.seeds;
    fullCorrectedCalls += (r.measuredCallsPerEp ?? 0) * r.seeds;
    fullCapCalls += r.estCallsHighPerEp * r.seeds;
  }
  return {
    model: key,
    inputPerMTok: p.inputPerMTok,
    outputPerMTok: p.outputPerMTok,
    pilotFloor: Number(pilotFloor.toFixed(2)),
    pilotCorrected: Number(pilotCorrected.toFixed(2)),
    fullFloor: Number(fullFloor.toFixed(2)),
    fullCorrected: Number(fullCorrected.toFixed(2)),
    fullBudgetCap: Number(fullCap.toFixed(2)),
  };
});

const totalSeeds = rows.reduce((a, r) => a + r.seeds, 0);
const result = {
  method: 'floor = estimator low calls (engine/greedy baseline basis) x estimator tokens/call (check-price back-out) at frontier prices; corrected = measured qwen calls/episode x tokens/call (covers every game); budget cap = tier maxActions x tokens/call. Full suite scales each game by its public seed count. Bracket, not point estimate: per-game qwen/floor call ratios span 0.06x-15.97x; stronger models survive longer in engine-opponent games, pushing calls above the corrected column; invalid-action forfeits push below.',
  qwenMedianRatio: Number(medianRatio.toFixed(2)),
  publicEpisodesFullSuite: totalSeeds,
  perGame: rows,
  projections,
};

process.stdout.write(`# Board-v2 frontier cost projection — pilot (49 episodes) and full public suite (${totalSeeds} episodes)\n\n`);
process.stdout.write(`Qwen call-ratio vs estimator low basis: median ${result.qwenMedianRatio}x (games with low basis: ${ratios.length}); per-game span 0.06x-15.97x\n\n`);
process.stdout.write('| Model | $/MTok in | $/MTok out | Pilot floor | Pilot corrected | Full floor | Full corrected | Full budget cap |\n');
process.stdout.write('|---|---:|---:|---:|---:|---:|---:|---:|\n');
for (const p of projections) {
  process.stdout.write(`| ${p.model} | ${p.inputPerMTok} | ${p.outputPerMTok} | ${p.pilotFloor.toFixed(2)} | ${p.pilotCorrected.toFixed(2)} | ${p.fullFloor.toFixed(2)} | ${p.fullCorrected.toFixed(2)} | ${p.fullBudgetCap.toFixed(2)} |\n`);
}
process.stdout.write('\nPer-game inputs (seeds, calls/episode, tokens/call):\n\n| game | seeds | est calls low/ep | est calls high/ep | est tok/call | measured calls/ep | qwen ratio |\n|---|---:|---:|---:|---:|---:|---:|\n');
for (const r of rows) {
  process.stdout.write(`| ${r.gameId} | ${r.seeds} | ${r.estCallsLowPerEp ?? '—'} | ${r.estCallsHighPerEp.toFixed(1)} | ${r.estTokPerCall ?? '—'} | ${r.measuredCallsPerEp ?? '—'} | ${r.qwenRatio} |\n`);
}
writeFileSync(new URL('../projection-frontier-full.json', import.meta.url), JSON.stringify(result, null, 2) + '\n');
