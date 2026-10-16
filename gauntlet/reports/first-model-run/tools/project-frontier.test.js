import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

/**
 * Pin for tools/project-frontier.mjs median handling (PR #41 review, finding 6):
 * the qwen-correction fallback median picked the upper middle element for
 * even-length ratio arrays (ratios[Math.floor(n/2)]) instead of averaging the
 * two middle values. Not latent for the committed run: the 8 completed ratios
 * have middle pair 0.60/0.80, so the committed median 0.8 was the upper-middle
 * artifact — the true median is 0.7. The projection's dollar columns are
 * unaffected (games without a low basis are excluded from the cost loop); the
 * committed projection-frontier artifacts were regenerated with the fix.
 */

const here = dirname(fileURLToPath(import.meta.url));
const tool = join(here, 'project-frontier.mjs');

/** Build fixture files whose completed-game call ratios are exactly `ratios`. */
/** @param {number[]} ratios */
function fixtures(ratios) {
  const dir = mkdtempSync(join(tmpdir(), 'pf-fixture-'));
  const games = ratios.map((r, i) => ({ gameId: `g${i}` }));
  // ratio = (calls/3) / (callsLow/jobs) with jobs=3, callsLow=9 -> basis 3.
  // So calls = 3 * basis * ratio = 9 * ratio.
  const usage = {
    overall: {},
    perGame: ratios.map((r, i) => ({
      gameId: `g${i}`,
      episodes: '3/3',
      complete: true,
      calls: 9 * r,
      invalid: 0,
      invalidRate: 0,
      forfeits: 0,
      endReasons: {},
      inputTokens: 100 * 9 * r,
      outputTokens: 50 * 9 * r,
      inputTokPerCall: 100,
      outputTokPerCall: 50,
      msPerCall: { mean: 1, p50: 1, max: 1 },
    })),
    topRejections: [],
    estimatorJoin: null,
  };
  const estimate = { games: games.map((g) => ({ ...g, jobs: 3, callsLow: 9, callsHigh: 30 })) };
  const check = { games: games.map((g) => ({ ...g, callsLow: 9, usdLow: 0.9 })) };
  const prices = { testm: { inputPerMTok: 1, outputPerMTok: 1, source: 'fixture' } };
  const p = (/** @type {string} */ name, /** @type {unknown} */ obj) => {
    writeFileSync(join(dir, name), JSON.stringify(obj));
    return join(dir, name);
  };
  return {
    usage: p('usage.json', usage),
    estimate: p('estimate.json', estimate),
    check: p('check.json', check),
    prices: p('prices.json', prices),
  };
}

/** @param {{ usage: string, estimate: string, check: string, prices: string }} paths */
function runProjection(paths) {
  return JSON.parse(
    execFileSync(
      process.execPath,
      [tool, '--usage', paths.usage, '--estimate', paths.estimate, '--check', paths.check, '--prices', paths.prices, '--json'],
      { encoding: 'utf8' },
    ),
  );
}

test('median fallback averages the two middle values for an even ratio count', () => {
  const result = runProjection(fixtures([1, 2, 3, 4]));
  assert.equal(result.qwenMedianRatio, 2.5); // old code picked ratios[2] = 3
});

test('median fallback keeps the middle value for an odd ratio count', () => {
  const result = runProjection(fixtures([1, 2, 3]));
  assert.equal(result.qwenMedianRatio, 2);
});
