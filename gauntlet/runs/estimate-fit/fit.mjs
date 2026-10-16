/**
 * Fit the cost estimator to real-model runs and report its error.
 *
 * Reads `runs-data.json` (produced by `extract-runs.mjs`) and writes:
 *
 * - `params.js` — the fitted per-(game, tier) parameters the estimator loads
 *   at estimate time (expected calls and tokens from the runs' recorded
 *   provider usage; the worst case stays the tier's call budget and the
 *   fitted per-call maxima).
 * - `fit-report.json` / `fit-report.md` — the error tables. For every model
 *   with runs in the data, the fit is re-run WITHOUT that model's episodes
 *   (leave-one-model-out) and its predictions are compared to the held-out
 *   run's measured calls and tokens, before (the old estimator's engine-probe
 *   basis and chars-per-token rendering) and after (the fit). A tier covered
 *   by only one model cannot be held out by model; for those the report
 *   compares the two independent same-model run bundles where they exist.
 *
 * The fit is deterministic: the same runs-data.json always produces
 * byte-identical params.js and fit-report files.
 *
 * Usage:
 *
 *   node runs/estimate-fit/fit.mjs            # read runs-data.json, write outputs
 *   node runs/estimate-fit/fit.mjs --check    # verify outputs match a fresh fit
 *
 * @module
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { probeTier } from '../estimate.js';
import { listGames } from '../../games/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const GAUNTLET_ROOT = resolve(HERE, '../..');

export const FIT_FORMAT = 'playkit-gauntlet-estimate-fit/1';

/**
 * Mean of a numeric array; null when empty.
 *
 * @param {number[]} xs
 * @returns {number | null}
 */
function mean(xs) {
  if (xs.length === 0) return null;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** @param {number} v @param {number} digits */
function round(v, digits) {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

/**
 * Group episodes by (game, tier).
 *
 * @param {any[]} episodes
 * @returns {Map<string, any[]>}
 */
function byTier(episodes) {
  /** @type {Map<string, any[]>} */
  const map = new Map();
  for (const e of episodes) {
    const key = `${e.game}/${e.tier}`;
    const list = map.get(key);
    if (list) list.push(e);
    else map.set(key, [e]);
  }
  return map;
}

/**
 * Fit per-(game, tier) parameters from a set of episodes.
 *
 * Calls: expected = the mean agent actions per episode; the worst case is the
 * tier's maxActions budget, applied at estimate time (the data's budget-bound
 * flag records when the fitted mean is the cap because every fitted episode
 * exhausted the budget).
 *
 * Tokens per call: expected = the mean of the recorded provider input/output
 * tokens over all fitted calls; worst = the observed per-call maxima. Input
 * tokens track the prompt a tier renders (they are a property of the game and
 * tier, far more than of the model), output tokens track reply length.
 *
 * @param {any[]} episodes
 * @returns {{ tiers: Record<string, any>, sources: string[] }}
 */
export function fitFromEpisodes(episodes) {
  /** @type {Record<string, any>} */
  const tiers = {};
  const grouped = byTier(episodes);
  for (const key of [...grouped.keys()].sort()) {
    const eps = /** @type {any[]} */ (grouped.get(key));
    const calls = eps.map((/** @type {any} */ e) => e.agentActions);
    const inTok = eps
      .flatMap((/** @type {any} */ e) => e.steps.map((/** @type {any} */ s) => s[0]))
      .filter((/** @type {any} */ v) => v !== null);
    const outTok = eps
      .flatMap((/** @type {any} */ e) => e.steps.map((/** @type {any} */ s) => s[1]))
      .filter((/** @type {any} */ v) => v !== null);
    const invalid = eps.flatMap((/** @type {any} */ e) => e.steps.map((/** @type {any} */ s) => s[2]));
    const models = [...new Set(eps.map((/** @type {any} */ e) => e.model))].sort();
    const sources = [...new Set(eps.map((/** @type {any} */ e) => e.source))].sort();
    const mIn = mean(inTok);
    const mOut = mean(outTok);
    tiers[key] = {
      callsExpected: round(/** @type {number} */ (mean(calls)), 2),
      inExpected: mIn === null ? null : round(mIn, 1),
      inWorst: inTok.length ? Math.max(...inTok) : null,
      outExpected: mOut === null ? null : round(mOut, 2),
      outWorst: outTok.length ? Math.max(...outTok) : null,
      invalidRate: round(mean(invalid) ?? 0, 4),
      budgetBound: eps.every((e) => e.agentActions >= e.maxActions),
      episodes: eps.length,
      models,
      sources,
      endReasons: eps.reduce((acc, e) => {
        acc[e.endReason] = (acc[e.endReason] ?? 0) + 1;
        return acc;
      }, /** @type {Record<string, number>} */ ({})),
    };
  }
  const sources = [...new Set(episodes.map((e) => e.source))].sort();
  return { tiers, sources };
}

/**
 * The old estimator's per-(game, tier) basis, recomputed on the current
 * tiers: engine-probe mean calls (or par; null when neither exists) and
 * per-call tokens rendered along the baseline episode at 4 chars/token.
 *
 * @param {string[]} gameIds
 * @returns {Promise<Map<string, { callsLow: number | null, tokens: { input: { mean: number, max: number }, output: { mean: number, max: number } } | null, basis: string }>>}
 */
export async function oldBasis(gameIds) {
  const gamesById = new Map(listGames().map((g) => [g.spec.id, g]));
  /** @type {Map<string, any>} */
  const out = new Map();
  for (const gameId of gameIds.sort()) {
    const game = gamesById.get(gameId);
    if (!game) continue;
    for (const tier of game.spec.tiers) {
      // The public seeds each tier was calibrated with: the first two public
      // seeds of the committed board-v2 suite are what the old estimator
      // probed, but the probe is seed-robust (it averages two episodes), so
      // derive seeds from the game itself via the committed board-v2 suite.
      const seeds = suiteSeeds(gameId, tier.id);
      const probe = await probeTier(game, tier, seeds ?? ['0', '1'], 'public');
      out.set(`${gameId}/${tier.id}`, {
        callsLow: probe.callsPerEpisode,
        tokens: probe.tokens,
        basis: probe.basis,
      });
    }
  }
  return out;
}

/**
 * Public seeds per (game, tier) from the committed board-v2 suite, which
 * covers all 13 games; null when the suite lacks the tier.
 *
 * @type {Map<string, string[]> | null}
 */
let suiteSeedCache = null;

/**
 * @param {string} gameId
 * @param {string} tierId
 * @returns {string[] | null}
 */
function suiteSeeds(gameId, tierId) {
  if (!suiteSeedCache) {
    suiteSeedCache = new Map();
    try {
      const suite = JSON.parse(readFileSync(join(GAUNTLET_ROOT, 'reports/board-v2/suite.public.boardv2.json'), 'utf8'));
      for (const g of suite.games ?? []) {
        for (const t of g.tiers ?? []) {
          suiteSeedCache.set(`${g.id}/${t.id}`, t.seeds ?? null);
        }
      }
    } catch {
      // No committed suite: probes fall back to placeholder seeds, which
      // still plays a real baseline episode for most games.
    }
  }
  return suiteSeedCache.get(`${gameId}/${tierId}`) ?? null;
}

/**
 * Leave-one-model-out error table: for each model, fit on the other models'
 * episodes and compare predictions to the held-out runs, before (old
 * estimator basis) and after (fit).
 *
 * @param {any} data runs-data.json content.
 * @param {Map<string, any>} oldB The old estimator basis per game/tier.
 * @returns {{ perModel: *, summary: * }}
 */
export function holdoutTable(data, oldB) {
  const models = [...new Set(data.episodes.map((/** @type {any} */ e) => e.model))].sort();
  /** @type {any} */
  const perModel = {};
  /** @type {{ game: string, model: string, metric: string, before: number | null, after: number | null }[]} */
  const summary = [];
  for (const model of models) {
    const heldOut = data.episodes.filter((/** @type {any} */ e) => e.model === model);
    const fitSet = data.episodes.filter((/** @type {any} */ e) => e.model !== model);
    const fit = fitFromEpisodes(fitSet).tiers;
    const heldTiers = byTier(heldOut);
    /** @type {any[]} */
    const tiers = [];
    for (const key of [...heldTiers.keys()].sort()) {
      const eps = /** @type {any[]} */ (heldTiers.get(key));
      const f = fit[key];
      const ob = oldB.get(key) ?? null;
      const measuredCalls = /** @type {number} */ (mean(eps.map((/** @type {any} */ e) => e.agentActions)));
      const measuredIn = /** @type {number | null} */ (
        mean(
          eps
            .flatMap((/** @type {any} */ e) => e.steps.map((/** @type {any} */ s) => s[0]))
            .filter((/** @type {any} */ v) => v !== null)
        )
      );
      /** @type {number | null} */
      const afterCalls = f ? f.callsExpected / measuredCalls : null;
      /** @type {number | null} */
      const beforeCalls = ob && ob.callsLow !== null ? ob.callsLow / measuredCalls : null;
      /** @type {number | null} */
      const afterTokens = f && f.inExpected !== null && measuredIn !== null ? f.inExpected / measuredIn : null;
      /** @type {number | null} */
      const beforeTokens =
        ob && ob.tokens && ob.tokens.input && measuredIn !== null ? ob.tokens.input.mean / measuredIn : null;
      tiers.push({
        tier: key,
        episodes: eps.length,
        measuredCalls: round(measuredCalls, 2),
        fittedCalls: f ? f.callsExpected : null,
        beforeCalls: beforeCalls === null ? null : round(beforeCalls, 3),
        afterCalls: afterCalls === null ? null : round(afterCalls, 3),
        measuredIn: measuredIn === null ? null : round(measuredIn, 1),
        fittedIn: f && f.inExpected !== null ? f.inExpected : null,
        beforeTokens: beforeTokens === null ? null : round(beforeTokens, 3),
        afterTokens: afterTokens === null ? null : round(afterTokens, 3),
      });
    }
    // Per-game aggregates, episode-weighted geometric means of the ratios.
    const games = [...new Set(tiers.map((t) => t.tier.split('/')[0]))].sort();
    /** @type {any[]} */
    const gameRows = [];
    for (const game of games) {
      const rows = tiers.filter((t) => t.tier.startsWith(`${game}/`));
      const wsum = rows.reduce((a, r) => a + r.episodes, 0);
      /** @type {(get: (r: any) => number | null, log: boolean) => number | null} */
      const agg = (get, log) => {
        const vals = rows
          .map((r) => get(r))
          .flatMap((/** @type {number | null} */ v) => (v !== null && Number.isFinite(v) && v > 0 ? [v] : []));
        if (vals.length === 0) return null;
        const m = log
          ? Math.exp(vals.reduce((a, v) => a + Math.log(v), 0) / vals.length)
          : vals.reduce((a, v) => a + v, 0) / vals.length;
        return round(m, 3);
      };
      const row = {
        game,
        episodes: wsum,
        beforeCalls: agg((r) => r.beforeCalls, true),
        afterCalls: agg((r) => r.afterCalls, true),
        beforeTokens: agg((r) => r.beforeTokens, true),
        afterTokens: agg((r) => r.afterTokens, true),
      };
      gameRows.push(row);
      summary.push({ game, model, metric: 'calls', before: row.beforeCalls, after: row.afterCalls });
      summary.push({ game, model, metric: 'tokens', before: row.beforeTokens, after: row.afterTokens });
    }
    perModel[model] = { tiers, games: gameRows };
  }
  return { perModel, summary };
}

/**
 * Per-game within-2x verdicts derived from the hold-out table: the worst
 * fold-change (max of r and 1/r) of the leave-one-model-out ratios per
 * metric, across the models with data for the game. This is the honest check
 * of the acceptance criterion — a game whose fitted call counts stay within
 * 2x of a held-out model's measured calls versus one where model behavior
 * (forfeit at ~3 calls vs flailing to the budget) makes any pooled prediction
 * wrong by more than 2x for some model.
 *
 * @param {{ summary: { game: string, model: string, metric: string, before: number | null, after: number | null }[] }} holdout
 * @returns {{ game: string, models: number, tokensWorst: number | null, callsWorst: number | null, callsTransfer: 'yes' | 'no' | 'n/a', tokensTransfer: 'yes' | 'no' | 'n/a' }[]}
 */
export function verdictTable(holdout) {
  const games = [...new Set(holdout.summary.map((/** @type {any} */ s) => s.game))].sort();
  /** @type {(game: string, metric: string, key: 'before' | 'after') => { worst: number | null, models: number }} */
  const worstOf = (game, metric, key) => {
    const ratios = holdout.summary
      .filter((/** @type {any} */ s) => s.game === game && s.metric === metric && s[key] !== null && s[key] !== undefined)
      .map((/** @type {any} */ s) => /** @type {number} */ (s[key]));
    if (ratios.length === 0) return { worst: null, models: 0 };
    const folds = ratios.map((/** @type {number} */ r) => Math.max(r, 1 / r));
    return { worst: round(Math.max(...folds), 2), models: ratios.length };
  };
  return games.map((game) => {
    const calls = worstOf(game, 'calls', 'after');
    const tokens = worstOf(game, 'tokens', 'after');
    /** @type {(w: number | null) => 'yes' | 'no' | 'n/a'} */
    const verdict = (w) => (w === null ? 'n/a' : w <= 2 ? 'yes' : 'no');
    return {
      game,
      models: Math.max(calls.models, tokens.models),
      callsWorst: calls.worst,
      tokensWorst: tokens.worst,
      callsTransfer: verdict(calls.worst),
      tokensTransfer: verdict(tokens.worst),
    };
  });
}

/**
 * Add each tier's current maxActions from the live game specs as `callsCap` —
 * the fitted estimate's worst-case call bound, kept in step with the registry.
 *
 * @param {Record<string, any>} params
 * @param {Map<string, { spec: any }>} gamesById
 * @returns {Record<string, any>}
 */
export function withSpecCaps(params, gamesById) {
  for (const key of Object.keys(params.tiers)) {
    const [gameId, tierId] = key.split('/');
    const tier = gamesById.get(gameId)?.spec.tiers.find((/** @type {any} */ t) => t.id === tierId);
    params.tiers[key].callsCap = tier ? tier.maxActions : null;
  }
  return params;
}

/**
 * Tokens as a function of prompt size: per game, a least-squares fit of the
 * recorded input tokens on the reconstructed official-prompt characters over
 * hash-verified calls. This is the diagnostic for why the old chars/4
 * rendering along engine baselines mispriced tokens.
 *
 * @param {any[]} episodes
 * @returns {Record<string, any>}
 */
export function tokenSizeFit(episodes) {
  /** @type {Record<string, any>} */
  const out = {};
  const games = [...new Set(episodes.map((e) => e.game))].sort();
  for (const game of games) {
    const eps = episodes.filter((e) => e.game === game);
    const pts = eps
      .flatMap((e) => e.steps)
      .filter((s) => s[0] !== null && s[3] !== null)
      .map((s) => ({ x: /** @type {number} */ (s[3]), y: /** @type {number} */ (s[0]) }));
    if (pts.length < 10) {
      out[game] = { calls: pts.length, note: 'too few hash-verified calls for a fit' };
      continue;
    }
    const n = pts.length;
    const mx = pts.reduce((a, p) => a + p.x, 0) / n;
    const my = pts.reduce((a, p) => a + p.y, 0) / n;
    let sxx = 0;
    let sxy = 0;
    for (const p of pts) {
      sxx += (p.x - mx) ** 2;
      sxy += (p.x - mx) * (p.y - my);
    }
    const b = sxx > 0 ? sxy / sxx : 0;
    const a = my - b * mx;
    const r2 = sxx > 0 ? (sxy * sxy) / (sxx * pts.reduce((a, p) => a + (p.y - my) ** 2, 0) || 1) : 0;
    const charsPerToken = b > 0 ? round(1 / b, 2) : null;
    out[game] = {
      calls: n,
      slopeTokensPerChar: round(b, 5),
      interceptTokens: round(a, 1),
      r2: round(r2, 3),
      impliedCharsPerToken: charsPerToken,
    };
  }
  return out;
}

/**
 * Build the full params object the estimator consumes.
 *
 * @param {any} data
 * @returns {{ format: string, note: string, tiers: Record<string, any>, sources: string[] }}
 */
export function buildParams(data) {
  const fit = fitFromEpisodes(data.episodes);
  return {
    format: FIT_FORMAT,
    note:
      'Fitted per (game, tier) to committed real-model runs (playkit-gauntlet-estimate-fit/1). ' +
      'callsExpected = mean agent actions per episode; the worst case is the tier maxActions budget. ' +
      'in/out tokens per call = mean and observed maximum of the runs\' recorded provider usage. ' +
      'See runs/estimate-fit/fit-report.md for the hold-out error tables.',
    tiers: fit.tiers,
    sources: fit.sources,
  };
}

/** Render params.js content. @param {any} params */
export function renderParamsJs(params) {
  const header =
    `// GENERATED by runs/estimate-fit/fit.mjs from runs-data.json — do not edit by hand.\n` +
    `// Reproduce: node runs/estimate-fit/extract-runs.mjs && node runs/estimate-fit/fit.mjs\n` +
    `// See fit-report.md for the hold-out error tables behind these numbers.\n\n`;
  return header + `/** @type {import('../estimate.js').EstimateFit} */\nexport const ESTIMATE_FIT = ${JSON.stringify(params, null, 2)};\n`;
}

/**
 * Render the markdown report.
 *
 * @param {any} data
 * @param {any} params
 * @param {Map<string, any>} oldB
 * @param {ReturnType<typeof holdoutTable>} holdout
 * @param {Record<string, any>} tokFit
 * @param {ReturnType<typeof verdictTable>} verdicts
 * @returns {string}
 */
export function renderReport(data, params, oldB, holdout, tokFit, verdicts) {
  const lines = [];
  lines.push('# Estimator fit — method and hold-out error');
  lines.push('');
  lines.push(
    `Data: ${data.episodes.length} committed real-model episodes, ` +
      `${data.episodes.reduce((/** @type {number} */ a, /** @type {any} */ e) => a + e.agentSteps, 0)} agent calls, ` +
      `sources: ${data.sources.join(', ')}. Every call's token counts are the provider's recorded usage; ` +
      `prompt sizes are reconstructed by replaying each trajectory against the current game specs ` +
      `(hash-verified prefix; ${Math.round((100 * data.episodes.reduce((/** @type {number} */ a, /** @type {any} */ e) => a + e.hashValidSteps, 0)) / data.episodes.reduce((/** @type {number} */ a, /** @type {any} */ e) => a + e.agentSteps, 0))}% of calls verified).`
  );
  lines.push('');
  lines.push('## What the fit changes');
  lines.push('');
  lines.push(
    'The old estimator guessed a weak model\'s episode length from the game\'s own engine baseline ' +
      '(which plays well and finishes fast or slow for reasons unrelated to a model that forfeits ' +
      'or flails) and priced tokens at 4 characters per token along that baseline episode. The fit ' +
      'replaces both assumptions with the runs\' measured per-call usage and per-episode call counts, ' +
      'and keeps the tier budget as the worst case.'
  );
  lines.push('');
  lines.push('## Hold-out error (leave-one-model-out), per game');
  lines.push('');
  lines.push(
    'For each model, the fit is rebuilt without that model\'s episodes and applied to them. ' +
      'Ratios are predicted/measured, episode-weighted geometric means over the game\'s tiers; ' +
      '1.0 is perfect. `—` = no basis (the old estimator had no low basis for the game, or the ' +
      'tier has no fitted episodes outside the held-out model).'
  );
  for (const [model, entry] of Object.entries(holdout.perModel)) {
    lines.push('');
    lines.push(`### Held out: ${model}`);
    lines.push('');
    lines.push('| game | eps | calls before | calls after | in-tokens before | in-tokens after |');
    lines.push('|---|---:|---:|---:|---:|---:|');
    for (const row of entry.games) {
      const f = (/** @type {number | null | undefined} */ v) => (v === null || v === undefined ? '—' : `${v}×`);
      lines.push(
        `| ${row.game} | ${row.episodes} | ${f(row.beforeCalls)} | ${f(row.afterCalls)} | ${f(row.beforeTokens)} | ${f(row.afterTokens)} |`
      );
    }
  }
  lines.push('');
  lines.push('## Within-2x verdict');
  lines.push('');
  lines.push(
    'The acceptance criterion: an estimate right within 2x of a held-out real run. ' +
      'Per game, the worst fold-change (max of r and 1/r) of the leave-one-model-out ratios ' +
      'across the models with data. `n/a` = the game has no cross-model episodes, so only its ' +
      'same-model run-to-run spread exists to check (see the hold-out tables) — those games are ' +
      'not verified across models and their worst case is the tier budget.'
  );
  lines.push('');
  lines.push('| game | models | in-tokens worst | tokens within 2x | calls worst | calls within 2x |');
  lines.push('|---|---:|---:|---|---:|---|');
  for (const v of verdicts) {
    const f = (/** @type {number | null} */ x) => (x === null ? '—' : `${x}×`);
    lines.push(
      `| ${v.game} | ${v.models} | ${f(v.tokensWorst)} | ${v.tokensTransfer} | ${f(v.callsWorst)} | ${v.callsTransfer} |`
    );
  }
  lines.push('');
  lines.push('## Input tokens as a function of prompt size');
  lines.push('');
  lines.push(
    'Per game, least squares of the calls\' recorded input tokens on the reconstructed official ' +
      'prompt characters (hash-verified calls only). The old estimator assumed the tokenizer ' +
      'splits prompts at 4 characters per token; the fitted ratio is what these models actually saw.'
  );
  lines.push('');
  lines.push('| game | calls | tokens/char | intercept | r² | implied chars/token |');
  lines.push('|---|---:|---:|---:|---:|---:|');
  for (const game of Object.keys(tokFit).sort()) {
    const f = tokFit[game];
    if (f.calls === undefined || f.slopeTokensPerChar === undefined) {
      lines.push(`| ${game} | ${f.calls ?? 0} | — | — | — | ${f.note ?? ''} |`);
      continue;
    }
    lines.push(
      `| ${game} | ${f.calls} | ${f.slopeTokensPerChar} | ${f.interceptTokens} | ${f.r2} | ${f.impliedCharsPerToken ?? '—'} |`
    );
  }
  lines.push('');
  lines.push('## Fitted tiers');
  lines.push('');
  lines.push(
    '| game/tier | eps | models | calls expected | calls cap | in exp | in worst | out exp | out worst | invalid | budget-bound |'
  );
  lines.push('|---|---:|---|---:|---:|---:|---:|---:|---:|---:|---|');
  for (const key of Object.keys(params.tiers).sort()) {
    const t = params.tiers[key];
    lines.push(
      `| ${key} | ${t.episodes} | ${t.models.join('+')} | ${t.callsExpected} | ${t.callsCap} | ${t.inExpected ?? '—'} | ${t.inWorst ?? '—'} | ${t.outExpected ?? '—'} | ${t.outWorst ?? '—'} | ${(100 * t.invalidRate).toFixed(1)}% | ${t.budgetBound ? 'yes' : 'no'} |`
    );
  }
  lines.push('');
  lines.push('## What the fit cannot do');
  lines.push('');
  lines.push(
    '- The fit is a Qwen2.5-family prior (0.5B/1.5B/7B, local server, official track). A frontier ' +
      'model may forfeit less and flail differently; the worst case (budget × per-call maxima) is ' +
      'the number a dollar cap should be set from, and it does not depend on the fit.'
  );
  lines.push(
    '- Seven short-game tiers have cross-model coverage; the strategy games are 1.5B-only, so their ' +
      'hold-out column measures run-to-run spread (first-model-run vs board-v2), not model transfer.'
  );
  lines.push(
    '- Output-token maxima are the observed worst reply. On tiers where a 7B rambled to the harness ' +
      'reply cap, that cap is the fitted worst case.'
  );
  lines.push('');
  return lines.join('\n');
}

// CLI entry.
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  const check = process.argv.includes('--check');
  const data = JSON.parse(readFileSync(join(HERE, 'runs-data.json'), 'utf8'));

  const gamesById = new Map(listGames().map((g) => [g.spec.id, g]));
  const params = withSpecCaps(buildParams(data), gamesById);

  const oldB = await oldBasis([...gamesById.keys()]);
  const holdout = holdoutTable(data, oldB);
  const tokFit = tokenSizeFit(data.episodes);
  const verdicts = verdictTable(holdout);

  const paramsJs = renderParamsJs(params);
  const reportMd = renderReport(data, params, oldB, holdout, tokFit, verdicts);
  const reportJson = JSON.stringify(
    { params: { ...params }, holdout, verdicts, tokenSizeFit: tokFit },
    null,
    1
  ) + '\n';

  if (check) {
    const okParams = readFileSync(join(HERE, 'params.js'), 'utf8') === paramsJs;
    const okReport = readFileSync(join(HERE, 'fit-report.md'), 'utf8') === reportMd;
    const okJson = readFileSync(join(HERE, 'fit-report.json'), 'utf8') === reportJson;
    if (!okParams || !okReport || !okJson) {
      console.error(`check failed: params ${okParams ? 'ok' : 'DIFFERS'}, report.md ${okReport ? 'ok' : 'DIFFERS'}, report.json ${okJson ? 'ok' : 'DIFFERS'}`);
      process.exit(1);
    }
    console.log('check ok: params.js, fit-report.md and fit-report.json reproduce byte-identically');
  } else {
    writeFileSync(join(HERE, 'params.js'), paramsJs);
    writeFileSync(join(HERE, 'fit-report.md'), reportMd);
    writeFileSync(join(HERE, 'fit-report.json'), reportJson);
    console.log(`wrote params.js (${Object.keys(params.tiers).length} tiers), fit-report.md, fit-report.json`);
  }
}
