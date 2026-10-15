/**
 * `gauntlet estimate`: estimate the calls and cost of playing a suite before
 * spending anything, through `gauntlet/runs/estimate.js`. The estimate comes
 * from each game packet's own engine baselines and scoring par (probe
 * episodes run locally, no API calls); USD figures appear only when a price
 * file prices the agent's `provider/model` key, and unknowns stay `null`.
 *
 * Node-only.
 *
 * @module
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { listGames } from '../games/index.js';
import { estimateSuite, estimateToMarkdown, writeEstimate } from '../runs/estimate.js';
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
 * @property {boolean} [json] --json: print the JSON estimate (default prints
 *   the Markdown).
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
    process.stdout.write(
      `note: "${pricesPath}" has no entry for "${pricingKey}"; USD figures stay unknown\n`
    );
  }
  const estimate = await estimateSuite({
    suite,
    games: listGames(),
    ...(prices ? { prices } : {}),
    ...(pricingKey ? { pricingKey } : {}),
  });

  if (options.outDir) {
    await writeEstimate(options.outDir, estimate);
    process.stdout.write(
      `wrote ${join(options.outDir, 'estimate.json')} and ${join(options.outDir, 'estimate.md')}\n`
    );
  } else if (options.json) {
    process.stdout.write(JSON.stringify(estimate, null, 2) + '\n');
  } else {
    process.stdout.write(estimateToMarkdown(estimate) + '\n');
  }
  return estimate;
}
