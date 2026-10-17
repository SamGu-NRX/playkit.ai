#!/usr/bin/env node
/**
 * Compute the tier-audit tables from the cell bundles plus the committed
 * skill-dial solo reuse, cross-checking every bundle group against the
 * scoring layer itself before anything is published.
 *
 * Writes tiers.json (the committed tables) and report-data.json. Both are
 * deterministic: every bootstrap is seeded, and reproduce.sh diffs the
 * regenerated tiers.json against the committed one.
 *
 * @module
 */

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { GAMES } from '../../games/index.js';
import { score } from '../../scoring/score.js';
import { loadBaselineFile } from '../../scoring/baselines.js';

import {
  auditDir,
  loadSoloReuse,
  profileScores,
  rawEpisodeScore,
  seedsForTier,
  tierSuite,
  CELL_KINDS,
} from './audit-lib.mjs';
import { bootstrapCi95, mean, round6, sampleSd, seedsNeeded } from './lib.mjs';
import { extractExampleToken } from './no-skill.mjs';

const root = auditDir();
const PROFILES = /** @type {const} */ (['rhae-v1', 'squared-outcome', 'chance-adjusted']);

const baseline = await loadBaselineFile(join(root, '../../scoring/baselines/random-public.json'));
const solo = await loadSoloReuse();

/**
 * The committed random-baseline mean for a tier, or null where the baseline
 * refuses the tier (version mismatch — cube).
 *
 * @param {string} gameId
 * @param {string} tierId
 * @returns {number | null}
 */
function randomMean(gameId, tierId) {
  const entry = baseline.baseline.games?.[gameId]?.tiers?.[tierId];
  const game = /** @type {*} */ (GAMES[gameId]);
  if (!entry || entry.version !== game.spec.version) return null;
  return entry.mean;
}

/** @type {*[]} */
const rows = [];
let mirrorChecks = 0;

for (const [gameId, gameRaw] of Object.entries(GAMES)) {
  const game = /** @type {*} */ (gameRaw);
  const example = extractExampleToken(game.spec.rulesText);
  for (const tier of game.spec.tiers) {
    const seeds = seedsForTier(gameId, tier);
    const r = randomMean(gameId, tier.id);

    /**
     * Per-seed episode scores for one cell: [raw e, profile map].
     * @type {Map<string, { raw: number, profiles: Record<string, number | null> }>}
     */
    const cellScores = new Map();
    /** @type {Record<string, string | null>} */
    const sources = {};

    for (const cell of CELL_KINDS) {
      const isDial = cell.startsWith('dial-');
      if (isDial) {
        const p = cell === 'dial-0' ? 0 : cell === 'dial-05' ? 0.5 : 1;
        const reused = seeds.every((s) => solo.has(`${gameId}|${tier.id}|${p}|${s}`));
        if (reused) {
          sources[cell] = 'skill-dial-solo';
          for (const seed of seeds) {
            cellScores.set(`${cell}|${seed}`, {
              raw: solo.get(`${gameId}|${tier.id}|${p}|${seed}`).raw,
              profiles: {},
            });
          }
          continue;
        }
      }
      const bundle = join(root, 'bundles', gameId, tier.id, cell);
      if (!existsSync(join(bundle, 'run.json'))) {
        sources[cell] = 'missing';
        continue;
      }
      sources[cell] = 'tier-audit';
      const { suite } = tierSuite(gameId, tier.id);
      const dir = join(bundle, gameId, tier.id);
      /** @type {*}[] */
      const trajectories = [];
      for (const seed of seeds) {
        const trajectory = JSON.parse(await readFile(join(dir, `${seed}.json`), 'utf8'));
        trajectories.push(trajectory);
        const raw = rawEpisodeScore(game, tier, trajectory);
        cellScores.set(`${cell}|${seed}`, { raw: raw.e, profiles: {} });
      }
      // Mirror gate: the scoring layer itself, per profile, must agree with
      // the audit's per-episode mirror to 6 decimals for this group.
      for (const profile of PROFILES) {
        if (profile === 'chance-adjusted' && r === null) continue;
        let published;
        try {
          const entry = await score(suite, trajectories, GAMES, {
            profile,
            baseline: baseline.baseline,
            baselineSha256: baseline.sha256,
          });
          published = entry.games[gameId].tiers[tier.id].score.value;
        } catch (err) {
          throw new Error(`mirror gate ${gameId}/${tier.id}/${cell}/${profile}: ${err.message}`);
        }
        const mirrorScores = trajectories.map((t) => {
          const raw = rawEpisodeScore(game, tier, t);
          return /** @type {number} */ (profileScores(raw.e, tier, r)[profile]);
        });
        if (round6(published) !== round6(mean(mirrorScores))) {
          throw new Error(
            `mirror gate ${gameId}/${tier.id}/${cell}/${profile}: score() ${published} != mirror ${mean(mirrorScores)}`
          );
        }
        mirrorChecks += 1;
      }
    }

    // Fill profile values from raw, uniformly (reuse rows recomputed against
    // the committed baseline file, so one r applies to every row).
    for (const [, v] of cellScores) {
      v.profiles = /** @type {Record<string, number | null>} */ (
        profileScores(v.raw, tier, r)
      );
    }

    /** @type {Record<string, Record<string, *>>} */
    const cells = {};
    for (const cell of CELL_KINDS) {
      if (sources[cell] === 'missing') continue;
      cells[cell] = {};
      for (const profile of PROFILES) {
        const values = seeds
          .map((s) => cellScores.get(`${cell}|${s}`)?.profiles[profile])
          .filter((x) => typeof x === 'number');
        if (values.length === 0) {
          cells[cell][profile] = { n: 0, mean: null, sd: null, ci95: null };
          continue;
        }
        const [lo, hi] = bootstrapCi95(/** @type {number[]} */ (values), `tier-audit/${gameId}/${tier.id}/${cell}/${profile}`);
        cells[cell][profile] = {
          n: values.length,
          mean: round6(mean(/** @type {number[]} */ (values))),
          sd: round6(sampleSd(/** @type {number[]} */ (values))),
          ci95: [round6(lo), round6(hi)],
        };
      }
    }

    // Exploitability: a no-skill strategy beats the random cell with a paired
    // bootstrap CI whose lower bound clears zero.
    /** @type {Record<string, { ci95: [number, number], mean: number } | null>} */
    const exploitableBy = { 'copy-example': null, 'first-legal': null };
    if (cells['dial-1']) {
      for (const strat of ['copy-example', 'first-legal']) {
        if (!cells[strat]) continue;
        const diffs = seeds
          .map((s) => {
            const a = cellScores.get(`${strat}|${s}`)?.raw;
            const b = cellScores.get(`dial-1|${s}`)?.raw;
            return a === undefined || b === undefined ? null : a - b;
          })
          .filter((x) => x !== null);
        if (diffs.length === 0) continue;
        const [lo, hi] = bootstrapCi95(/** @type {number[]} */ (diffs), `tier-audit/${gameId}/${tier.id}/${strat}/exploit`);
        exploitableBy[strat] = { ci95: [round6(lo), round6(hi)], mean: round6(mean(/** @type {number[]} */ (diffs))) };
      }
    }

    // Seed requirements: paired dial-0 vs dial-0.5 and dial-0.5 vs dial-1
    // gaps under rhae-v1.
    /** @type {Record<string, *>} */
    const power = {};
    if (cells['dial-0'] && cells['dial-05'] && cells['dial-05']['rhae-v1'].n > 0) {
      const dA = seeds
        .map((s) => pairDiff(cellScores, `dial-0|${s}`, `dial-05|${s}`))
        .filter((x) => x !== null);
      if (dA.length >= 2) power['p0vs05'] = summarize(dA, `tier-audit/${gameId}/${tier.id}/p0vs05`);
    }
    if (cells['dial-05'] && cells['dial-1'] && cells['dial-1']['rhae-v1'].n > 0) {
      const dB = seeds
        .map((s) => pairDiff(cellScores, `dial-05|${s}`, `dial-1|${s}`))
        .filter((x) => x !== null);
      if (dB.length >= 2) power['p05vs1'] = summarize(dB, `tier-audit/${gameId}/${tier.id}/p05vs1`);
    }

    const needs = /** @type {number[]} */ (
      Object.values(power)
        .map((p) => p.seedsNeeded)
        .filter((x) => typeof x === 'number')
    );
    const resolves = needs.length === 0 ? null : Math.min(...needs) <= 12;

    /** @type {string[]} */
    const flags = [];
    const zeroRaw = seeds.map((s) => cellScores.get(`dial-0|${s}`)?.raw ?? null);
    if (cells['dial-0'] && zeroRaw.length > 0 && zeroRaw.every((x) => x === 0)) flags.push('floor');
    if (cells['dial-0']?.['rhae-v1'].ci95 && cells['dial-1']?.['rhae-v1'].ci95) {
      if (cells['dial-0']['rhae-v1'].ci95[0] <= cells['dial-1']['rhae-v1'].ci95[1]) flags.push('luck-dominated');
    }
    for (const strat of ['copy-example', 'first-legal']) {
      if (exploitableBy[strat] && exploitableBy[strat].ci95[0] > 0) flags.push(`exploitable-by-${strat}`);
    }
    if (resolves === true) flags.push('resolves-at-12-or-fewer');
    if (resolves === false) flags.push('does-not-resolve-at-64');

    rows.push({
      game: gameId,
      tier: tier.id,
      gameVersion: game.spec.version,
      scoring: tier.scoring,
      seedsPlanned: seeds.length,
      exampleToken: example?.token ?? null,
      exampleSource: example ? example.source : 'none',
      chanceBaselineMean: r === null ? null : round6(r),
      cellSources: sources,
      cells,
      exploitableBy,
      power,
      flags,
    });
  }
}

/**
 * Paired raw-score difference between two cells on one seed.
 *
 * @param {Map<string, { raw: number }>} cellScores
 * @param {string} a
 * @param {string} b
 * @returns {number | null}
 */
function pairDiff(cellScores, a, b) {
  const x = cellScores.get(a)?.raw;
  const y = cellScores.get(b)?.raw;
  return x === undefined || y === undefined ? null : x - y;
}

/**
 * @param {number[]} diffs
 * @param {string} seed
 */
function summarize(diffs, seed) {
  const { needed, powerAt12 } = seedsNeeded(diffs, seed);
  return {
    diffMean: round6(mean(diffs)),
    seedsNeeded: needed,
    powerAt12: round6(powerAt12),
  };
}

/** @type {*[]} */
const usable = rows.filter((row) => !row.flags.includes('floor') && !row.flags.includes('luck-dominated'));
/** @type {*[]} */
const flagged = rows.filter((row) => row.flags.some((f) => f === 'floor' || f === 'luck-dominated' || f.startsWith('exploitable')));

const tiers = {
  format: 'playkit-gauntlet-tier-audit/1',
  profiles: PROFILES,
  primary: 'rhae-v1',
  counts: { games: Object.keys(GAMES).length, tiers: rows.length, usable: usable.length, flagged: flagged.length },
  mirrorChecks,
  rows,
};

await writeFile(join(root, 'tiers.json'), JSON.stringify(tiers, null, 2) + '\n');
await writeFile(join(root, 'report-data.json'), JSON.stringify({ tiers: tiers.counts, usableRows: usable.map((r) => `${r.game}/${r.tier}`), flaggedRows: flagged.map((r) => ({ key: `${r.game}/${r.tier}`, flags: r.flags })) }, null, 2) + '\n');

console.log(`tiers: ${rows.length} rows, ${usable.length} usable, ${flagged.length} flagged; mirror checks ${mirrorChecks}`);
for (const row of flagged) console.log(`  flagged ${row.game}/${row.tier}: ${row.flags.join(', ')}`);
