/**
 * Fit tests: the fitter's math on synthetic episodes with hand-computed
 * answers, byte-identical reproduction of the committed `params.js` from the
 * committed `runs-data.json`, and the extractor's fixture pipeline against a
 * real episode run by the core runner. Temp directories only; no engine
 * probes and no network.
 *
 * @module
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { runEpisode } from '../../core/runner.js';
import { tictactoe } from '../../games/tictactoe/index.js';

import { extractEpisode } from './extract-runs.mjs';
import { listGames } from '../../games/index.js';
import {
  buildParams,
  fitFromEpisodes,
  holdoutTable,
  renderParamsJs,
  tokenSizeFit,
  verdictTable,
  withSpecCaps,
} from './fit.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

/** @typedef {{ source: string, model: string, game: string, tier: string, endReason: string, maxActions: number, agentActions: number, hashValidSteps: number, steps: Array<[number|null, number|null, number, number|null]> }} TestEpisode */

/**
 * @param {Partial<TestEpisode>} overrides
 * @returns {TestEpisode}
 */
function episode(overrides = {}) {
  return /** @type {TestEpisode} */ ({
    source: 'test-source',
    model: 'm1',
    game: 'g',
    tier: 't',
    endReason: 'terminal',
    maxActions: 10,
    agentActions: 4,
    hashValidSteps: 1,
    steps: [[100, 10, 0, 500]],
    ...overrides,
  });
}

test('fitFromEpisodes: means and maxima over synthetic episodes, hand-computed', () => {
  const data = [
    episode({ model: 'm1', agentActions: 4, steps: [[100, 10, 0, null], [200, 20, 1, null]] }),
    episode({ model: 'm2', agentActions: 8, steps: [[300, 30, 0, null]] }),
  ];
  const fit = fitFromEpisodes(data);
  const t = fit.tiers['g/t'];
  // callsExpected = (4 + 8) / 2 = 6
  assert.equal(t.callsExpected, 6);
  // in tokens: mean(100, 200, 300) = 200; max 300
  assert.equal(t.inExpected, 200);
  assert.equal(t.inWorst, 300);
  // out tokens: mean(10, 20, 30) = 20; max 30
  assert.equal(t.outExpected, 20);
  assert.equal(t.outWorst, 30);
  // invalid rate: 1 invalid call out of 3
  assert.equal(t.invalidRate, 0.3333);
  assert.equal(t.budgetBound, false);
  assert.equal(t.episodes, 2);
  assert.deepEqual(t.models, ['m1', 'm2']);
  assert.deepEqual(t.sources, ['test-source']);
  assert.deepEqual(fit.sources, ['test-source']);
});

test('fitFromEpisodes: budget-bound flag and empty-usage tiers', () => {
  const fit = fitFromEpisodes([
    episode({ agentActions: 10, maxActions: 10, endReason: 'budget' }),
    episode({ agentActions: 10, maxActions: 10, endReason: 'budget' }),
  ]);
  const t = fit.tiers['g/t'];
  assert.equal(t.callsExpected, 10);
  assert.equal(t.budgetBound, true);
  assert.equal(t.endReasons.budget, 2);
});

test('holdoutTable: leave-one-model-out ratios match hand computation', () => {
  const data = {
    sources: ['a'],
    episodes: [
      episode({ model: 'm1', agentActions: 4, steps: [[100, 10, 0, null]] }),
      episode({ model: 'm2', agentActions: 6, steps: [[200, 20, 0, null]] }),
    ],
  };
  const oldB = new Map([
    ['g/t', { callsLow: 12, tokens: { input: { mean: 60, max: 70 }, output: { mean: 1, max: 2 } }, basis: 'engine-probe' }],
  ]);
  const { perModel, summary } = holdoutTable(data, oldB);

  // m1 held out: the fit sees only m2 → calls 6, tokens 200.
  const m1 = perModel.m1.tiers[0];
  assert.equal(m1.tier, 'g/t');
  assert.equal(m1.measuredCalls, 4);
  assert.equal(m1.fittedCalls, 6);
  assert.equal(m1.afterCalls, 1.5); // 6 / 4
  assert.equal(m1.beforeCalls, 3); // 12 / 4
  assert.equal(m1.measuredIn, 100);
  assert.equal(m1.fittedIn, 200);
  assert.equal(m1.afterTokens, 2); // 200 / 100
  assert.equal(m1.beforeTokens, 0.6); // 60 / 100

  // m2 held out: the fit sees only m1 → calls 4, tokens 100.
  const m2 = perModel.m2.tiers[0];
  assert.equal(m2.afterCalls, 0.667); // 4 / 6, rounded
  assert.equal(m2.beforeCalls, 2); // 12 / 6
  assert.equal(m2.afterTokens, 0.5); // 100 / 200
  assert.equal(m2.beforeTokens, 0.3); // 60 / 200

  // Summary rows exist for both games-metrics.
  assert.ok(summary.find((/** @type {any} */ s) => s.model === 'm1' && s.metric === 'calls' && s.after === 1.5));
  assert.ok(summary.find((/** @type {any} */ s) => s.model === 'm2' && s.metric === 'tokens' && s.after === 0.5));
});

test('holdoutTable: a tier with a single model leaves the aggregate cells null', () => {
  const data = { sources: ['a'], episodes: [episode({ model: 'm1' })] };
  const { perModel } = holdoutTable(data, new Map());
  const row = perModel.m1.games[0];
  assert.equal(row.game, 'g');
  // Nothing to fit against: the game row reports nulls, not guesses.
  assert.equal(row.afterCalls, null);
  assert.equal(row.afterTokens, null);
  assert.equal(row.beforeCalls, null);
  assert.equal(row.beforeTokens, null);
});

test('tokenSizeFit: recovers a known tokens-per-character relationship', () => {
  // y = 0.25x + 50 (i.e. 4 chars/token above the intercept).
  /** @type {TestEpisode[]} */
  const data = [];
  for (let i = 0; i < 10; i++) {
    const x = 1000 + i * 100;
    data.push(episode({ steps: [[0.25 * x + 50, 5, 0, x]] }));
  }
  const fit = tokenSizeFit(data);
  const g = fit.g;
  assert.equal(g.calls, 10);
  assert.equal(g.slopeTokensPerChar, 0.25);
  assert.equal(g.interceptTokens, 50);
  assert.equal(g.impliedCharsPerToken, 4);
  assert.equal(g.r2, 1);
});

test('tokenSizeFit: too few hash-verified points reports rather than guesses', () => {
  const fit = tokenSizeFit([episode({ steps: [[100, 5, 0, 400]] })]);
  assert.match(fit.g.note, /too few/);
});

test('verdictTable: worst fold-change across models, with explicit n/a for unverified games', () => {
  // connect4: ratios 1.229 and 0.944 across two models → worst fold 1.23 (within 2x).
  // sokoban: ratios 15 and 0.067 → worst fold 15 (bifurcated; beyond 2x).
  // 2048: no cross-model data → n/a, not a pass.
  const summary = [
    { game: 'connect4', model: 'm1', metric: 'calls', before: 2.133, after: 1.229 },
    { game: 'connect4', model: 'm2', metric: 'calls', before: 2.889, after: 0.944 },
    { game: 'connect4', model: 'm1', metric: 'tokens', before: 0.854, after: 0.996 },
    { game: 'connect4', model: 'm2', metric: 'tokens', before: 0.857, after: 1.002 },
    { game: 'sokoban', model: 'm1', metric: 'calls', before: null, after: 15 },
    { game: 'sokoban', model: 'm2', metric: 'calls', before: null, after: 0.067 },
    { game: 'sokoban', model: 'm1', metric: 'tokens', before: 1.027, after: 1.008 },
    { game: 'sokoban', model: 'm2', metric: 'tokens', before: 1.023, after: 0.992 },
    { game: '2048', model: 'm1', metric: 'calls', before: null, after: null },
    { game: '2048', model: 'm1', metric: 'tokens', before: null, after: null },
  ];
  const verdicts = verdictTable({ summary });
  const byGame = new Map(verdicts.map((v) => [v.game, v]));
  const connect4 = byGame.get('connect4');
  const sokoban = byGame.get('sokoban');
  const nA = byGame.get('2048');
  assert.ok(connect4 && sokoban && nA);
  assert.equal(nA.callsTransfer, 'n/a');
  assert.equal(nA.tokensTransfer, 'n/a');
  assert.equal(nA.callsWorst, null);
});

test('the committed params.js reproduces byte-identically from the committed runs-data.json', () => {
  const data = JSON.parse(readFileSync(join(HERE, 'runs-data.json'), 'utf8'));
  // The committed params.js carries callsCap from the live tier specs — the
  // same enrichment `node runs/estimate-fit/fit.mjs` performs before writing.
  const params = withSpecCaps(
    buildParams(data),
    new Map(listGames().map((g) => [g.spec.id, g]))
  );
  const rendered = renderParamsJs(params);
  const committed = readFileSync(join(HERE, 'params.js'), 'utf8');
  assert.equal(rendered, committed, 'params.js must be regenerable with `node runs/estimate-fit/fit.mjs`');
  // And the fit actually covers the registry tiers it claims.
  assert.ok(Object.keys(params.tiers).length >= 40, `fit covers ${Object.keys(params.tiers).length} tiers`);
  assert.equal(params.format, 'playkit-gauntlet-estimate-fit/1');
});

test('extractor: a real tictactoe episode extracts with consistent counts', async () => {
  // A deterministic scripted agent so the episode is reproducible.
  /** @type {import('../../core/types.js').Agent} */
  const agent = {
    id: 'openai-chat/test-extractor',
    track: 'official',
    act: async (/** @type {any} */ ctx) => ({ text: String(ctx.legalActions?.[0] ?? 'a1') }),
  };
  const trajectory = await runEpisode({ game: tictactoe, tierId: 'perfect-opponent', seed: 'tictactoe/perfect-opponent/public/0', agent });
  const result = extractEpisode(
    'test-source',
    new Map([['tictactoe', { game: tictactoe, spec: tictactoe.spec }]]),
    trajectory
  );
  assert.ok(result.ok, `extraction failed: ${result.ok ? '' : result.reason}`);
  const extracted = result.ok ? result.episode : null;
  assert.equal(extracted.agentActions, trajectory.end.agentActions);
  assert.equal(extracted.steps.length, trajectory.end.agentActions);
  assert.ok(['terminal', 'budget', 'forfeit-invalid', 'forfeit-stalled', 'forfeit-empty'].includes(extracted.endReason));
  // The scripted agent produces no provider usage: unknowns stay null.
  for (const step of extracted.steps) {
    assert.equal(step[0], null);
    assert.equal(step[1], null);
  }
  // The record replays hash-verified against the current spec (same session).
  assert.equal(extracted.hashValidSteps, extracted.steps.length);
  assert.ok(extracted.agent);
  assert.match(extracted.agent, /test-extractor/);
});
