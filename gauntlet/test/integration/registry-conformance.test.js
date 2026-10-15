/**
 * Integration: every registered game — all nine, in one registry — passes the
 * conformance kit. Each merged packet's own suite runs this for its game; this
 * file runs it across the merged registry so a registration that drifts from
 * the environment contract fails CI even if the packet's own tests were not
 * re-run. Default seedsPerTier (3) — the same depth the packets use.
 *
 * @module
 */

import { test } from 'node:test';
import { listGames } from '../../games/index.js';
import { runConformance } from '../../core/conformance.js';

for (const game of listGames()) {
  test(
    `conformance: ${game.spec.id} (${game.spec.tiers.length} tiers)`,
    { timeout: 20 * 60 * 1000 },
    async () => {
      await runConformance(game);
    }
  );
}
