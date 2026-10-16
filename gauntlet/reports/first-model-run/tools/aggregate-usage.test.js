import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';

/**
 * Pins for tools/aggregate-usage.mjs against the committed first-model-run
 * artifacts. The --estimate join was observed (PR #41 review, finding 1) to
 * produce NaN/null against the estimate files shipped in this PR:
 *   - perGame entries carry episodes as the string "3/3" with no numeric
 *     `played`, so measured-calls-per-episode divided by undefined -> NaN;
 *   - the token read targeted fields (tokens.input.mean / inputTokensPerCall)
 *     that the estimate schema does not have;
 *   - the zero-price official estimate carries usdLow === 0, so it has no
 *     token basis at all; only a priced estimate (the $1/$1 check estimate)
 *     can back out tokens/call.
 * The join also normalized neither side per episode: estLowCalls/estHighCalls
 * are suite totals over `jobs` episodes while the measured column was
 * calls-per-episode.
 */

const here = dirname(fileURLToPath(import.meta.url)); // .../reports/first-model-run/tools
const runDir = join(here, '..', 'run-qwen');
const officialEstimate = join(here, '..', 'estimate-local', 'estimate.json');
const checkEstimate = join(here, '..', 'estimate-local-check', 'estimate.json');
const committedUsage = join(here, '..', 'usage-qwen.json');
const tool = join(here, 'aggregate-usage.mjs');

/** @param {string[]} args */
const runTool = (args) =>
  execFileSync(process.execPath, [tool, runDir, ...args], { encoding: 'utf8' });

test('usage aggregate regen (no --estimate) is byte-identical to the committed usage-qwen.json', () => {
  const out = runTool(['--json']);
  assert.equal(out, readFileSync(committedUsage, 'utf8'));
});

test('--estimate against the zero-price official estimate: no NaN, per-episode normalized, no token basis', () => {
  const out = runTool(['--estimate', officialEstimate, '--json']);
  assert.ok(!out.includes('NaN'), 'estimator join must not emit NaN values');
  const parsed = JSON.parse(out);
  assert.ok(Array.isArray(parsed.estimatorJoin));
  assert.ok(parsed.estimatorJoin.length > 0);
  for (const e of parsed.estimatorJoin) {
    if (e.measuredCallsPerEpisode !== null) {
      assert.ok(Number.isFinite(e.measuredCallsPerEpisode), `measuredCallsPerEpisode finite for ${e.gameId}`);
    }
    if (e.callErrorVsLowPct !== null) {
      assert.ok(Number.isFinite(e.callErrorVsLowPct), `callErrorVsLowPct finite for ${e.gameId}`);
    }
    // The zero-price estimate has usdLow === 0 for every game: no token
    // information, so the token-basis column must be null, not a bogus 0.
    assert.equal(e.estInputTokPerCall, null, `zero-priced estimate has no token basis (${e.gameId})`);
  }
  const chess = parsed.estimatorJoin.find((/** @type {any} */ e) => e.gameId === 'chess');
  assert.ok(chess, 'chess present in join');
  // chess: 4 jobs, callsLow 233 -> 58.25 calls/episode on the low basis.
  assert.ok(Math.abs(chess.estLowCallsPerEp - 58.25) < 1e-9, `chess low basis per episode (${chess.estLowCallsPerEp})`);
});

test('--estimate against the $1/$1 check estimate: token basis derives from usdLow/callsLow where priced', () => {
  const checkGames = JSON.parse(readFileSync(checkEstimate, 'utf8')).games;
  const out = runTool(['--estimate', checkEstimate, '--json']);
  assert.ok(!out.includes('NaN'), 'estimator join must not emit NaN values');
  const parsed = JSON.parse(out);
  for (const e of parsed.estimatorJoin) {
    const g = checkGames.find((/** @type {any} */ x) => x.gameId === e.gameId);
    assert.ok(g, `check estimate defines ${e.gameId}`);
    if (g.callsLow > 0 && g.usdLow > 0) {
      assert.ok(Number.isFinite(e.estInputTokPerCall) && e.estInputTokPerCall > 0,
        `priced token basis positive and finite for ${e.gameId}`);
      const expect = (g.usdLow / g.callsLow) * 1e6;
      assert.ok(Math.abs(e.estInputTokPerCall - expect) < 1e-6, `token basis = usdLow/callsLow*1e6 for ${e.gameId}`);
    } else {
      assert.equal(e.estInputTokPerCall, null, `no low basis -> no token basis for ${e.gameId}`);
    }
    if (e.measuredCallsPerEpisode !== null) {
      assert.ok(Number.isFinite(e.measuredCallsPerEpisode), `measuredCallsPerEpisode finite for ${e.gameId}`);
    }
  }
  // chess check-price basis: 0.12278275 usd / 233 calls * 1e6 ~= 527 tok/call.
  const chess = parsed.estimatorJoin.find((/** @type {any} */ e) => e.gameId === 'chess');
  assert.ok(chess.estInputTokPerCall > 500 && chess.estInputTokPerCall < 550,
    `chess token basis in the documented ~527 range (${chess.estInputTokPerCall})`);
  const minesweeper = parsed.estimatorJoin.find((/** @type {any} */ e) => e.gameId === 'minesweeper');
  assert.equal(minesweeper.estInputTokPerCall, null, 'minesweeper has no low basis -> no token basis');
});
