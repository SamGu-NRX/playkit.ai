/**
 * `make-suite.mjs` — build the separation-pilot suite options from committed
 * data. Nothing here is hand-edited: the tier set comes from the tier audit's
 * committed `tiers.json` (studies/tier-audit, PR #107) and the seed lists come
 * from the game registry at the checkout's current game versions through
 * `scoring/suite.js buildSuite` — the same builder `gauntlet suite build`
 * uses. Rerunning the tool at the same base regenerates the suites
 * byte-identically.
 *
 * Options (fixed in PREREGISTRATION.md):
 *
 *   smallest    n=8 seeds/tier over the audit's resolving, non-exploitable,
 *               non-luck tiers whose LARGER dial gap needs <= 8 seeds for 80%
 *               power — the smallest seed count that resolves the dial gap.
 *   larger      n=12 seeds/tier over the same pool with larger gap <= 12,
 *               plus connect4/forced-win at its 12 available public seeds
 *               (disclosed sub-target: its upper gap projects 16 seeds).
 *   pilot-1seed the current 1-seed public pilot (76 jobs), for contrast.
 *
 * Usage: node make-suite.mjs --option <name> --out <file> [--quiet]
 *
 * @module
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { GAMES } from '../../games/index.js';
import { buildSuite } from '../../scoring/suite.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const TIERS_JSON = path.join(here, '../tier-audit/tiers.json');

/**
 * Read the tier audit's committed rows.
 *
 * @returns {Array<Record<string, *>>}
 */
function auditRows() {
  const tiers = JSON.parse(
    /** @type {string} */ (readFileSync(TIERS_JSON, 'utf8'))
  );
  if (tiers.format !== 'playkit-gauntlet-tier-audit/1') {
    throw new Error(`${TIERS_JSON}: not a tier-audit file (format ${JSON.stringify(tiers.format)})`);
  }
  return /** @type {Array<Record<string, *>>} */ (tiers.rows);
}

/**
 * The audit's seed-need numbers for a row, in the audit's own semantics: the
 * seed count at which each dial gap reaches 80% power (bootstrap, paired by
 * seed), or null when the gap never resolves within the audit's 64-seed
 * horizon.
 *
 * @param {Record<string, *>} row
 * @returns {{ need0: number | null, need05: number | null, bothNeed: number | null }}
 */
function dialNeeds(row) {
  const power = /** @type {Record<string, {seedsNeeded: number | null}>} */ (row.power);
  const need0 = power['p0vs05']?.seedsNeeded ?? null;
  const need05 = power['p05vs1']?.seedsNeeded ?? null;
  const bothNeed =
    typeof need0 === 'number' && typeof need05 === 'number' ? Math.max(need0, need05) : null;
  return { need0, need05, bothNeed };
}

/**
 * The audit's resolving, non-exploitable, non-luck pool — the rows this study
 * is allowed to build suites from (PREREGISTRATION.md, "Suite options").
 *
 * @param {Array<Record<string, *>>} rows
 * @returns {Array<Record<string, *>>}
 */
function candidatePool(rows) {
  return rows.filter(
    (r) =>
      /** @type {string[]} */ (r.flags).includes('resolves-at-12-or-fewer') &&
      !/** @type {string[]} */ (r.flags).some((f) => f.startsWith('exploitable')) &&
      !/** @type {string[]} */ (r.flags).includes('luck-dominated')
  );
}

/** The one pre-registered sub-target exception for the `larger` option. */
const LARGER_SUBTARGETS = ['connect4/forced-win'];

/**
 * The audit rows for an option, with its seed count, suite id and notes.
 *
 * @param {string} option
 * @param {Array<Record<string, *>>} pool
 * @returns {{ n: number, rows: Array<Record<string, *>>, notes: Map<string, string>, id: string }}
 */
function optionTiers(option, pool) {
  /** @type {Map<string, string>} */
  const notes = new Map();
  if (option === 'smallest') {
    const rows = pool.filter((r) => {
      const { bothNeed } = dialNeeds(r);
      return bothNeed !== null && bothNeed <= 8;
    });
    return { n: 8, rows, notes, id: 'separation-pilot-smallest-8' };
  }
  if (option === 'larger') {
    const rows = pool.filter((r) => {
      const { bothNeed } = dialNeeds(r);
      if (bothNeed !== null && bothNeed <= 12) return true;
      const key = `${r.game}/${r.tier}`;
      if (LARGER_SUBTARGETS.includes(key)) {
        notes.set(key, 'pre-registered sub-target: upper dial gap needs > 12 seeds for 80% power');
        return true;
      }
      return false;
    });
    return { n: 12, rows, notes, id: 'separation-pilot-larger-12' };
  }
  if (option === 'pilot-1seed') {
    // The current pilot as written: every registered tier at one seed.
    return { n: 1, rows: auditRows(), notes, id: 'gauntlet-public-first1' };
  }
  throw new Error(`unknown option ${JSON.stringify(option)}; expected smallest | larger | pilot-1seed`);
}

/**
 * Derive the suite's game views from the registry: tiers filtered to the
 * option's selection, seed counts capped at `min(n, available)`, ranks
 * renumbered consecutive from 1 as `buildSuite` requires. Pure over the
 * registry — the game objects themselves are immutable once registered.
 *
 * @param {Array<Record<string, *>>} rows Selected audit rows.
 * @param {number} n Option seed count.
 * @returns {{ games: *[], included: Array<{ key: string, gameId: string, tierId: string, version: string, scoring: string, available: number, seeds: number, need0: number | null, need05: number | null, bothNeed: number | null, note: string }> }}
 */
function deriveGames(rows, n) {
  /** @type {Map<string, Array<{ auditRow: Record<string, *>, tier: * }>>} */
  const byGame = new Map();
  /** @type {Array<{ key: string, gameId: string, tierId: string, version: string, scoring: string, available: number, seeds: number, need0: number | null, need05: number | null, bothNeed: number | null, note: string }>} */
  const included = [];
  for (const row of rows) {
    const gameId = /** @type {string} */ (row.game);
    const tierId = /** @type {string} */ (row.tier);
    const game = GAMES[gameId];
    if (!game) throw new Error(`registry has no game ${JSON.stringify(gameId)}`);
    const tier = game.spec.tiers.find((t) => t.id === tierId);
    if (!tier) throw new Error(`game ${gameId} has no tier ${tierId} at version ${game.spec.version}`);
    if (game.spec.version !== row.gameVersion) {
      throw new Error(
        `tier ${gameId}/${tierId}: audit recorded version ${row.gameVersion}, registry is at ${game.spec.version}; suites must be rebuilt at current versions — update the audit first`
      );
    }
    if (!byGame.has(gameId)) byGame.set(gameId, []);
    byGame.get(/** @type {string} */ (gameId)).push({ auditRow: row, tier });
  }
  /** @type {*[]} */
  const games = [];
  for (const [gameId, selections] of byGame) {
    const game = GAMES[gameId];
    const tiers = selections.map(({ auditRow, tier }, index) => {
      const seeds = Math.min(n, tier.publicSeeds);
      const { need0, need05, bothNeed } = dialNeeds(auditRow);
      included.push({
        key: `${gameId}/${tier.id}`,
        gameId,
        tierId: tier.id,
        version: game.spec.version,
        scoring: tier.scoring,
        available: tier.publicSeeds,
        seeds,
        need0,
        need05,
        bothNeed,
        note: seeds < n ? `capped at ${tier.publicSeeds} public seeds` : '',
      });
      return { ...tier, rank: index + 1, publicSeeds: seeds };
    });
    games.push({ ...game, spec: { ...game.spec, tiers } });
  }
  included.sort((a, b) => a.key.localeCompare(b.key));
  return { games, included };
}

/**
 * @param {string} option
 * @param {string | undefined} out
 * @param {boolean} quiet
 */
async function main(option, out, quiet) {
  const pool = option === 'pilot-1seed' ? auditRows() : candidatePool(auditRows());
  const { n, rows, notes, id } = optionTiers(option, pool);
  const { games, included } = deriveGames(rows, n);
  if (games.length === 0) {
    throw new Error(`option ${option}: no tiers selected — the audit pool changed; refusing to build an empty suite`);
  }
  const suite = buildSuite(games, { split: 'public', id });
  const jobs = included.reduce((acc, t) => acc + t.seeds, 0);

  if (!quiet) {
    process.stdout.write(`option ${option} (${id}): ${included.length} tiers, ${games.length} games, ${jobs} episodes per arm\n\n`);
    process.stdout.write(
      ['tier', 'scoring', 'avail', 'seeds', 'need0', 'need05', 'bothNeed', 'note'].join('\t') + '\n'
    );
    for (const t of included) {
      process.stdout.write(
        [
          t.key,
          t.scoring,
          String(t.available),
          String(t.seeds),
          t.need0 === null ? '-' : String(t.need0),
          t.need05 === null ? '-' : String(t.need05),
          t.bothNeed === null ? '-' : String(t.bothNeed),
          t.note || notes.get(t.key) || '',
        ].join('\t') + '\n'
      );
    }
  }
  if (out) {
    mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
    writeFileSync(out, JSON.stringify(suite, null, 2) + '\n');
    if (!quiet) process.stdout.write(`\nwrote ${out}\n`);
  } else {
    process.stdout.write(JSON.stringify(suite, null, 2) + '\n');
  }
}

const argv = process.argv.slice(2);
/** @type {Record<string, string>} */
const flags = {};
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--option') flags.option = argv[++i];
  else if (argv[i] === '--out') flags.out = argv[++i];
  else if (argv[i] === '--quiet') flags.quiet = 'true';
  else throw new Error(`unknown argument ${JSON.stringify(argv[i])}`);
}
await main(flags.option, flags.out, flags.quiet === 'true');
