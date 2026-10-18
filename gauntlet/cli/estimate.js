/**
 * `gauntlet estimate`: estimate the calls and cost of playing a suite before
 * spending anything, through `gauntlet/runs/estimate.js`. The estimate comes
 * from each game packet's own engine baselines and scoring par (probe
 * episodes run locally, no API calls) — or, with `--no-probes`, from the
 * fitted parameters and the tiers' pars alone, with no baseline episodes at
 * all. USD figures appear only when a price file prices the agent's
 * `provider/model` key, and unknowns stay `null`.
 *
 * With `--against <runDir>` the estimate is instead compared with a finished
 * run bundle: per game and in total, how the run's actual calls, tokens and
 * dollars landed against the estimate's low and high figures.
 *
 * Node-only.
 *
 * @module
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { listGames } from '../games/index.js';
import {
  compareRunAgainstEstimate,
  comparisonToMarkdown,
  estimateSuite,
  estimateToMarkdown,
  writeEstimate,
} from '../runs/estimate.js';
import { readSuiteFile } from './suite.js';

/** @import { Estimate } from '../runs/estimate.js' */

/**
 * The pricing key an agent spec would be priced under (`<provider>/<model>`),
 * or null for bundled agents (random, baselines) that make no provider calls.
 *
 * @param {string} agentSpecText
 * @returns {string | null}
 */
export function pricingKeyForSpec(agentSpecText) {
  const match = /^model:([a-z0-9-]+)\/(.+)$/.exec(agentSpecText);
  if (!match) return null;
  return `${match[1]}/${match[2]}`;
}

/**
 * @typedef {object} EstimateOptions
 * @property {string} suitePath
 * @property {string} agentSpecText
 * @property {string} [prices] --prices file (PriceFile JSON).
 * @property {string} [outDir] --out: write estimate.json and estimate.md here.
 * @property {boolean} [noProbes] --no-probes: skip the baseline probe
 *   episodes; the low side comes from the fit where fitted, else the tier's
 *   par, and a tier with neither is unestimated.
 * @property {string} [against] --against <runDir>: compare the estimate with
 *   the finished run bundle in that directory instead of printing it.
 * @property {boolean} [json] --json: print the JSON estimate (default prints
 *   the Markdown); with --against, print the JSON comparison.
 */

/**
 * Build, print, and optionally write the estimate.
 *
 * @param {EstimateOptions} options
 * @returns {Promise<Estimate>}
 */
export async function buildEstimate(options) {
  const suite = readSuiteFile(options.suitePath);
  const pricingKey = pricingKeyForSpec(options.agentSpecText);
  const pricesPath = options.prices;
  const prices = pricesPath
    ? /** @type {Record<string, *>} */ (JSON.parse(readFileSync(pricesPath, 'utf8')))
    : undefined;
  if (prices && pricingKey && !(pricingKey in prices)) {
    // Diagnostics go to stderr: with --json the estimate JSON is the only
    // thing on stdout, so it parses even when a price entry is missing.
    process.stderr.write(
      `note: "${pricesPath}" has no entry for "${pricingKey}"; USD figures stay unknown\n`
    );
  }
  const estimate = await estimateSuite({
    suite,
    games: listGames(),
    ...(prices ? { prices } : {}),
    ...(pricingKey ? { pricingKey } : {}),
    ...(options.noProbes ? { noProbes: true } : {}),
  });

  if (options.against) {
    const comparison = await compareRunAgainstEstimate(estimate, options.against);
    if (options.json) {
      process.stdout.write(JSON.stringify(comparison, null, 2) + '\n');
    } else {
      process.stdout.write(comparisonToMarkdown(comparison) + '\n');
    }
    return estimate;
  }

  if (options.outDir) {
    await writeEstimate(options.outDir, estimate);
    // Progress line on stderr — same rule as the note above: stdout carries
    // the printable result (or the --json payload), nothing else.
    process.stderr.write(
      `wrote ${join(options.outDir, 'estimate.json')} and ${join(options.outDir, 'estimate.md')}\n`
    );
  } else if (options.json) {
    process.stdout.write(JSON.stringify(estimate, null, 2) + '\n');
  } else {
    process.stdout.write(estimateToMarkdown(estimate) + '\n');
  }
  return estimate;
}
