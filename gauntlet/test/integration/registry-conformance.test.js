/**
 * Integration: every registered game — the whole merged registry, one
 * conformance run each — passes the conformance kit. Each merged packet's own suite runs this for its game; this
 * file runs it across the merged registry so a registration that drifts from
 * the environment contract fails CI even if the packet's own tests were not
 * re-run. Default seedsPerTier (3) — the same depth the packets use.
 *
 * Games that require an external engine binary (spec.requires, e.g.
 * chess-stockfish needs Stockfish, go needs GNU Go) skip with a message
 * naming the binary and its install command when the binary is missing, the
 * same gate the real-engine tests use — on a machine without the engine the
 * kit cannot pass, and a red suite must mean a real regression.
 *
 * @module
 */

import { test } from 'node:test';
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { listGames } from '../../games/index.js';
import { runConformance } from '../../core/conformance.js';
import { findEngineBinary } from '../../engines/uci/client.js';
import { findGtpBinary } from '../../engines/gtp/client.js';

/**
 * How to locate and install each external program a game may require. The
 * finders are the same ones the real-engine tests gate on.
 * @type {Record<string, { find: () => string | null, install: string }>}
 */
const BINARY_GATES = {
  stockfish: { find: () => findEngineBinary('stockfish'), install: 'apt-get install -y stockfish' },
  gnugo: { find: () => findGtpBinary('gnugo'), install: 'apt-get install -y gnugo' },
};

/**
 * The skip reason when a game requires a binary this machine does not have,
 * or null when every requirement is satisfied.
 * @param {import('../../core/types.js').Game<*>} game
 * @returns {string | null}
 */
function missingRequirement(game) {
  for (const name of game.spec.requires ?? []) {
    const gate = BINARY_GATES[name];
    if (gate) {
      if (!gate.find()) {
        return `no ${name} binary found (install it: ${gate.install})`;
      }
      continue;
    }
    // Unknown external program: probe PATH the way the engine finders do.
    const onPath = (process.env.PATH ?? '')
      .split(delimiter)
      .some((dir) => dir && existsSync(join(dir, name)));
    if (!onPath) {
      return `no ${name} binary found on PATH (install it to run this conformance kit)`;
    }
  }
  return null;
}

for (const game of listGames()) {
  const skip = missingRequirement(game);
  test(
    `conformance: ${game.spec.id} (${game.spec.tiers.length} tiers)`,
    { timeout: 20 * 60 * 1000, skip: skip ?? false },
    async () => {
      await runConformance(game);
    }
  );
}
