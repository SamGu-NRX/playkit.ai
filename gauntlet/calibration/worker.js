/**
 * The calibration worker: one child process per game. Runs the random, greedy
 * and engine baselines over the tier's public seeds through the core runner,
 * scores the trajectories with `scoring/`, and writes the game's table plus a
 * run-meta sidecar (wall time, episode count, cap flag) for the parent.
 *
 * Spawned by `run.js`; argv[2] is a JSON config:
 * `{ gameId, seedsLimit, tablePath, trajDir, timeCapSec }`.
 * No dependencies beyond the package and Node builtins.
 *
 * @module
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { runEpisode } from '../core/runner.js';
import { buildSuite } from '../scoring/suite.js';
import { score } from '../scoring/score.js';
import { CALIBRATION_GAMES, agentSeatFor, makeBaselineAgent } from './games.js';
import { BASELINE_KINDS, TABLE_FORMAT } from './checks.js';

/** @import { Trajectory } from '../core/types.js' */
/** @import { BaselineKind } from './games.js' */

const config = /** @type {{ gameId: string, seedsLimit: number | null, tablePath: string, trajDir: string, timeCapSec: number }} */ (
  JSON.parse(process.argv[2] ?? '{}')
);

const entry = CALIBRATION_GAMES.find((g) => g.id === config.gameId);
if (!entry) {
  console.error(`worker: unknown game ${JSON.stringify(config.gameId)}`);
  process.exit(1);
}

const game = entry.game;
const startedAtMs = Date.now();

// The suite the game is scored against. `score()` refuses a suite with no
// `benchmark: true` game, so a smoke game like tictactoe rides along with a
// benchmark game it is never scored for.
const suiteGames = game.spec.benchmark ? [game] : [game, CALIBRATION_GAMES.find((g) => g.id === 'chess')?.game ?? game];
const suite = buildSuite(/** @type {*[]} */ (suiteGames), { split: 'public' });
const suiteGame = suite.games.find((g) => g.id === game.spec.id);
if (!suiteGame) throw new Error(`suite is missing game ${game.spec.id}`);

/**
 * @type {Map<string, Trajectory[]>} kind -> trajectories, in run order
 */
const trajectories = new Map(BASELINE_KINDS.map((k) => [k, []]));

let episodesRun = 0;
let capHit = false;

outer: for (const kind of /** @type {BaselineKind[]} */ ([...BASELINE_KINDS])) {
  const list = /** @type {Trajectory[]} */ (trajectories.get(kind));
  for (const suiteTier of suiteGame.tiers) {
    const tier = game.spec.tiers.find((t) => t.id === suiteTier.id);
    if (!tier) throw new Error(`spec is missing tier ${suiteTier.id}`);
    const limit = config.seedsLimit === null ? suiteTier.seeds.length : Math.min(config.seedsLimit, suiteTier.seeds.length);
    for (let i = 0; i < limit; i++) {
      const elapsedSec = (Date.now() - startedAtMs) / 1000;
      if (elapsedSec > config.timeCapSec) {
        capHit = true;
        break outer;
      }
      const seed = suiteTier.seeds[i];
      const seat = agentSeatFor(game, tier, seed);
      const agent = makeBaselineAgent(
        entry,
        kind,
        /** @type {*} */ ({ episodeSeed: seed, tier, seat })
      );
      const trajectory = await runEpisode({
        game,
        tierId: tier.id,
        seed,
        split: 'public',
        agent,
      });
      const trajPath = join(config.trajDir, game.spec.id, kind, `${tier.id}-${i}.json`);
      mkdirSync(dirname(trajPath), { recursive: true });
      writeFileSync(trajPath, JSON.stringify(trajectory, null, 2));
      list.push(trajectory);
      episodesRun++;
    }
  }
}

// Score each baseline's trajectories with the package's own scoring rules.
/** @type {Record<string, { tiers: Record<string, *> }>} */
const baselines = {};
for (const kind of /** @type {BaselineKind[]} */ ([...BASELINE_KINDS])) {
  const list = /** @type {Trajectory[]} */ (trajectories.get(kind));
  const entryScore = await score(suite, list, /** @type {*[]} */ (suiteGames), {
    agent: { id: kind, track: 'baseline' },
  });
  const gameScore = entryScore.games[game.spec.id];
  /** @type {Record<string, *>} */
  const tiers = {};
  for (const suiteTier of suiteGame.tiers) {
    const block = gameScore.tiers[suiteTier.id];
    tiers[suiteTier.id] = {
      id: suiteTier.id,
      rank: suiteTier.rank,
      scoring: suiteTier.scoring,
      score: { value: block.score.value, ci95: block.score.ci95 },
      solvedFraction: block.solvedFraction,
      episodes: block.episodes,
    };
  }
  baselines[kind] = { tiers };
}

const table = {
  format: TABLE_FORMAT,
  game: {
    id: game.spec.id,
    version: game.spec.version,
    benchmark: game.spec.benchmark === true,
  },
  split: /** @type {'public'} */ ('public'),
  seedsPerTier: config.seedsLimit === null ? Math.max(...suiteGame.tiers.map((t) => t.seeds.length)) : config.seedsLimit,
  baselines,
};

mkdirSync(dirname(config.tablePath), { recursive: true });
writeFileSync(config.tablePath, `${JSON.stringify(table, null, 2)}\n`);
writeFileSync(
  `${config.tablePath}.meta.json`,
  `${JSON.stringify(
    {
      gameId: game.spec.id,
      wallTimeSec: Math.round((Date.now() - startedAtMs) / 100) / 10,
      episodesRun,
      capHit,
    },
    null,
    2
  )}\n`
);
