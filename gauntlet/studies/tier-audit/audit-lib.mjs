/**
 * Shared tier-audit plumbing: the cell plan, single-tier suites, the
 * per-episode score mirror, and the committed skill-dial reuse loader.
 *
 * @module
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import { GAMES } from '../../games/index.js';
import { buildSuite } from '../../scoring/suite.js';

const here = dirname(fileURLToPath(import.meta.url));

/** The audit's cell kinds, in run order. */
export const CELL_KINDS = /** @type {const} */ ([
  'dial-0',
  'dial-05',
  'dial-1',
  'copy-example',
  'first-legal',
]);

/**
 * Wall-clock seed caps. Full public seeds everywhere except chess-puzzles,
 * whose 6 tiers x 60 seeds x 5 cells cannot fit the audit budget; the cap is
 * a recorded deviation, not a scoring choice.
 *
 * @type {Record<string, number>}
 */
export const SEED_CAPS = {};

/**
 * Cells that cannot exist for structural reasons, keyed `<game>[/<tier>]|<cell>`
 * (a bare game key covers every tier of that game), with the reason. The
 * runner skips them (logging `na`), and compute-tiers records them as
 * `not-applicable: <reason>` in cellSources instead of a bare `missing`.
 *
 * @type {Map<string, string>}
 */
export const NA_CELLS = new Map([
  ['tictactoe|dial-0', 'no engine baseline to dial: tictactoe ships no baseline agents'],
  ['tictactoe|dial-05', 'no engine baseline to dial: tictactoe ships no baseline agents'],
  ['tictactoe|dial-1', 'no engine baseline to dial: tictactoe ships no baseline agents'],
  ['chess-puzzles|dial-0', 'no engine baseline to dial: chess-puzzles ships no baseline agents'],
  ['chess-puzzles|dial-05', 'no engine baseline to dial: chess-puzzles ships no baseline agents'],
  ['chess-puzzles|dial-1', 'no engine baseline to dial: chess-puzzles ships no baseline agents'],
  ['chess-stockfish|dial-0', 'no engine baseline to dial: chess-stockfish ships no baseline agents'],
  ['chess-stockfish|dial-05', 'no engine baseline to dial: chess-stockfish ships no baseline agents'],
  ['chess-stockfish|dial-1', 'no engine baseline to dial: chess-stockfish ships no baseline agents'],
  ['cube/cube-5|dial-05', 'expert optimal solver refuses scrambles beyond its proven 10-turn range'],
  ['cube/cube-7|dial-05', 'expert optimal solver refuses scrambles beyond its proven 10-turn range'],
  ['cube/cube-9|dial-05', 'expert optimal solver refuses scrambles beyond its proven 10-turn range'],
  ['sudoku|dial-05', 'expert solver hits contradictions on half-mixed states'],
]);


/**
 * Public seeds the audit runs for one tier (the tier's full public list,
 * capped per {@link SEED_CAPS}).
 *
 * @param {string} gameId
 * @param {{ id: string, publicSeeds?: number }} tier
 * @returns {string[]}
 */
export function seedsForTier(gameId, tier) {
  const cap = SEED_CAPS[gameId] ?? Number.POSITIVE_INFINITY;
  const count = Math.min(tier.publicSeeds ?? 0, cap);
  return Array.from({ length: count }, (_, i) => `${gameId}/${tier.id}/public/${i}`);
}

/**
 * A single-tier public suite, built through the scoring layer's own
 * constructor from a one-tier view of the game.
 *
 * @param {string} gameId
 * @param {string} tierId
 * @returns {{ suite: *, game: *, tier: * }}
 */
export function tierSuite(gameId, tierId) {
  const game = /** @type {*} */ (GAMES[gameId]);
  if (!game) throw new Error(`unknown game ${gameId}`);
  const tier = game.spec.tiers.find((/** @type {{ id: string }} */ t) => t.id === tierId);
  if (!tier) throw new Error(`unknown tier ${gameId}/${tierId}`);

  // A one-tier VIEW of the game: spec is copied, not mutated, and the tier
  // list is replaced with a rank-1 renumbering — buildSuite demands ranks
  // consecutive from 1, and the registry object itself is never touched.
  const oneTierView = {
    ...game,
    spec: { ...game.spec, tiers: [{ ...tier, rank: 1 }] },
    tiers: [tier],
  };
  const suite = buildSuite([oneTierView], {
    split: 'public',
    id: `playkit-gauntlet-tier-audit-${gameId}-${tierId}`,
  });
  return { suite, game, tier };
}

/**
 * The episode-score mirror: the same rules `scoring/score.js` applies, per
 * episode. `compute-tiers.mjs` cross-checks every bundle group against
 * score() itself and refuses to publish on any round-6 disagreement.
 *
 * @param {*} game
 * @param {*} tier
 * @param {*} trajectory
 * @returns {{ e: number, solved: boolean, agentActions: number }}
 */
export function rawEpisodeScore(game, tier, trajectory) {
  const outcome = trajectory.end?.outcome ?? null;
  const seat = trajectory.agent.seat;
  if (tier.scoring === 'outcome') {
    const value = outcome?.normalized?.[seat];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error(`${game.spec.id}/${tier.id}/${trajectory.seed}: no finite normalized[${seat}]`);
    }
    return { e: value, solved: outcome?.solved === true, agentActions: trajectory.end.agentActions };
  }
  if (outcome?.solved !== true) {
    return { e: 0, solved: false, agentActions: trajectory.end.agentActions };
  }
  const par = outcome?.par;
  const agentActions = trajectory.end.agentActions;
  if (typeof par !== 'number' || par <= 0 || !Number.isInteger(agentActions) || agentActions <= 0) {
    throw new Error(`${game.spec.id}/${tier.id}/${trajectory.seed}: solved without usable par/actions`);
  }
  const cap = tier.parKind === 'optimal' ? 1.0 : 1.15;
  return { e: Math.min(cap, (par / agentActions) ** 2), solved: true, agentActions };
}

/**
 * All three profile scores for one episode.
 *
 * @param {number} e Raw rhae-v1 episode score.
 * @param {*} tier
 * @param {number | null} r The committed random-baseline mean for
 *   chance-adjusted; null where the profile is refused or unchanged.
 * @returns {{ 'rhae-v1': number, 'squared-outcome': number, 'chance-adjusted': number | null }}
 */
export function profileScores(e, tier, r) {
  const isOutcome = tier.scoring === 'outcome';
  return {
    'rhae-v1': e,
    'squared-outcome': isOutcome ? e * e : e,
    'chance-adjusted': isOutcome && r !== null ? Math.max(0, (e - r) / (1 - r)) : isOutcome ? null : e,
  };
}

/**
 * The committed skill-dial solo study's public per-seed episodes, keyed
 * `game|tier|p|seed`. The solo study ran at f7698f9a; every game it covers
 * carries the same spec version at the audit's base (checked by the audit's
 * runner, recorded per row), and its dial, experts and random agent are
 * byte-identical since that commit — so its p = 0 / 0.5 / 1 public rows are
 * the dial cells for those tiers.
 *
 * @returns {Promise<Map<string, { raw: number, profiles: { 'rhae-v1': number, 'squared-outcome': number, 'chance-adjusted': number | null } }>>}
 */
export async function loadSoloReuse() {
  const path = resolve(here, '../skill-dial/solo/episodes.json');
  const rows = JSON.parse(await readFile(path, 'utf8'));
  const map = new Map();
  for (const row of rows) {
    if (row.split !== 'public' || row.error !== null) continue;
    if (![0, 0.5, 1].includes(row.p)) continue;
    map.set(`${row.game}|${row.tier}|${row.p}|${row.seed}`, {
      raw: row.profilesExact['rhae-v1'],
      solved: row.solved === true,
      profiles: {
        'rhae-v1': row.profilesExact['rhae-v1'],
        'squared-outcome': row.profilesExact['squared-outcome'],
        'chance-adjusted': row.profilesExact['chance-adjusted'],
      },
    });
  }
  return map;
}

/**
 * Game version at the skill-dial solo study's head, for the reuse-currency
 * assertion.
 *
 * @param {string} gameId
 * @returns {Promise<string | null>} null when the lookup cannot be made.
 */
export async function soloVersionAtStudyHead(gameId) {
  try {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const out = await promisify(execFile)('git', [
      'show',
      'f7698f9a6c724780b8e2275df039255b84c2a900:gauntlet/games/' + gameId + '/index.js',
    ]);
    const match = out.stdout.match(/version:\s*'([^']+)'/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

/** Repo root on disk. */
export function repoRoot() {
  return resolve(here, '../../..');
}

/** The audit's own directory. */
export function auditDir() {
  return here;
}
