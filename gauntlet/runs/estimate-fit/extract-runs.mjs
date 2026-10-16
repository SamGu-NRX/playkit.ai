/**
 * Extract per-episode and per-call cost data from committed real-model run
 * bundles, for the estimator fit (`fit.mjs`).
 *
 * Every trajectory is replayed against the CURRENT game specs (leniently: a
 * step whose replayed observation hash matches the recorded hash contributes
 * its reconstructed official-prompt size; after the first mismatch the replay
 * state is treated as diverged and prompt sizes stop, while the provider's
 * recorded per-call token usage is kept for every step regardless — usage is
 * ground truth, not a replay artifact).
 *
 * Data sources (in-tree by default; extra bundle directories, such as a
 * read-only materialization of `gauntlet/studies/leak-recheck/runs/` from
 * `origin/obv/burst10-playkit-leak-recheck`, are passed as CLI args):
 *
 *   reports/first-model-run/run-qwen      Qwen2.5-1.5B, 42 episodes, 12 games
 *   reports/board-v2/runs/run-qwen        Qwen2.5-1.5B, 49 episodes, 13 games
 *   studies/model-separation/runs/qwen2.5-{0.5b,1.5b,7b,7b-part2}
 *
 * Usage:
 *
 *   node runs/estimate-fit/extract-runs.mjs [--out runs-data.json] [extra-dir ...]
 *
 * Deterministic: no timestamps or machine-specific fields in the output.
 *
 * @module
 */

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { listGames } from '../../games/index.js';
import { hashObservation } from '../../core/canonical.js';
import { judgeReply } from '../../core/runner.js';
import { OFFICIAL_SYSTEM_PROMPT, buildOfficialTurnMessage } from '../../harness/official.js';

export const DATA_FORMAT = 'playkit-gauntlet-estimate-fit-data/1';

const GAUNTLET_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');

/** Default in-tree bundles, with the model each bundle's agent is. */
export const DEFAULT_SOURCES = [
  { label: 'first-model-run', dir: 'reports/first-model-run/run-qwen' },
  { label: 'board-v2', dir: 'reports/board-v2/runs/run-qwen' },
  { label: 'model-separation-0.5b', dir: 'studies/model-separation/runs/qwen2.5-0.5b' },
  { label: 'model-separation-1.5b', dir: 'studies/model-separation/runs/qwen2.5-1.5b' },
  { label: 'model-separation-7b', dir: 'studies/model-separation/runs/qwen2.5-7b' },
  { label: 'model-separation-7b-part2', dir: 'studies/model-separation/runs/qwen2.5-7b-part2' },
];

/**
 * Qwen size label from a trajectory's agent id, or the full id when unknown.
 *
 * @param {string} agentId
 * @returns {string}
 */
export function modelOf(agentId) {
  const m = /qwen2\.5-(0\.5b|1\.5b|7b)-/.exec(agentId);
  return m ? `qwen${m[1]}` : agentId;
}

/**
 * Trajectory files in a bundle: `<game>/<tier>/<game>/<tier>/<split>/<seed>.json`.
 *
 * @param {string} bundleDir
 * @returns {string[]}
 */
function trajectoryFiles(bundleDir) {
  /** @type {string[]} */
  const files = [];
  const walk = (/** @type {string} */ dir, /** @type {number} */ depth) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) walk(p, depth + 1);
      else if (entry.isFile() && entry.name.endsWith('.json') && depth >= 5) files.push(p);
    }
  };
  walk(bundleDir, 0);
  return files.filter((f) => {
    try {
      return JSON.parse(readFileSync(f, 'utf8')).format === 'playkit-gauntlet-trajectory/1';
    } catch {
      return false;
    }
  });
}

/**
 * Replay one trajectory against the current spec and extract cost data.
 *
 * @param {string} sourceLabel
 * @param {Map<string, { game: *, spec: * }>} gamesById
 * @param {*} trajectory
 * @returns {{ ok: true, episode: * } | { ok: false, reason: string }}
 */
export function extractEpisode(sourceLabel, gamesById, trajectory) {
  const entry = gamesById.get(trajectory.game.id);
  if (!entry) return { ok: false, reason: `unknown game ${trajectory.game.id}` };
  const game = entry.game;
  const spec = game.spec;
  const tier = spec.tiers.find((/** @type {any} */ t) => t.id === trajectory.tier);
  if (!tier) return { ok: false, reason: `game ${spec.id} has no tier ${trajectory.tier}` };

  const agentId = trajectory.agent?.id ?? 'unknown';
  let state;
  try {
    state = game.reset(tier, trajectory.seed);
  } catch (err) {
    return { ok: false, reason: `reset threw: ${err instanceof Error ? err.message : String(err)}` };
  }

  /** @type {number[][]} */
  /** @type {Array<Array<number | null>>} */
  const steps = [];
  /** @type {Array<number | null> | null} */
  let pendingUsage = null;
  let agentTurn = 0;
  let previousReply = null;
  let feedback = null;
  let diverged = false;
  let hashValidSteps = 0;
  let agentSteps = 0;

  for (let i = 0; i < trajectory.steps.length; i++) {
    const step = trajectory.steps[i];

    // Usage is recorded by the provider during the run — ground truth that
    // never depends on the replay. Collect it for every agent step, even
    // after the replay diverges.
    if (step.by === 'agent') {
      agentSteps += 1;
      const usage = step.usage ?? step.reply?.usage ?? null;
      const inTok = usage && Number.isFinite(Number(usage.inputTokens)) ? Number(usage.inputTokens) : null;
      const outTok = usage && Number.isFinite(Number(usage.outputTokens)) ? Number(usage.outputTokens) : null;
      pendingUsage = [inTok, outTok, step.invalid ? 1 : 0];
    } else {
      pendingUsage = null;
    }

    if (diverged) {
      // State is no longer trustworthy; only the usage above is still kept.
      if (pendingUsage) steps.push([...pendingUsage, null]);
      pendingUsage = null;
      continue;
    }

    let seat;
    try {
      seat = game.toAct(state);
    } catch {
      seat = null;
    }
    if (seat === null || step.seat !== seat) {
      diverged = true;
      if (pendingUsage) steps.push([...pendingUsage, null]);
      pendingUsage = null;
      continue;
    }
    let observation = null;
    let legalActions = [];
    try {
      observation = game.observe(state, seat);
      legalActions = /** @type {string[]} */ (game.legalActions(state, seat));
    } catch {
      diverged = true;
      if (pendingUsage) steps.push([...pendingUsage, null]);
      pendingUsage = null;
      continue;
    }
    let hashOk = false;
    try {
      hashOk = hashObservation(observation) === step.observationHash;
    } catch {
      hashOk = false;
    }
    if (!hashOk) diverged = true;

    if (step.by === 'agent') {
      if (hashOk) hashValidSteps += 1;
      let promptChars = null;
      if (hashOk) {
        try {
          const message = buildOfficialTurnMessage(
            { spec, tier, seat, turn: agentTurn, observation, legalActions: null, feedback },
            previousReply
          );
          promptChars = OFFICIAL_SYSTEM_PROMPT.length + message.length;
        } catch {
          promptChars = null;
        }
      }
      steps.push([.../** @type {Array<number | null>} */ (pendingUsage), promptChars]);
      agentTurn += 1;
      const replyText = step.reply && typeof step.reply.text === 'string' ? step.reply.text : '';
      const decision = judgeReply(game, state, seat, legalActions, replyText);
      feedback = decision.invalid ? decision.reason : null;
      previousReply = replyText.length > 0 ? replyText : null;
    }
    pendingUsage = null;

    if (diverged) continue;
    if (!step.invalid) {
      try {
        state = game.step(state, seat, step.action);
      } catch {
        diverged = true;
      }
    }
  }

  return {
    ok: true,
    episode: {
      source: sourceLabel,
      model: modelOf(agentId),
      agent: agentId,
      game: spec.id,
      gameVersionRun: trajectory.game.version,
      gameVersionCurrent: spec.version,
      tier: tier.id,
      seed: trajectory.seed,
      endReason: trajectory.end.reason,
      agentActions: trajectory.end.agentActions,
      invalidActions: trajectory.end.invalidActions,
      maxActions: tier.maxActions,
      agentSteps,
      hashValidSteps,
      replayDiverged: diverged,
      // Per agent call: [inputTokens|null, outputTokens|null, invalid, promptChars|null]
      steps,
    },
  };
}

/**
 * Extract all bundles.
 *
 * @param {{ label: string, dir: string }[]} sources
 * @returns {{ format: string, sources: *, episodes: *, skipped: * }}
 */
export function extractAll(sources) {
  const gamesById = new Map(listGames().map((g) => [g.spec.id, { game: g, spec: g.spec }]));
  /** @type {any[]} */
  const episodes = [];
  /** @type {any[]} */
  const skipped = [];
  for (const source of sources) {
    const dir = resolve(GAUNTLET_ROOT, source.dir);
    let files;
    try {
      files = trajectoryFiles(dir);
    } catch {
      skipped.push({ source: source.label, dir: source.dir, reason: 'directory not readable' });
      continue;
    }
    let kept = 0;
    for (const file of files) {
      let trajectory;
      try {
        trajectory = JSON.parse(readFileSync(file, 'utf8'));
      } catch {
        skipped.push({ source: source.label, dir: source.dir, file, reason: 'unparseable JSON' });
        continue;
      }
      const result = extractEpisode(source.label, gamesById, trajectory);
      if (result.ok) {
        episodes.push(result.episode);
        kept += 1;
      } else {
        skipped.push({ source: source.label, dir: source.dir, file, reason: result.reason });
      }
    }
    if (kept === 0) skipped.push({ source: source.label, dir: source.dir, reason: 'no trajectories extracted' });
  }
  episodes.sort((a, b) =>
    a.source.localeCompare(b.source) ||
    a.game.localeCompare(b.game) ||
    a.tier.localeCompare(b.tier) ||
    a.seed.localeCompare(b.seed)
  );
  return {
    format: DATA_FORMAT,
    sources: sources.map((s) => s.label),
    episodes,
    skipped,
  };
}

// CLI entry: node runs/estimate-fit/extract-runs.mjs [--out FILE] [extra-dir ...]
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const args = process.argv.slice(2);
  let outFile = null;
  const extraDirs = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--out') outFile = args[++i];
    // `dir=LABEL` names the source; a bare path gets a generic label.
    else if (args[i].includes('=')) {
      const eq = args[i].indexOf('=');
      extraDirs.push({ label: args[i].slice(eq + 1), dir: resolve(args[i].slice(0, eq)) });
    } else extraDirs.push({ label: `extra-${extraDirs.length}`, dir: resolve(args[i]) });
  }
  const sources = [...DEFAULT_SOURCES, ...extraDirs];
  const data = extractAll(sources);
  const target = outFile ?? join(GAUNTLET_ROOT, 'runs/estimate-fit/runs-data.json');
  writeFileSync(target, JSON.stringify(data, null, 1) + '\n');
  const agentSteps = data.episodes.reduce((/** @type {number} */ a, /** @type {any} */ e) => a + e.agentSteps, 0);
  const hashOk = data.episodes.reduce((/** @type {number} */ a, /** @type {any} */ e) => a + e.hashValidSteps, 0);
  console.log(
    `episodes ${data.episodes.length}, agent calls ${agentSteps}, hash-verified calls ${hashOk} (${((100 * hashOk) / Math.max(1, agentSteps)).toFixed(1)}%), skipped ${data.skipped.length}`
  );
  for (const s of data.skipped) console.log(`  skipped: ${s.source}${s.reason ? ` — ${s.reason}` : ''}`);
}
