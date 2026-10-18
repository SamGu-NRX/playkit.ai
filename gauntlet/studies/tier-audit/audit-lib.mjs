/**
 * Shared tier-audit plumbing: the cell plan, single-tier suites, the
 * per-episode score mirror, and the committed skill-dial reuse loader.
 *
 * @module
 */

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import { GAMES } from '../../games/index.js';
import { buildSuite } from '../../scoring/suite.js';
import { manifestSha256 } from '../../runs/plan.js';

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

/** Cache for {@link soloVersionAtStudyHead}: one git show per game. @type {Map<string, string | null>} */
const soloVersionCache = new Map();

/**
 * Game version at the skill-dial solo study's head, for the reuse-currency
 * assertion.
 *
 * @param {string} gameId
 * @returns {Promise<string | null>} null when the lookup cannot be made.
 */
export async function soloVersionAtStudyHead(gameId) {
  if (soloVersionCache.has(gameId)) return /** @type {string | null} */ (soloVersionCache.get(gameId));
  try {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const out = await promisify(execFile)('git', [
      'show',
      'f7698f9a6c724780b8e2275df039255b84c2a900:gauntlet/games/' + gameId + '/index.js',
    ]);
    const match = out.stdout.match(/version:\s*'([^']+)'/);
    const version = match ? match[1] : null;
    soloVersionCache.set(gameId, version);
    return version;
  } catch {
    soloVersionCache.set(gameId, null);
    return null;
  }
}

/**
 * Whether the committed skill-dial solo reuse is current for a game: the
 * version the solo study measured must equal the registry's current version.
 * A game version bump strands the solo dial rows — run-cells then plays the
 * dial cells fresh and compute-tiers reads the local bundles instead.
 *
 * @param {string} gameId
 * @returns {Promise<boolean>}
 */
export async function soloReuseCurrent(gameId) {
  const game = /** @type {*} */ (GAMES[gameId]);
  if (!game?.spec?.version) return false;
  const solo = await soloVersionAtStudyHead(gameId);
  return solo !== null && solo === game.spec.version;
}

/** Repo root on disk. */
export function repoRoot() {
  return resolve(here, '../../..');
}

/** The audit's own directory. */
export function auditDir() {
  return here;
}

/**
 * Integrity failures in one cell's run.json record: the suite manifest it
 * claims must equal the expected one, and the agent id must name this cell's
 * agent. A record copied from another cell, another arm, or an older suite
 * manifest would otherwise pass the seed/replay checks while describing a
 * different study (Codex #4301264696).
 *
 * Dial agent ids embed the cell's expert (`dial-<expert-id>-p<p*100>`), and
 * expert ids vary per game (dial-engine, dial-sokoban-engine,
 * dial-engine-sand), so dial cells check the `dial-` prefix and the encoded
 * p (0 → p0, 0.5 → p50, 1 → p100) rather than a full template; no-skill
 * cells record the strategy id verbatim.
 *
 * @param {*} run parsed run.json
 * @param {string} cell
 * @param {string} expectedManifestSha256
 * @returns {string[]}
 */
export function runRecordFailures(run, cell, expectedManifestSha256) {
  const failures = [];
  const recorded = /** @type {*} */ (run)?.suite?.manifestSha256 ?? null;
  if (recorded !== expectedManifestSha256) {
    failures.push(
      `run.json suite manifest ${recorded ? String(recorded).slice(0, 12) : 'none'} != expected ${expectedManifestSha256.slice(0, 12)}`
    );
  }
  const agentId = /** @type {*} */ (run)?.agent?.id ?? null;
  const pPercent = cell === 'dial-0' ? '0' : cell === 'dial-05' ? '50' : '100';
  const agentMatches = cell.startsWith('dial-')
    ? typeof agentId === 'string' && agentId.startsWith('dial-') && agentId.endsWith(`-p${pPercent}`)
    : agentId === cell;
  if (!agentMatches) {
    failures.push(`run.json agent id ${agentId ?? 'none'} does not match the ${cell} cell`);
  }
  return failures;
}

/**
 * Cell-completion verdict for one audit cell bundle: the cell is complete
 * only when the bundle's suite manifest matches the expected one (when
 * supplied), run.json carries the same manifest hash, and every planned seed
 * has an on-disk trajectory that records the registry's **current** game
 * version AND the identity/shape the downstream readers dereference (game
 * id, tier, seed, agent seat, end action counts, and the outcome fields
 * rawEpisodeScore reads). `run.json` saying the episode count is reached is
 * not enough — #107 committed run.json plus suite.json with the raw
 * trajectories left untracked, and a game version bump (#108: mastermind
 * 1.1.0, wordle 1.2.0) strands every recorded episode — a stale,
 * trajectory-less, or malformed cell must re-run, not skip.
 *
 * @param {string} bundle the cell's bundle directory
 * @param {string} gameId
 * @param {string} tierId
 * @param {string[]} seeds the planned public seeds for the tier
 * @param {{ expectedManifestSha256?: string }} [opts] when set, the bundle's
 *   suite.json and run.json manifest hashes must equal it — a bundle built
 *   from an older manifest is not complete even when every file is present
 *   (run-cells clears such bundles via clearStaleBundle; the verdict must
 *   refuse them BEFORE the cleanup runs, or one resumption could skip a
 *   stale cell that the same invocation then clears).
 * @returns {Promise<{ complete: boolean, reason: string }>}
 */
export async function cellBundleVerdict(bundle, gameId, tierId, seeds, opts = {}) {
  const game = /** @type {*} */ (GAMES[gameId]);
  if (!existsSync(join(bundle, 'run.json'))) {
    return { complete: false, reason: 'no run.json' };
  }
  if (opts.expectedManifestSha256 !== undefined) {
    try {
      const recordedSuite = JSON.parse(await readFile(join(bundle, 'suite.json'), 'utf8'));
      const recordedHash = manifestSha256(recordedSuite);
      if (recordedHash !== opts.expectedManifestSha256) {
        return {
          complete: false,
          reason: `bundle suite manifest ${recordedHash.slice(0, 12)} differs from the expected ${opts.expectedManifestSha256.slice(0, 12)}`,
        };
      }
    } catch {
      return { complete: false, reason: 'bundle has no readable suite.json manifest' };
    }
    let run;
    try {
      run = JSON.parse(await readFile(join(bundle, 'run.json'), 'utf8'));
    } catch (err) {
      return { complete: false, reason: `unreadable run.json (${/** @type {Error} */ (err).message})` };
    }
    const runHash = /** @type {*} */ (run)?.suite?.manifestSha256 ?? null;
    // A missing hash is not evidence of correctness: only a recorded hash that
    // equals the expected one can vouch for the executed suite (Codex PR #115).
    if (runHash === null) {
      return {
        complete: false,
        reason: `run.json records no suite manifest (expected ${opts.expectedManifestSha256.slice(0, 12)})`,
      };
    }
    if (runHash !== opts.expectedManifestSha256) {
      return {
        complete: false,
        reason: `run.json suite manifest ${String(runHash).slice(0, 12)} differs from the expected ${opts.expectedManifestSha256.slice(0, 12)}`,
      };
    }
  }
  const tier = /** @type {*} */ (game)?.spec?.tiers?.find((/** @type {{ id: string }} */ t) => t.id === tierId) ?? null;
  const dir = join(bundle, gameId, tierId);
  for (const seed of seeds) {
    const path = join(dir, `${seed}.json`);
    if (!existsSync(path)) {
      return { complete: false, reason: `missing trajectory ${seed}` };
    }
    let trajectory;
    try {
      trajectory = JSON.parse(await readFile(path, 'utf8'));
    } catch (err) {
      return { complete: false, reason: `unreadable trajectory ${seed} (${/** @type {Error} */ (err).message})` };
    }
    const t = /** @type {*} */ (trajectory) ?? {};
    const recorded = t?.game?.version ?? null;
    if (recorded !== game?.spec?.version) {
      return {
        complete: false,
        reason: `trajectory ${seed} recorded game version ${recorded ?? 'none'}, registry is at ${game?.spec?.version ?? 'unknown'}`,
      };
    }
    // Identity and shape: everything the audit's readers dereference without
    // re-verifying (compute-tiers reads agent.seat and end.* directly; a
    // malformed or misfiled trajectory must fail the cell, not crash the
    // audit later).
    if (t?.game?.id !== gameId || t?.tier !== tierId || t?.seed !== seed) {
      return {
        complete: false,
        reason: `trajectory ${seed} is misfiled or mislabeled (game ${t?.game?.id ?? 'none'}, tier ${t?.tier ?? 'none'}, seed ${t?.seed ?? 'none'})`,
      };
    }
    const seat = t?.agent?.seat;
    if (!Number.isInteger(seat) || seat < 0) {
      return { complete: false, reason: `trajectory ${seed} carries no integer agent seat` };
    }
    if (!Number.isInteger(t?.end?.agentActions) || t.end.agentActions < 0) {
      return { complete: false, reason: `trajectory ${seed} carries no non-negative integer end.agentActions` };
    }
    if (t?.end?.invalidActions !== undefined && !Number.isInteger(t.end.invalidActions)) {
      return { complete: false, reason: `trajectory ${seed} carries a non-integer end.invalidActions` };
    }
    if (tier) {
      const outcome = t?.end?.outcome ?? null;
      if (tier.scoring === 'outcome') {
        const value = outcome?.normalized?.[seat];
        if (typeof value !== 'number' || !Number.isFinite(value)) {
          return {
            complete: false,
            reason: `trajectory ${seed} ended without a finite normalized[${seat}] on an outcome tier`,
          };
        }
      } else if (outcome?.solved === true) {
        const par = outcome?.par;
        if (typeof par !== 'number' || par <= 0 || !Number.isInteger(t.end.agentActions) || t.end.agentActions <= 0) {
          return {
            complete: false,
            reason: `trajectory ${seed} claims solved without usable par/actions`,
          };
        }
      }
    }
  }
  return {
    complete: true,
    reason: `all ${seeds.length} planned trajectories carry the current game version ${game?.spec?.version ?? 'unknown'}`,
  };
}
