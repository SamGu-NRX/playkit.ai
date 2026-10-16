#!/usr/bin/env node
/**
 * Score the solo skill-dial study's episode bundle through the scoring
 * layer and emit the study's committed data files.
 *
 *   node score-study.mjs --runs /tmp/skill-dial-solo-runs [--out .]
 *
 * For every (game, tier, split) the script builds a single-tier suite
 * manifest covering exactly the seeds that were run, so each score() call is
 * ranked with the scorer's own 10k-draw seeded bootstrap CI. Every group is
 * scored under all three profiles (`rhae-v1`, `squared-outcome`,
 * `chance-adjusted`); efficiency tiers are unchanged by profile, per
 * `scoring/profiles.js`.
 *
 * Known refusal: cube's committed random baseline carries game version 1.0.0
 * while the game is 1.1.0, so `chance-adjusted` refuses cube with code
 * `baseline-version`. The refusal is recorded, not worked around; the study
 * computes an informational study-local-r column for cube separately (in
 * `compute-stats.py`, from the p=1 arm).
 *
 * Every profile mean is cross-checked against an independent mirror of the
 * episode rules (`study-lib.rawEpisodeScore` + the profile transforms): if
 * round6(mirror mean) differs from score()'s published value for any group,
 * the script exits non-zero rather than publish.
 *
 * Output (written next to this script unless --out):
 *   profile-results.json  { format, baseline, groups[] } — score() values,
 *                         bootstrap CIs, refusal records, mirror means
 *
 * The per-episode companion file is `episodes.json`, written by the same run:
 * raw score, solved/par/agentActions, profile scores, and the error flag.
 *
 * @module
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { score } from '../../../scoring/score.js';
import { SCORING_PROFILES } from '../../../scoring/profiles.js';
import { loadBaselineFile } from '../../../scoring/baselines.js';
import { GAMES } from '../../../games/index.js';
import { allJobs, singleTierSuite, rawEpisodeScore, round6 } from './study-lib.mjs';

const here = dirname(fileURLToPath(import.meta.url));

/** Parse the CLI args this script understands. */
function parseArgs(argv) {
  const out = { runs: null, out: here };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--runs') out.runs = resolve(argv[++i]);
    else if (a === '--out') out.out = resolve(argv[++i]);
    else throw new Error(`unknown argument ${a}`);
  }
  if (!out.runs) throw new Error('--runs is required');
  return out;
}

const args = parseArgs(process.argv.slice(2));
const baseline = loadBaselineFile(resolve(here, '../../../scoring/baselines/random-public.json'));
const jobs = allJobs();

// Phase 1: per-episode records with the mirror's raw + profile scores.
const episodes = [];
const grouped = new Map(); // `${game}|${tier}|${split}|${p}` -> { trajectories, mirror, errors }
for (const job of jobs) {
  const record = JSON.parse(readFileSync(join(args.runs, job.file), 'utf8'));
  const game = /** @type {*} */ (GAMES[job.gameId]);
  const tier = game.spec.tiers.find((t) => t.id === job.tierId);
  const key = `${job.gameId}|${job.tierId}|${job.split}|${job.p}`;
  if (!grouped.has(key)) grouped.set(key, { trajectories: [], mirror: [], errors: [], isOutcome: tier.scoring === 'outcome' });
  const group = grouped.get(key);
  if (record.error !== undefined) {
    episodes.push({ game: job.gameId, tier: job.tierId, split: job.split, p: job.p, seed: job.seed, error: record.error });
    group.errors.push(record.error);
    continue;
  }
  const raw = rawEpisodeScore(game, tier, record);
  const isOutcome = tier.scoring === 'outcome';
  const rCanonical = isOutcome
    ? /** @type {number} */ (baseline.baseline.games[job.gameId].tiers[job.tierId].mean)
    : null;
  const chanceMirror =
    !isOutcome || job.gameId === 'cube'
      ? (isOutcome ? null : raw.e) // efficiency tiers are profile-invariant; cube's committed r is refused
      : Math.max(0, (raw.e - rCanonical) / (1 - rCanonical));
  episodes.push({
    game: job.gameId,
    tier: job.tierId,
    split: job.split,
    p: job.p,
    seed: job.seed,
    error: null,
    raw: round6(raw.e),
    solved: raw.solved,
    agentActions: raw.agentActions,
    par: raw.par,
    profiles: {
      'rhae-v1': round6(raw.e),
      'squared-outcome': round6(isOutcome ? raw.e * raw.e : raw.e),
      'chance-adjusted': chanceMirror === null ? null : round6(chanceMirror),
    },
    profilesExact: {
      'rhae-v1': raw.e,
      'squared-outcome': isOutcome ? raw.e * raw.e : raw.e,
      'chance-adjusted': chanceMirror,
    },
  });
  group.trajectories.push(record);
  // The honesty gate compares score()'s published mean against the mean of
  // UNROUNDED per-episode mirror values; averaging the rounded `profiles`
  // would shift last digits by up to 1e-6 and read as a false disagreement.
  group.mirror.push(episodes[episodes.length - 1].profilesExact);
}

// Phase 2: score() per (game, tier, split, p) under each profile.
const groups = [];
let disagreements = 0;
for (const [key, group] of grouped) {
  const [gameId, tierId, split, p] = key.split('|');
  const suite = singleTierSuite(gameId, tierId, /** @type {'public' | 'eval'} */ (split));
  const result = {
    game: gameId,
    tier: tierId,
    split,
    p: Number(p),
    scoring: group.isOutcome ? 'outcome' : 'efficiency',
    nScored: group.trajectories.length,
    nErrors: group.errors.length,
    errorMessages: [...new Set(group.errors)],
    ranked: true,
    unrankedReason: group.trajectories.length === 0 ? 'no error-free episodes' : null,
    scores: {},
    mirrorMean: {},
  };
  if (group.trajectories.length === 0) {
    result.ranked = false;
    for (const profile of SCORING_PROFILES) {
      result.scores[profile] = { value: null, ci95: null, refusal: null };
      result.mirrorMean[profile] = null;
    }
    groups.push(result);
    continue;
  }
  for (const profile of SCORING_PROFILES) {
    let value = null;
    let ci = null;
    let refusal = null;
    if (profile === 'chance-adjusted' && gameId === 'cube') {
      refusal = {
        code: 'baseline-version',
        message:
          'random-public.json carries cube v1.0.0 but the game is v1.1.0; chance-adjusted is version-refused for cube at this commit',
      };
    } else {
      try {
        const entry = await score(suite, group.trajectories, GAMES, {
          profile,
          baseline: baseline.baseline,
          baselineSha256: baseline.sha256,
        });
        const tierScore = entry.games[gameId].tiers[tierId].score;
        value = tierScore.value;
        ci = tierScore.ci95;
        result.ranked = result.ranked && entry.ranked;
        result.unrankedReason = result.unrankedReason ?? entry.unrankedReason;
      } catch (err) {
        refusal = { code: /** @type {*} */ (err)?.code ?? 'unknown', message: err instanceof Error ? err.message : String(err) };
      }
    }
    result.scores[profile] = { value, ci95: ci, refusal };
    const mirrorScores = group.mirror.map((m) => m[profile]).filter((v) => v !== null);
    const mirrorMean = mirrorScores.length ? mirrorScores.reduce((a, b) => a + b, 0) / mirrorScores.length : null;
    result.mirrorMean[profile] = mirrorMean === null ? null : round6(mirrorMean);
    if (value !== null && mirrorMean !== null && round6(mirrorMean) !== value) {
      disagreements++;
      process.stderr.write(
        `MIRROR MISMATCH ${gameId}/${tierId}/${split} p=${p} ${profile}: score()=${value} mirror=${round6(mirrorMean)}\n`
      );
    }
  }
  groups.push(result);
}

groups.sort(
  (a, b) => a.game.localeCompare(b.game) || a.tier.localeCompare(b.tier) || a.split.localeCompare(b.split) || a.p - b.p
);
episodes.sort(
  (a, b) =>
    a.game.localeCompare(b.game) ||
    a.tier.localeCompare(b.tier) ||
    a.split.localeCompare(b.split) ||
    a.p - b.p ||
    a.seed.localeCompare(b.seed)
);

if (disagreements > 0) {
  process.stderr.write(`${disagreements} mirror disagreements; refusing to publish\n`);
  process.exit(2);
}

const payload = {
  format: 'playkit-gauntlet-study-skill-dial-solo-profile-results/1',
  baseline: { agent: baseline.baseline.agent, sha256: baseline.sha256, path: 'scoring/baselines/random-public.json' },
  groups,
};
writeFileSync(join(args.out, 'profile-results.json'), JSON.stringify(payload, null, 1) + '\n');
writeFileSync(join(args.out, 'episodes.json'), JSON.stringify(episodes, null, 1) + '\n');
const scored = groups.filter((r) => r.scores['rhae-v1'].value !== null).length;
const refused = groups.filter((r) => SCORING_PROFILES.some((p) => r.scores[p].refusal)).length;
process.stdout.write(
  `profile-results: ${groups.length} groups (${scored} scored, ${refused} with refusals), ` +
    `episodes: ${episodes.length} (${episodes.filter((e) => e.error).length} errors); mirror agrees everywhere\n`
);
