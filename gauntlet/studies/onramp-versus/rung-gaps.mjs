/**
 * Rung-gap measurement for the on-ramp tier ladders (tictactoe, connect4).
 *
 * Reads the committed calibration tables — the deterministic baseline dial
 * (random, greedy, engine on every tier's public seeds) — and reports, for
 * each baseline, the score on every rung plus each adjacent-rung gap with a
 * separation verdict derived from the two means' standard errors. The SE of a
 * baseline's mean is taken from its 95% CI half-width (SE = (hi - lo) / 3.92);
 * the SE of a gap between independent rungs is sqrt(SE1^2 + SE2^2). Gaps are
 * labeled 'separated' only when they exceed 1.96 pooled SEs.
 *
 * This is the deterministic stand-in for a model dial: the skill-dial agents
 * live on the unmerged skill-dial-versus study branch and need model serving
 * infrastructure. What it measures — does the ladder resolve an agent's
 * strength rung by rung — is exactly what a calibration ladder is for.
 *
 * Output: rung-gaps.json next to this script.
 *
 * @module
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getGame } from '../../games/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const gauntletRoot = join(here, '..', '..');
const GAMES = ['tictactoe', 'connect4'];
const KINDS = ['random', 'greedy', 'engine'];

const output = {
  format: 'playkit-gauntlet-onramp-rung-gaps/1',
  source: 'calibration/tables/{tictactoe,connect4}.json — the deterministic baseline dial',
  games: {},
};

for (const gameId of GAMES) {
  const table = JSON.parse(readFileSync(join(gauntletRoot, 'calibration/tables', `${gameId}.json`), 'utf8'));
  // The table carries no tier metadata; the ladder order comes from the game spec itself.
  const tiers = getGame(gameId).spec.tiers.map((t) => ({ id: t.id, rank: t.rank }));
  tiers.sort((a, b) => a.rank - b.rank);

  const byKind = {};
  for (const kind of KINDS) {
    const blocks = /** @type {*} */ (table.baselines[kind]?.tiers ?? {});
    const rungs = tiers.map(({ id, rank }) => {
      const block = blocks[id];
      if (!block) return { tierId: id, rank, score: null, ci95: null, episodes: 0, se: null };
      const [lo, hi] = block.score.ci95;
      return {
        tierId: id,
        rank,
        score: block.score.value,
        ci95: block.score.ci95,
        episodes: block.episodes,
        se: (hi - lo) / 3.92,
      };
    });

    const gaps = [];
    for (let i = 1; i < rungs.length; i++) {
      const a = rungs[i - 1];
      const b = rungs[i];
      if (a.score === null || b.score === null || a.se === null || b.se === null) continue;
      const delta = a.score - b.score; // positive = easier rung scores higher, as a ladder should
      const seGap = Math.sqrt(a.se * a.se + b.se * b.se);
      gaps.push({
        from: a.tierId,
        to: b.tierId,
        delta: Math.round(delta * 1e6) / 1e6,
        se: Math.round(seGap * 1e6) / 1e6,
        separated: Math.abs(delta) > 1.96 * seGap,
        monotonic: delta >= 0,
      });
    }

    byKind[kind] = { rungs, gaps };
  }

  output.games[gameId] = { version: table.game.version, baselines: byKind };
}

const out = join(here, 'rung-gaps.json');
writeFileSync(out, `${JSON.stringify(output, null, 2)}\n`);
console.log(`wrote ${out}`);
