/**
 * Compute the study's statistics from the run ndjson and write
 * `results.json`. For every (game, p) it scores the dial's trajectories with
 * the production scorer (`scoring/score.js`) under all three profiles —
 * rhae-v1 (primary), chance-adjusted (needs the study-local baseline file,
 * `baseline-random.json`), and squared-outcome — then derives:
 *
 * - monotonicity: Spearman rho between p and the tier mean, per profile;
 * - discrimination: rho <= -0.9 AND non-overlapping 95% CIs at p=0.25 vs
 *   p=0.75 (rhae-v1);
 * - saturation: the tier's p=0 and p=1 intervals overlap, i.e. the ladder
 *   rung cannot tell a full expert from a full random agent;
 * - ladder straddling: for each adjacent rung pair (easier A, harder B) and
 *   each p, gap_p = dial(A,p) - dial(B,p); the pair is straddled when some p
 *   has a positive gap whose endpoints' intervals are disjoint.
 *
 * Modes: `--game=<id>` computes and writes one game's block (the driver runs
 * these in parallel — score() re-verifies every trajectory per call, which
 * is the slow part); `--merge=<file,file,...>` assembles results.json from
 * per-game outputs in config order; with neither flag it computes every game
 * sequentially. results.json is deterministic: every input is a seeded
 * agent trajectory and the scorer's bootstrap is keyed by suite id + agent
 * id, so a rerun of the same code reproduces it byte for byte.
 *
 * @module
 */

import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { GAMES } from '../../../games/index.js';
import { score } from '../../../scoring/score.js';
import { SCORING_PROFILES } from '../../../scoring/profiles.js';
import { loadBaselineFile } from '../../../scoring/baselines.js';
import { publicSeed } from '../../../core/seeds.js';
import { PS, SUITE_ID, SEEDS } from './config.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const runsDir = resolve(here, 'runs');

const argv = process.argv.slice(2);
const runsArg = argv.find((a) => a.startsWith('--runs='))?.split('=')[1];
const outArg = argv.find((a) => a.startsWith('--out='))?.split('=')[1];
const runsRoot = runsArg ? resolve(here, runsArg) : runsDir;
const outFile = outArg ? resolve(here, outArg) : resolve(here, 'results.json');
const gameArg = argv.find((a) => a.startsWith('--game='))?.split('=')[1];
const mergeArg = argv.find((a) => a.startsWith('--merge='))?.split('=')[1];

/** @import { Game, Trajectory } from '../../../core/types.js' */
/** @import { SuiteManifest } from '../../../scoring/suite.js' */

/**
 * Round to 6 decimals, matching the scorer's precision.
 *
 * @param {number} x
 * @returns {number}
 */
function round6(x) {
  return Math.round(x * 1e6) / 1e6;
}

/**
 * Build the study's per-game suite manifest: the suite/1 format over the
 * game's tiers, with the study's seed plan (publicSeed format, counts from
 * config.mjs — beyond some tiers' listed publicSeeds budgets, which is why
 * the manifest is built here rather than via buildSuite). Suite id is
 * `<SUITE_ID>-<gameId>`, which pins the scorer's seeded bootstrap.
 *
 * @param {Game<*>} game
 * @returns {SuiteManifest}
 */
function studySuite(games) {
  const spec = games[0].spec;
  const sortedTiers = [...spec.tiers].sort((a, b) => a.rank - b.rank);
  return {
    format: 'playkit-gauntlet-suite/1',
    id: `${SUITE_ID}-${games[0].spec.id}`,
    split: 'public',
    saltCommitment: null,
    games: games.map((game) => {
      const gameSpec = game.spec;
      const gameTiers = [...gameSpec.tiers].sort((a, b) => a.rank - b.rank);
      return {
        id: gameSpec.id,
        version: gameSpec.version,
        requires: [...(gameSpec.requires ?? [])],
        tiers: gameTiers.map((tier) => {
          /** @type {Record<string, unknown>} */
          const out = {
            id: tier.id,
            rank: tier.rank,
            scoring: tier.scoring,
            seeds: seedStrings(game, tier.id),
          };
          if (tier.scoring === 'efficiency') {
            out.parKind = /** @type {'optimal' | 'reference'} */ (tier.parKind);
          }
          return out;
        }),
      };
    }),
  };
}

/**
 * The study's seed strings for one tier.
 *
 * @param {Game<*>} game
 * @param {string} tierId
 * @returns {string[]}
 */
function seedStrings(game, tierId) {
  const count = SEEDS[game.spec.id]?.[tierId];
  if (!count) throw new Error(`no seed count for ${game.spec.id}/${tierId}`);
  return Array.from({ length: count }, (_, i) => publicSeed(game.spec.id, tierId, i));
}

/**
 * Read one cell's ndjson into trajectories sorted by seed.
 *
 * @param {string} gameId
 * @param {string} tierId
 * @param {number} p
 * @returns {Promise<Trajectory[]>}
 */
async function readCell(gameId, tierId, p) {
  const file = join(runsRoot, gameId, tierId, `p${Math.round(p * 100)}.ndjson`);
  const text = await readFile(file, 'utf8');
  const rows = text
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => /** @type {{ header: { seed: string }, trajectory: Trajectory }} */ (JSON.parse(line)))
    .sort((a, b) => (a.header.seed < b.header.seed ? -1 : a.header.seed > b.header.seed ? 1 : 0));
  return rows.map((row) => row.trajectory);
}

/**
 * Spearman rank correlation between the p ladder and the mean scores.
 *
 * @param {number[]} xs
 * @param {number[]} ys
 * @returns {number}
 */
function spearman(xs, ys) {
  const n = xs.length;
  const rank = (/** @type {number[]} */ values) => {
    const order = values.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
    /** @type {number[]} */
    const ranks = new Array(n).fill(0);
    let k = 0;
    while (k < n) {
      let j = k;
      while (j + 1 < n && order[j + 1].v === order[k].v) j++;
      const averageRank = (k + j) / 2;
      for (let m = k; m <= j; m++) ranks[order[m].i] = averageRank;
      k = j + 1;
    }
    return ranks;
  };
  const rx = rank(xs);
  const ry = rank(ys);
  const mx = rx.reduce((a, b) => a + b, 0) / n;
  const my = ry.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i++) {
    num += (rx[i] - mx) * (ry[i] - my);
    dx += (rx[i] - mx) ** 2;
    dy += (ry[i] - my) ** 2;
  }
  return num / Math.sqrt(dx * dy);
}

/**
 * Do two 95% CIs overlap?
 *
 * @param {[number, number] | null} a
 * @param {[number, number] | null} b
 * @returns {boolean}
 */
function intervalsOverlap(a, b) {
  if (!a || !b) return false;
  return a[0] <= b[1] && b[0] <= a[1];
}

/**
 * Compute one game's full report block.
 *
 * @param {Game<*>} game
 * @returns {Promise<Record<string, unknown>>}
 */
async function computeGame(game) {
  const gameId = game.spec.id;
  // score() refuses suites with no benchmark game; a non-benchmark study game
  // (only tic-tac-toe here) rides with one benchmark study game's manifest
  // entry. Tier scores read only the target game's own tiers, so this changes
  // nothing about how its trajectories are scored.
  const suiteGames = game.spec.benchmark
    ? [game]
    : [game, ...Object.values(GAMES).filter((g) => g.spec.benchmark && SEEDS[g.spec.id]).slice(0, 1)];
  const suite = studySuite(suiteGames);
  /** @type {Record<string, unknown>} */
  const tiersReport = {};

  for (const tierId of Object.keys(SEEDS[gameId])) {
    /** @type {Record<string, { p: number, mean: number | null, ci95: [number, number] | null }[]>} */
    const profileStats = {};
    for (const profile of SCORING_PROFILES) {
      profileStats[profile] = [];
    }
    /** @type {number[]} */
    const episodeCounts = [];

    for (const p of PS) {
      const trajectories = await readCell(gameId, tierId, p);
      episodeCounts.push(trajectories.length);
      const agentId = `dial-engine-p${Math.round(p * 100)}`;
      const agent = { id: agentId, track: 'baseline' };
      for (const profile of SCORING_PROFILES) {
        /** @type {{ agent: { id: string, track: string }, profile: string, baseline?: unknown, baselineSha256?: string }} */
        const options = { agent, profile };
        if (profile === 'chance-adjusted') {
          const loaded = loadBaselineFile(resolve(here, 'baseline-random.json'));
          options.baseline = loaded.baseline;
          options.baselineSha256 = loaded.sha256;
        }
        const entryScore = await score(suite, trajectories, suiteGames, options);
        const tierScore = entryScore.games[gameId].tiers[tierId].score;
        profileStats[profile].push({ p, mean: tierScore.value, ci95: tierScore.ci95 });
      }
    }

    const primary = profileStats['rhae-v1'];
    const rhoByProfile = Object.fromEntries(
      Object.entries(profileStats).map(([profile, stats]) => [
        profile,
        round6(spearman(stats.map((s) => s.p), stats.map((s) => s.mean ?? 0))),
      ])
    );
    const atP = (/** @type {number} */ target) => primary.find((s) => s.p === target) ?? null;
    const p25 = atP(0.25);
    const p75 = atP(0.75);
    const p0 = atP(0);
    const p100 = atP(1);
    const discriminates =
      rhoByProfile['rhae-v1'] <= -0.9 && !!p25 && !!p75 && !intervalsOverlap(p25.ci95, p75.ci95);

    tiersReport[tierId] = {
      seeds: episodeCounts[0],
      episodes: Object.fromEntries(PS.map((p, i) => [p, episodeCounts[i]])),
      profiles: Object.fromEntries(
        Object.entries(profileStats).map(([profile, stats]) => [
          profile,
          stats.map((s) => ({ p: s.p, mean: s.mean === null ? null : round6(s.mean), ci95: s.ci95 })),
        ])
      ),
      rhoByProfile,
      discriminates,
      saturated: intervalsOverlap(p0?.ci95 ?? null, p100?.ci95 ?? null),
    };
  }

  // Ladder straddling over adjacent rung pairs, rhae-v1 primary.
  const spec = game.spec;
  const ranked = [...spec.tiers].sort((a, b) => a.rank - b.rank).map((t) => t.id);
  /** @type {{ easier: string, harder: string, bestP: number, maxGap: number, straddled: boolean }[]} */
  const pairs = [];
  for (let i = 0; i + 1 < ranked.length; i++) {
    const easier = ranked[i];
    const harder = ranked[i + 1];
    let best = { p: 0, gap: -Infinity, separable: false };
    for (const p of PS) {
      const a = /** @type {{ mean: number | null, ci95: [number, number] | null } | undefined} */ (
        /** @type {any} */ (tiersReport[easier]).profiles['rhae-v1'].find((/** @type {any} */ s) => s.p === p)
      );
      const b = /** @type {{ mean: number | null, ci95: [number, number] | null } | undefined} */ (
        /** @type {any} */ (tiersReport[harder]).profiles['rhae-v1'].find((/** @type {any} */ s) => s.p === p)
      );
      const gap = (a?.mean ?? 0) - (b?.mean ?? 0);
      const separable = gap > 0 && !intervalsOverlap(a?.ci95 ?? null, b?.ci95 ?? null);
      if (gap > best.gap) {
        best = { p, gap, separable };
      }
    }
    pairs.push({ easier, harder, bestP: best.p, maxGap: round6(best.gap), straddled: best.separable });
  }

  return { expert: 'engine', tiers: tiersReport, ladderStraddle: pairs };
}

if (mergeArg) {
  // Assemble results.json from per-game outputs, in config game order.
  const mergeFiles = mergeArg.split(',');
  /** @type {Record<string, unknown>} */
  const gamesReport = {};
  for (const gameId of Object.keys(SEEDS)) {
    const file = mergeFiles.find((f) => resolve(here, f).endsWith(`${gameId}.json`));
    if (!file) throw new Error(`merge: no per-game output for ${gameId}`);
    const parsed = JSON.parse(await readFile(resolve(here, file), 'utf8'));
    gamesReport[gameId] = parsed.games ? parsed.games[gameId] : parsed;
  }
  const results = {
    meta: {
      study: 'skill-dial-versus-engine',
      suiteId: SUITE_ID,
      expert: 'engine (calibration map baseline)',
      ps: PS,
      seeds: SEEDS,
      profiles: SCORING_PROFILES,
      primaryProfile: 'rhae-v1',
    },
    games: gamesReport,
  };
  await writeFile(outFile, `${JSON.stringify(results, null, 2)}\n`);
  console.log(`compute-stats: merged ${mergeFiles.length} games -> ${outFile}`);
} else {
  const targets = gameArg ? [gameArg] : Object.keys(SEEDS);
  /** @type {Record<string, unknown>} */
  const gamesReport = {};
  for (const gameId of targets) {
    const game = GAMES[gameId];
    if (!game) throw new Error(`compute-stats: unknown game ${gameId}`);
    gamesReport[gameId] = await computeGame(game);
    console.log(`compute-stats: ${gameId} done`);
  }
  const results = {
    meta: {
      study: 'skill-dial-versus-engine',
      suiteId: SUITE_ID,
      expert: 'engine (calibration map baseline)',
      ps: PS,
      seeds: SEEDS,
      profiles: SCORING_PROFILES,
      primaryProfile: 'rhae-v1',
    },
    games: gamesReport,
  };
  await writeFile(outFile, `${JSON.stringify(results, null, 2)}\n`);
  console.log(`compute-stats: wrote ${outFile}`);
}
