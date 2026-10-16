/**
 * `gauntlet rate`: Elo-rate agents from their recorded chess trajectories.
 * Collects trajectory files from the given run directories (the same
 * recursive walk `leaderboard` uses), maps each trajectory to its ladder
 * rung via `rungForTrajectory` (`chess-paper`, `chess-stockfish-sf-10k`,
 * …), pre-filters to rungs the fitted ladder knows, and calls `rateAgent`
 * per agent id with every rung rating held fixed. Prints one row per agent:
 * games, rating, and the bootstrap 95% interval — or the divergence
 * direction for an agent that won or lost every game, which has no finite
 * maximum-likelihood rating.
 *
 * The ladder comes from `rating/ladder-results.json` (the file
 * `rating/ladder.js` writes); `--ladder <file>` points at another one. A
 * missing ladder is an error, not an empty rating.
 *
 * Node-only.
 *
 * @module
 */

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { rateAgent, selectLadderKnown } from '../rating/elo.js';
import { loadTrajectories } from './verify.js';

/** @import { AgentRating, AgentTrajectory, RatingLadder } from '../rating/elo.js' */

/** The ladder file `rating/ladder.js` writes, resolved from this package. */
const DEFAULT_LADDER_PATH = fileURLToPath(new URL('../rating/ladder-results.json', import.meta.url));

/**
 * Load a ladder-results file into the `RatingLadder` shape `rateAgent`
 * expects: `fit.ratings` maps rung ids to finite numbers and
 * `meta.anchor.rung` names the pinned rung. Validates both so a stale or
 * hand-mangled file fails loudly instead of rating against nothing.
 *
 * @param {string} path
 * @returns {RatingLadder}
 */
export function loadRatingLadder(path) {
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    throw new Error(`no Elo ladder at "${path}" — run rating/ladder.js first`);
  }
  let parsed;
  try {
    parsed = /** @type {*} */ (JSON.parse(raw));
  } catch (err) {
    throw new Error(`"${path}" is not valid JSON (${err instanceof Error ? err.message : String(err)})`);
  }
  const ratings = parsed && typeof parsed === 'object' ? parsed.fit?.ratings : undefined;
  const anchorRung = parsed && typeof parsed === 'object' ? parsed.meta?.anchor?.rung : undefined;
  const ratingsOk =
    !!ratings &&
    typeof ratings === 'object' &&
    !Array.isArray(ratings) &&
    Object.values(ratings).every((v) => typeof v === 'number' && Number.isFinite(v));
  if (!ratingsOk || typeof anchorRung !== 'string') {
    throw new Error(
      `"${path}" is not a gauntlet ladder-results file (expected fit.ratings mapping rung ids to finite numbers and meta.anchor.rung) — run rating/ladder.js first`
    );
  }
  if (!(anchorRung in ratings)) {
    throw new Error(
      `"${path}" pins anchor rung "${anchorRung}" but fit.ratings has no rating for it — run rating/ladder.js first`
    );
  }
  if (parsed.fit.error) {
    throw new Error(
      `"${path}" records a failed ladder fit (${JSON.stringify(parsed.fit.error)}) — run rating/ladder.js first`
    );
  }
  return { ratings: { ...ratings }, anchorRung };
}

/**
 * The leaderboard's ladder: the default file when it exists, else nothing —
 * the rating column is silently omitted rather than erroring, because a
 * leaderboard is meaningful without chess ratings. A file that exists but
 * is mangled still fails loudly through {@link loadRatingLadder}; only
 * absence is silent.
 *
 * @param {string} [path] Defaults to the package's `rating/ladder-results.json`.
 * @returns {RatingLadder | undefined}
 */
export function loadLeaderboardLadder(path = DEFAULT_LADDER_PATH) {
  if (!existsSync(path)) return undefined;
  return loadRatingLadder(path);
}

/**
 * One agent's rating row.
 *
 * @typedef {object} RateRow
 * @property {string} agent Agent id.
 * @property {number} games Trajectories rated (rung known to the ladder).
 * @property {number} skipped Trajectories left out — rung not in the ladder.
 * @property {string[]} skippedRungs Unique rung ids of the skipped ones.
 * @property {AgentRating | null} rating Null when nothing was rated.
 */

/**
 * Group trajectories by agent id, pre-filter each agent's to ladder-known
 * rungs, and rate. Agents whose trajectories all sit outside the ladder get
 * a zero-game row instead of a `rateAgent` refusal.
 *
 * @param {readonly AgentTrajectory[]} trajectories
 * @param {RatingLadder} ladder
 * @returns {RateRow[]} Sorted by agent id.
 */
export function groupAndRate(trajectories, ladder) {
  /** @type {Map<string, AgentTrajectory[]>} */
  const byAgent = new Map();
  for (const trajectory of trajectories) {
    // Runner-recorded trajectories always carry agent.id; a minimal
    // trajectory without one groups under '(no id)' rather than crashing.
    const id = trajectory.agent?.id ?? '(no id)';
    const bucket = byAgent.get(id);
    if (bucket) bucket.push(trajectory);
    else byAgent.set(id, [trajectory]);
  }
  /** @type {RateRow[]} */
  const rows = [];
  for (const [agent, list] of byAgent) {
    const { known, skippedRungs } = selectLadderKnown(list, ladder);
    rows.push({
      agent,
      games: known.length,
      skipped: list.length - known.length,
      skippedRungs,
      rating: known.length > 0 ? rateAgent(known, ladder) : null,
    });
  }
  return rows.sort((a, b) => (a.agent < b.agent ? -1 : a.agent > b.agent ? 1 : 0));
}

/**
 * @param {AgentRating} rating
 * @returns {string} The rating cell.
 */
function fmtRating(rating) {
  if (rating.rating === null) return '—';
  return rating.rating.toFixed(1);
}

/**
 * @param {AgentRating} rating
 * @returns {string} The interval cell, or the divergence direction for an
 *   agent with no finite maximum-likelihood rating.
 */
function fmtInterval(rating) {
  if (rating.direction !== null) return rating.direction;
  if (rating.rating === null) return '—';
  const low = rating.low === null ? 'unbounded' : rating.low.toFixed(1);
  const high = rating.high === null ? 'unbounded' : rating.high.toFixed(1);
  return `[${low}, ${high}]`;
}

/**
 * @typedef {object} RateOptions
 * @property {string[]} dirs Run directories to collect trajectories from.
 * @property {string} [ladderPath] Ladder-results file (default: the
 *   package's `rating/ladder-results.json`).
 * @property {boolean} [json] Print machine-readable JSON rows (default
 *   prints a fixed-width table).
 */

/**
 * Rate the run directories and print the result.
 *
 * @param {RateOptions} options
 * @returns {RateRow[]} The rows that were printed.
 */
export function rateRunDirs(options) {
  const ladderPath = options.ladderPath ?? DEFAULT_LADDER_PATH;
  const ladder = loadRatingLadder(ladderPath);
  const rows = groupAndRate(loadTrajectories(options.dirs), ladder);

  if (options.json) {
    process.stdout.write(
      JSON.stringify(
        {
          ladder: { path: ladderPath, anchorRung: ladder.anchorRung },
          agents: rows.map((row) => ({
            agent: row.agent,
            games: row.games,
            skipped: row.skipped,
            skippedRungs: row.skippedRungs,
            rating: row.rating?.rating ?? null,
            low: row.rating?.low ?? null,
            high: row.rating?.high ?? null,
            direction: row.rating?.direction ?? null,
          })),
        },
        null,
        2
      ) + '\n'
    );
    return rows;
  }

  const width = Math.max('agent'.length, ...rows.map((row) => row.agent.length));
  /** @type {string[]} */
  const lines = [`${'agent'.padEnd(width)}  games  rating    95% interval`];
  for (const row of rows) {
    const rating = row.rating ? fmtRating(row.rating) : '—';
    const interval = row.rating ? fmtInterval(row.rating) : '—';
    lines.push(`${row.agent.padEnd(width)}  ${String(row.games).padStart(5)}  ${rating.padEnd(8)}  ${interval}`);
  }
  for (const row of rows) {
    if (row.skipped > 0) {
      lines.push(
        `skipped ${row.agent}: ${row.skipped} not on the ladder (${row.skippedRungs.join(', ')})`
      );
    }
  }
  process.stdout.write(lines.join('\n') + '\n');
  return rows;
}
