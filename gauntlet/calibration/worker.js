/**
 * The calibration worker: one child process per game. Runs the random, greedy
 * and engine baselines over the tier's public seeds through the core runner,
 * scores the trajectories with `scoring/`, and writes the game's table plus a
 * run-meta sidecar (wall time, episode count, cap flag, failure note) for the
 * parent.
 *
 * Spawned by `run.js`; argv[2] is a JSON config:
 * `{ gameId, seedsLimit, tablePath, trajDir, timeCapSec }`.
 * No dependencies beyond the package and Node builtins.
 *
 * Wall-cap semantics: a new episode starts only while the worker is inside
 * `timeCapSec`; the in-flight episode gets a hard deadline at
 * `timeCapSec + episodeGraceSec` from worker start so a wedged episode fails
 * the worker (with its partial table written) instead of hanging the run
 * forever. The parent adds its own last-resort watchdog past that deadline.
 *
 * @module
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { runEpisode } from '../core/runner.js';
import { buildSuite } from '../scoring/suite.js';
import { score } from '../scoring/score.js';
import { CALIBRATION_GAMES, agentSeatFor, makeBaselineAgent } from './games.js';
import { BASELINE_KINDS, TABLE_FORMAT } from './checks.js';

/** @import { Trajectory } from '../core/types.js' */
/** @import { BaselineKind } from './games.js' */

/**
 * Default per-episode grace past the wall cap before the worker gives up on a
 * wedged episode. Generous by design: chess's longest legitimate episode on
 * the first full run ran ~221s inside grace. Override with
 * `CALIBRATION_EPISODE_GRACE_SEC` (tests use a small value).
 */
const EPISODE_GRACE_SEC = Number(process.env.CALIBRATION_EPISODE_GRACE_SEC ?? 900);

/**
 * Run one game's calibration to completion.
 *
 * @param {{ gameId: string, seedsLimit: number | null, tablePath: string, trajDir: string, timeCapSec: number }} config
 * @param {{ runEpisodeImpl?: typeof runEpisode, episodeGraceSec?: number }} [deps] Injectable for tests.
 * @returns {Promise<{ capHit: boolean, episodesRun: number, failure: string | null }>}
 *   `failure` is set when the worker gave up early (unknown game, wedged
 *   episode past its deadline); a partial table is still written for forensics.
 */
export async function runWorker(config, deps = {}) {
  const runEpisodeImpl = deps.runEpisodeImpl ?? runEpisode;
  const episodeGraceSec = deps.episodeGraceSec ?? EPISODE_GRACE_SEC;
  const entry = CALIBRATION_GAMES.find((g) => g.id === config.gameId);
  if (!entry) {
    return { capHit: false, episodesRun: 0, failure: `unknown game ${JSON.stringify(config.gameId)}` };
  }

  const game = entry.game;
  const startedAtMs = Date.now();
  // Any single episode must finish within this budget measured from worker
  // start: episodes begin only inside the cap, so this gives every episode at
  // least `episodeGraceSec` of its own time while bounding a wedged one.
  const episodeDeadlineMs = startedAtMs + (config.timeCapSec + episodeGraceSec) * 1000;

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
  /** @type {string | null} */
  let failure = null;

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
        /** @type {Trajectory} */
        let trajectory;
        /** @type {ReturnType<typeof setTimeout> | undefined} */
        let timer;
        try {
          trajectory = await Promise.race([
            runEpisodeImpl({
              game,
              tierId: tier.id,
              seed,
              split: 'public',
              agent,
            }),
            new Promise((_, reject) => {
              timer = setTimeout(
                () =>
                  reject(
                    new Error(
                      `episode ${kind}/${tier.id}/${i} exceeded its deadline (${Math.round((episodeDeadlineMs - startedAtMs) / 1000)}s from worker start) — possible wedge; failing the worker`
                    )
                  ),
                Math.max(1, episodeDeadlineMs - Date.now())
              );
            }),
          ]);
        } catch (err) {
          failure = String(/** @type {Error} */ (err)?.message ?? err);
          capHit = true;
          break outer;
        } finally {
          if (timer) clearTimeout(timer);
        }
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

  // Executed coverage lives per baseline per tier (`episodes` above); a
  // single top-level "seeds per tier" number cannot be honest when a cap
  // stops baselines mid-way (a cap can leave random at 20, greedy at 16 and
  // engine at 0 episodes). The requested seed limit is a run-level input and
  // is reported by REPORT.md's Run section.
  const table = {
    format: TABLE_FORMAT,
    game: {
      id: game.spec.id,
      version: game.spec.version,
      benchmark: game.spec.benchmark === true,
    },
    split: /** @type {'public'} */ ('public'),
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
        failure,
      },
      null,
      2
    )}\n`
  );

  return { capHit, episodesRun, failure };
}

// Script entry: run only when spawned directly by run.js (argv[2] is the JSON
// config), not when imported by tests.
if (process.argv[2] && process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = /** @type {{ gameId: string, seedsLimit: number | null, tablePath: string, trajDir: string, timeCapSec: number }} */ (
    JSON.parse(process.argv[2])
  );
  const result = await runWorker(config);
  if (result.failure) {
    console.error(`worker: ${result.failure}`);
    process.exit(1);
  }
}
