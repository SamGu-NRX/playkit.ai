/**
 * Score the versus model-separation study's episode bundles through the
 * scoring layer and emit the study's committed data files.
 *
 *   node score-study.mjs --runs <dir-with-one-subdir-per-model> [--out .]
 *
 * For every model the script builds one four-tier suite manifest (both study
 * games with exactly their two study tiers), so each score() call is ranked
 * with the scorer's own 10k-draw seeded bootstrap CI per tier. Every model is
 * scored under all three profiles (`rhae-v1`, `squared-outcome`,
 * `chance-adjusted`); efficiency tiers are unchanged by profile, per
 * `scoring/profiles.js`. All four tiers here are outcome tiers.
 *
 * Baseline: the committed `scoring/baselines/random-public.json` on alpha
 * does not carry the wave-11 versus tiers at all (byte check: none of
 * tictactoe/random-opponent, tictactoe/blunder-opponent, connect4/ladder-1,
 * connect4/ladder-0 appears in it), so chance-adjusted is scored against the
 * study-local `baseline-random.json` in this directory, built with
 * `node scoring/generate-baseline.js --out=<this dir>/baseline-random.json`
 * exactly as the pinned method prescribes. The raw (rhae-v1, squared-outcome)
 * scores do not use any baseline.
 *
 * Every profile mean is cross-checked against an independent mirror of the
 * episode rules (`rawEpisodeScore` + the profile transforms): if round6(mirror
 * mean) differs from score()'s published value for any group, the script
 * exits non-zero rather than publish.
 *
 * Output (written next to this script unless --out):
 *   profile-results.json  { format, baseline, groups[] } — score() values,
 *                         bootstrap CIs, refusal records, mirror means
 *   episodes.json         per-episode records: raw score, profile scores,
 *                         invalid counts, calls, wall ms, tokens
 *
 * @module
 */

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { score } from '../../../scoring/score.js';
import { SCORING_PROFILES } from '../../../scoring/profiles.js';
import { loadBaselineFile } from '../../../scoring/baselines.js';
import { buildSuite } from '../../../scoring/suite.js';
import { GAMES } from '../../../games/index.js';

const here = dirname(fileURLToPath(import.meta.url));

/** The pinned model ladder: file stems under --runs, in size order. */
export const MODELS = [
  { stem: 'qwen2.5-0.5b-instruct-q4_k_m', label: '0.5B', paramsB: 0.5 },
  { stem: 'qwen2.5-1.5b-instruct-q4_k_m', label: '1.5B', paramsB: 1.5 },
  { stem: 'qwen2.5-7b-instruct-q4_k_m', label: '7B', paramsB: 7 },
];

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

/**
 * Raw episode score e — the mirror of score.js's `episodeScore` pre-profile
 * rules. All four study tiers are outcome tiers: e = outcome.normalized[seat].
 *
 * @param {*} tier
 * @param {*} trajectory
 * @returns {{ e: number, agentActions: number }}
 */
export function rawEpisodeScore(tier, trajectory) {
  const outcome = trajectory.end?.outcome ?? null;
  const seat = trajectory.agent.seat;
  if (tier.scoring !== 'outcome') {
    throw new Error(`tier ${tier.id} is not an outcome tier; this study scores outcome tiers only`);
  }
  const value = outcome?.normalized?.[seat];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${trajectory.game?.id ?? '?'}/${tier.id}/${trajectory.seed}: no finite normalized[${seat}]`);
  }
  return { e: value, agentActions: trajectory.end.agentActions };
}

/** Round to 6 decimals, exactly like score.js does before publishing. */
export function round6(v) {
  return v === null ? null : Math.round(v * 1e6) / 1e6;
}

/**
 * One suite manifest per model: both study games with exactly their two study
 * tiers at their natural consecutive ranks. score() refuses a suite with no
 * benchmark game, and tictactoe is deliberately `benchmark: false` game-wide
 * (its header says so: it exists to exercise the contract, not to rank
 * agents); connect4 carries the benchmark flag, and every tier in this suite
 * is actually played, so the gate passes on real data and each tier still
 * gets its own mean and seeded bootstrap CI from the same call.
 *
 * @param {string} modelStem
 */
export function modelSuite(modelStem) {
  const games = [
    ['tictactoe', ['random-opponent', 'blunder-opponent']],
    ['connect4', ['ladder-1', 'ladder-0']],
  ].map(([gameId, tierIds]) => {
    const game = /** @type {*} */ (GAMES[gameId]);
    const tiers = tierIds.map((tierId) => {
      const tier = game.spec.tiers.find((/** @type {*} */ t) => t.id === tierId);
      if (!tier) throw new Error(`unknown tier ${gameId}/${tierId}`);
      return { ...tier };
    });
    return { ...game, spec: { ...game.spec, tiers } };
  });
  return buildSuite(games, { split: 'public', id: `model-separation-v2-versus-${modelStem}` });
}

/** Trajectory files of one model run bundle, recursively under <runs>/<stem>. */
export function trajectoryFiles(runsDir, stem) {
  const root = join(runsDir, stem);
  /** @type {string[]} */
  const out = [];
  /** @param {string} dir */
  const walk = (dir) => {
    for (const name of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, name.name);
      if (name.isDirectory()) walk(p);
      else if (name.name.endsWith('.json') && !name.name.startsWith('run') && name.name !== 'suite.json') out.push(p);
    }
  };
  walk(root);
  return out.sort();
}

/**
 * Run the scorer end to end. Invoked as a module main; also exported so the
 * study's tests can drive it against fixture bundles.
 */
export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const baseline = loadBaselineFile(resolve(here, 'baseline-random.json'));

  // Phase 1: per-episode records with the mirror's raw + profile scores.
  /** @type {Map<string, { trajectories: any[], mirror: any[], errors: any[], isOutcome: boolean, model: any, gameId: string, tierId: string }>} */
  const grouped = new Map();
  const episodes = [];
  for (const model of MODELS) {
    let files;
    try {
      files = trajectoryFiles(args.runs, model.stem);
    } catch {
      process.stdout.write(`note: no run directory for ${model.stem}, skipping\n`);
      continue;
    }
    for (const file of files) {
      const record = JSON.parse(readFileSync(file, 'utf8'));
      const gameId = record.game?.id;
      const tierId = typeof record.tier === 'string' ? record.tier : record.tier?.id;
      if (!gameId || !tierId) throw new Error(`${file}: cannot read game/tier ids`);
      const game = /** @type {*} */ (GAMES[gameId]);
      const tier = game.spec.tiers.find((/** @type {*} */ t) => t.id === tierId);
      const key = `${model.stem}|${gameId}|${tierId}`;
      if (!grouped.has(key)) {
        grouped.set(key, { trajectories: [], mirror: [], errors: [], isOutcome: tier.scoring === 'outcome', model, gameId, tierId });
      }
      const group = grouped.get(key);
      const agentSteps = (record.steps ?? []).filter((/** @type {*} */ s) => s.by === 'agent');
      const usage = agentSteps.filter((/** @type {*} */ s) => s.usage).map((/** @type {*} */ s) => s.usage);
      const seed = record.seed;
      if (record.error !== undefined) {
        episodes.push({
          model: model.label, game: gameId, tier: tierId, seed, error: record.error,
          raw: null, invalidCalls: null, calls: null, secPerCall: null, tokensPerCall: null,
          profiles: null,
        });
        group.errors.push(record.error);
        continue;
      }
      const raw = rawEpisodeScore(tier, record);
      const chanceMirror = raw.e; // replaced below once r is known
      const invalidCalls = agentSteps.filter((/** @type {*} */ s) => s.invalid).length;
      const ms = agentSteps.reduce((/** @type {number} */ a, /** @type {*} */ s) => a + (s.ms || 0), 0);
      const tok = usage.reduce(
        (/** @type {number} */ a, /** @type {*} */ u) =>
          a + (u.promptTokens || u.inputTokens || 0) + (u.completionTokens || u.outputTokens || 0),
        0,
      );
      episodes.push({
        model: model.label,
        game: gameId,
        tier: tierId,
        seed,
        error: null,
        raw: round6(raw.e),
        agentActions: raw.agentActions,
        invalidCalls,
        calls: agentSteps.length,
        secPerCall: round6(ms / 1000 / Math.max(1, agentSteps.length)),
        tokensPerCall: round6(tok / Math.max(1, agentSteps.length)),
        // Profile values filled after r is known (chance-adjusted needs r).
        profiles: {
          'rhae-v1': round6(raw.e),
          'squared-outcome': round6(raw.e * raw.e),
          'chance-adjusted': round6(chanceMirror),
        },
        profilesExact: {
          'rhae-v1': raw.e,
          'squared-outcome': raw.e * raw.e,
          'chance-adjusted': chanceMirror,
        },
        _file: file,
      });
      group.trajectories.push(record);
      group.mirror.push(episodes[episodes.length - 1].profilesExact);
    }
  }

  // Fill the chance-adjusted mirror values from the study-local baseline.
  for (const episode of episodes) {
    if (episode.error !== null || !episode.profiles) continue;
    const r = baseline.baseline.games?.[episode.game]?.tiers?.[episode.tier]?.mean;
    if (typeof r !== 'number') throw new Error(`study-local baseline has no mean for ${episode.game}/${episode.tier}`);
    episode.profiles['chance-adjusted'] = round6(Math.max(0, (episode.profilesExact['rhae-v1'] - r) / (1 - r)));
    episode.profilesExact['chance-adjusted'] = Math.max(0, (episode.profilesExact['rhae-v1'] - r) / (1 - r));
    episode.r = r;
  }
  for (const episode of episodes) {
    delete episode._file;
  }

  // Phase 2: score() once per (model, profile) over that model's four-tier
  // suite, reading each tier's own mean and seeded bootstrap CI from the entry.
  const byModel = new Map();
  for (const [key, group] of grouped) {
    const stem = key.split('|')[0];
    if (!byModel.has(stem)) byModel.set(stem, { model: group.model, tiers: [], trajectories: [] });
    const entry0 = /** @type {*} */ (byModel.get(stem));
    entry0.tiers.push(group);
    entry0.trajectories.push(...group.trajectories);
  }
  const groups = [];
  let disagreements = 0;
  for (const [stem, modelEntry] of byModel) {
    const suite = modelSuite(stem);
    /** @type {Map<string, { entry: any, refusal: any }>} */
    const perProfile = new Map();
    for (const profile of SCORING_PROFILES) {
      try {
        const scored = await score(suite, modelEntry.trajectories, GAMES, {
          profile,
          ...(profile === 'chance-adjusted' ? { baseline: baseline.baseline, baselineSha256: baseline.sha256 } : {}),
        });
        perProfile.set(profile, { entry: scored, refusal: null });
      } catch (err) {
        perProfile.set(profile, {
          entry: null,
          refusal: { code: /** @type {*} */ (err)?.code ?? 'unknown', message: err instanceof Error ? err.message : String(err) },
        });
      }
    }
    for (const group of modelEntry.tiers) {
      const seeds = [...new Set(group.trajectories.map((/** @type {*} */ t) => t.seed))].sort();
      const result = {
        model: group.model.label,
        game: group.gameId,
        tier: group.tierId,
        scoring: group.isOutcome ? 'outcome' : 'efficiency',
        seeds,
        nScored: group.trajectories.length,
        nErrors: group.errors.length,
        errorMessages: [...new Set(group.errors)],
        ranked: true,
        unrankedReason: group.trajectories.length === 0 ? 'no error-free episodes' : null,
        scores: {},
        mirrorMean: {},
      };
      for (const profile of SCORING_PROFILES) {
        const { entry, refusal } = /** @type {*} */ (perProfile.get(profile));
        let value = null;
        let ci = null;
        if (entry) {
          const tierScore = entry.games[group.gameId].tiers[group.tierId].score;
          value = tierScore.value;
          ci = tierScore.ci95;
          result.ranked = result.ranked && entry.ranked;
          result.unrankedReason = result.unrankedReason ?? entry.unrankedReason;
        }
        result.scores[profile] = { value, ci95: ci, refusal };
        const mirrorScores = group.mirror.map((/** @type {*} */ m) => m[profile]).filter((/** @type {*} */ v) => v !== null);
        const mirrorMean = mirrorScores.length ? mirrorScores.reduce((a, b) => a + b, 0) / mirrorScores.length : null;
        result.mirrorMean[profile] = mirrorMean === null ? null : round6(mirrorMean);
        if (value !== null && mirrorMean !== null && round6(mirrorMean) !== value) {
          disagreements++;
          process.stderr.write(
            `MIRROR MISMATCH ${group.gameId}/${group.tierId} ${group.model.label} ${profile}: score()=${value} mirror=${round6(mirrorMean)}\n`,
          );
        }
      }
      groups.push(result);
    }
  }

  groups.sort((a, b) => a.game.localeCompare(b.game) || a.tier.localeCompare(b.tier) || a.model.localeCompare(b.model));
  episodes.sort((a, b) => a.game.localeCompare(b.game) || a.tier.localeCompare(b.tier) || a.model.localeCompare(b.model) || String(a.seed).localeCompare(String(b.seed)));

  if (disagreements > 0) {
    process.stderr.write(`${disagreements} mirror disagreements; refusing to publish\n`);
    process.exit(2);
  }

  const payload = {
    format: 'playkit-gauntlet-study-model-separation-v2-versus-profile-results/1',
    baseline: { agent: baseline.baseline.agent, sha256: baseline.sha256, path: 'studies/model-separation-v2/versus/baseline-random.json' },
    groups,
  };
  writeFileSync(join(args.out, 'profile-results.json'), JSON.stringify(payload, null, 1) + '\n');
  const cleanEpisodes = episodes.map(({ profilesExact, ...rest }) => rest);
  writeFileSync(join(args.out, 'episodes.json'), JSON.stringify(cleanEpisodes, null, 1) + '\n');
  const scored = groups.filter((/** @type {*} */ r) => r.scores['rhae-v1'].value !== null).length;
  process.stdout.write(
    `profile-results: ${groups.length} groups (${scored} scored), episodes: ${episodes.length} (${episodes.filter((e) => e.error).length} errors); mirror agrees everywhere\n`,
  );
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  await main();
}
