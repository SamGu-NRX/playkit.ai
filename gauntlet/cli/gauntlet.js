#!/usr/bin/env node
/**
 * The Gauntlet CLI. Lives under `cli/` because the root .gitignore ignores
 * `bin/`, `build/`, `dist/`, `results/`, `logs/` and `*.dat` everywhere.
 *
 * Commands:
 *   list                                   List registered games and tiers.
 *   play --game <id> --tier <id> [--seed <s>] [--agent <spec>]
 *        [--split <split>] [--out <file>] [--max-invalid <n>]
 *        [--prices <file>] [--dry-run --script <file>]
 *                                          Run one episode, print a summary,
 *                                          optionally write the trajectory.
 *   verify <file-or-dir>                   Replay-verify a trajectory file or
 *                                          every trajectory in a directory.
 *   suite build --split public|eval [--salt-file <file>]
 *        [--seeds-per-tier <n>] [--games <id,id>] [--out <file>]
 *                                          Write (or print) a suite manifest.
 *   run --suite <file> --agent <spec> --out <dir> [--limit <n>]
 *        [--concurrency <n>] [--max-usd <usd>] [--max-calls <n>]
 *        [--requests-per-minute <n>] [--max-output-tokens <n>]
 *        [--call-timeout-ms <ms>] [--thinking-budget <n>]
 *        [--reasoning-effort <low|medium|high>] [--prices <file>]
 *        [--dry-run --script <file>]
 *                                          Run the agent over the manifest.
 *   leaderboard --suite <file> [--out <dir>] [--scoring-profile <name>]
 *        [--json] <dirs...>
 *                                          Score run directories, render JSON
 *                                          and Markdown through gauntlet/scoring.
 *                                          --scoring-profile is one of rhae-v1
 *                                          (default), chance-adjusted,
 *                                          squared-outcome.
 *   rate <dirs...> [--ladder <file>] [--json]
 *                                          Elo-rate chess trajectories against
 *                                          the ladder fitted by rating/ladder.js;
 *                                          off-ladder trajectories are skipped
 *                                          and reported per agent.
 *   serve                                  Serve the JSON-Lines wire protocol
 *                                          on stdin/stdout (protocol/server.js).
 *
 * Agent specs:
 *   random                          The bundled seeded random agent (baseline).
 *   baseline:<game>:<greedy|engine> A game packet's bundled baseline; a suite
 *                                   run with this spec covers that game only.
 *   model:<provider>/<model>        An official-track model agent (provider
 *                                   anthropic, openai or openai-chat).
 *                                   openai-chat speaks any OpenAI-compatible
 *                                   chat-completions server and requires
 *                                   --base-url <url>; every provider reads its
 *                                   key from the environment variable named by
 *                                   --api-key-env <VAR> (read at call time,
 *                                   never logged). Live runs need --prices for
 *                                   cost accounting; --dry-run with
 *                                   --script <file> replays replies.
 *                                   --max-output-tokens <n> caps each reply's
 *                                   output tokens and --call-timeout-ms <ms>
 *                                   bounds each attempt (a timed-out attempt
 *                                   retries like any transport error); both
 *                                   are recorded in run.json's limits.
 *                                   --thinking-budget <n> turns on Anthropic
 *                                   extended thinking with budget_tokens <n>
 *                                   (provider anthropic only); it rides on top
 *                                   of the reply's output cap and is part of
 *                                   the worst-case cost quote. --reasoning-effort
 *                                   <low|medium|high> sets OpenAI reasoning
 *                                   effort (provider openai; provider
 *                                   openai-chat sends it as reasoning_effort,
 *                                   which is how Google's Gemini
 *                                   OpenAI-compatible endpoint takes it).
 *                                   Settings are recorded in run.json's limits
 *                                   and in the agent's leaderboard label, and
 *                                   can also be written inline on the spec as a
 *                                   trailing :thinking-budget=<n> or
 *                                   :reasoning-effort=<low|medium|high>.
 *
 * Node-only: imports `node:*` freely.
 * @module
 */

import { writeFileSync } from 'node:fs';
import { getGame, listGames } from '../games/index.js';
import { runEpisode, findTier } from '../core/runner.js';
import { publicSeed } from '../core/seeds.js';
import { serve } from '../protocol/server.js';
import { buildSuiteManifest } from './suite.js';
import { runSuite, printRunSummary } from './run.js';
import { verifyPath } from './verify.js';
import { buildLeaderboard } from './leaderboard.js';
import { rateRunDirs } from './rate.js';
import { resolveProfile } from '../scoring/profiles.js';
import { buildEstimate } from './estimate.js';
import { printBundleVerify } from './bundle.js';
import { parseAgentSpec } from './agents.js';

/**
 * Exits the process; typed `never` so guards narrow after it.
 *
 * @returns {never}
 */
function usage() {
  process.stderr.write(
    [
      'usage: gauntlet list',
      '       gauntlet play --game <id> --tier <id> [--seed <seed>] [--agent <spec>]',
      '                      [--split <split>] [--out <file>] [--max-invalid <n>]',
      '                      [--prices <file>] [--dry-run --script <file>]',
      '       gauntlet verify <trajectory.json-or-dir>',
      '       gauntlet suite build --split public|eval [--salt-file <file>]',
      '                      [--seeds-per-tier <n>] [--games <id,id>] [--out <file>]',
      '       gauntlet run --suite <file> --agent <spec> --out <dir> [--limit <n>]',
      '                      [--max-invalid <n>] [--concurrency <n>] [--max-usd <usd>] [--max-calls <n>]',
      '                      [--requests-per-minute <n>] [--max-output-tokens <n>]',
      '                      [--call-timeout-ms <ms>] [--thinking-budget <n>] [--reasoning-effort low|medium|high]',
      '                      [--prices <file>] [--dry-run --script <file>]',
      '       gauntlet estimate --suite <file> --agent <spec> [--prices <file>] [--out <dir>]',
      '                         [--no-probes] [--against <runDir>] [--json]',
      '       gauntlet leaderboard --suite <file> [--out <dir>] [--scoring-profile rhae-v1] [--json] <dirs...>',
      '       gauntlet rate <dirs...> [--ladder <file>] [--json]',
      '       gauntlet serve',
      '',
      'agent specs: random | baseline:<game>:<greedy|engine> | model:<provider>/<model>',
    ].join('\n') + '\n'
  );
  process.exit(2);
}

/**
 * @typedef {object} ParsedArgs
 * @property {string[]} positionals
 * @property {Map<string, string>} flags
 */

/**
 * `--key=value`, `--key value`, and bare `--key` (boolean, stored as "true").
 *
 * @param {string[]} argv
 * @returns {ParsedArgs}
 */
function parseArgs(argv) {
  /** @type {string[]} */
  const positionals = [];
  /** @type {Map<string, string>} */
  const flags = new Map();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      positionals.push(arg);
      continue;
    }
    if (arg.includes('=')) {
      const eq = arg.indexOf('=');
      flags.set(arg.slice(2, eq), arg.slice(eq + 1));
    } else {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        flags.set(arg.slice(2), 'true');
      } else {
        flags.set(arg.slice(2), value);
        i++;
      }
    }
  }
  return { positionals, flags };
}

/**
 * @param {Map<string, string>} flags
 * @param {string} name
 * @returns {number | undefined}
 */
function numberFlag(flags, name) {
  const raw = flags.get(name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`--${name} must be a non-negative integer, got ${JSON.stringify(raw)}`);
  }
  return value;
}

/**
 * Like numberFlag but accepts any finite non-negative number — for caps that
 * are naturally fractional (`--max-usd`) or rates (`--requests-per-minute`).
 *
 * @param {Map<string, string>} flags
 * @param {string} name
 * @returns {number | undefined}
 */
function finiteNumberFlag(flags, name) {
  const raw = flags.get(name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`--${name} must be a finite non-negative number, got ${JSON.stringify(raw)}`);
  }
  return value;
}

/**
 * @param {Map<string, string>} flags
 * @returns {{ dryRun: boolean, prices?: string, script?: string, baseUrl?: string, apiKeyEnv?: string, maxOutputTokens?: number, callTimeoutMs?: number, thinkingBudget?: number, reasoningEffort?: 'low' | 'medium' | 'high' }}
 */
function modelFlags(flags) {
  return {
    dryRun: flags.has('dry-run'),
    ...(flags.has('prices') ? { prices: /** @type {string} */ (flags.get('prices')) } : {}),
    ...(flags.has('script') ? { script: /** @type {string} */ (flags.get('script')) } : {}),
    ...(flags.has('base-url') ? { baseUrl: /** @type {string} */ (flags.get('base-url')) } : {}),
    ...(flags.has('api-key-env') ? { apiKeyEnv: /** @type {string} */ (flags.get('api-key-env')) } : {}),
    ...(flags.has('max-output-tokens')
      ? { maxOutputTokens: numberFlag(flags, 'max-output-tokens') }
      : {}),
    ...(flags.has('call-timeout-ms')
      ? { callTimeoutMs: numberFlag(flags, 'call-timeout-ms') }
      : {}),
    ...(flags.has('thinking-budget')
      ? { thinkingBudget: numberFlag(flags, 'thinking-budget') }
      : {}),
    ...(flags.has('reasoning-effort')
      ? {
          reasoningEffort: validateReasoningEffort(
            /** @type {string} */ (flags.get('reasoning-effort'))
          ),
        }
      : {}),
  };
}

/**
 * Validate an explicit --reasoning-effort value; the provider pairing is
 * checked where the spec is parsed (cli/agents.js).
 *
 * @param {string} raw
 * @returns {'low' | 'medium' | 'high'}
 */
function validateReasoningEffort(raw) {
  if (raw !== 'low' && raw !== 'medium' && raw !== 'high') {
    throw new Error(`--reasoning-effort must be low, medium or high, got ${JSON.stringify(raw)}`);
  }
  return raw;
}

// A closed pipe (e.g. `gauntlet list | head`) must not crash the process.
process.stdout?.on?.('error', () => {});

/**
 * @param {string[]} argv
 * @returns {Promise<void>}
 */
async function main(argv) {
  const [command, ...rest] = argv;
  const { positionals, flags } = parseArgs(rest);

  if (command === 'list') {
    for (const game of listGames()) {
      process.stdout.write(`${game.spec.id} v${game.spec.version} — ${game.spec.title}\n`);
      for (const tier of game.spec.tiers) {
        process.stdout.write(
          `  ${tier.id}  rank ${tier.rank}  scoring=${tier.scoring}  maxActions=${tier.maxActions}  publicSeeds=${tier.publicSeeds}${game.spec.benchmark ? '' : '  (smoke game, not benchmarked)'}\n`
        );
      }
    }
    return;
  }

  if (command === 'play') {
    const gameId = flags.get('game');
    const tierId = flags.get('tier');
    if (!gameId || !tierId) usage();
    const game = getGame(/** @type {string} */ (gameId));
    const tier = findTier(game, /** @type {string} */ (tierId));
    const seed = flags.get('seed') ?? publicSeed(game.spec.id, tier.id, 0);
    const split = flags.get('split') ?? 'public';
    const spec = await parseAgentSpec(flags.get('agent') ?? 'random', modelFlags(flags));
    const agentSeat = typeof game.agentSeat === 'function' ? game.agentSeat(tier, seed) : 0;
    const agent = await spec.createForEpisode({ game, tier, seed, agentSeat });
    const maxInvalid = numberFlag(flags, 'max-invalid');
    const trajectory = await runEpisode({
      game,
      tierId: tier.id,
      seed,
      split,
      agent,
      ...(maxInvalid !== undefined ? { maxConsecutiveInvalid: maxInvalid } : {}),
    });
    const out = flags.get('out');
    if (out) {
      writeFileSync(out, JSON.stringify(trajectory, null, 2) + '\n');
    }
    const outcome = trajectory.end.outcome;
    if (!outcome) throw new Error('the episode ended without an outcome');
    const normalized = outcome.normalized
      .map((score, seat) => `seat${seat}=${score.toFixed(3)}`)
      .join(' ');
    process.stdout.write(
      [
        `game     ${trajectory.game.id}/${trajectory.tier}`,
        `seed     ${trajectory.seed} (${trajectory.split})`,
        `agent    ${trajectory.agent.id} at seat ${trajectory.agent.seat} (track ${trajectory.agent.track}${trajectory.agent.dryRun ? ', dry run' : ''})`,
        `end      ${trajectory.end.reason} after ${trajectory.end.agentActions} agent actions (${trajectory.end.invalidActions} invalid)`,
        `outcome  ${normalized} — ${outcome.reason}`,
        ...(out ? [`saved    ${out}`] : []),
      ].join('\n') + '\n'
    );
    return;
  }

  if (command === 'verify') {
    if (positionals.length !== 1) usage();
    const report = await verifyPath(positionals[0]);
    if (report.failures.length > 0) process.exitCode = 1;
    return;
  }

  if (command === 'suite' && positionals[0] === 'build') {
    const gamesFlag = flags.get('games');
    const manifest = buildSuiteManifest({
      split: /** @type {'public' | 'eval'} */ (flags.get('split')),
      ...(flags.has('salt-file') ? { saltFile: /** @type {string} */ (flags.get('salt-file')) } : {}),
      ...(flags.has('seeds-per-tier') ? { seedsPerTier: numberFlag(flags, 'seeds-per-tier') } : {}),
      ...(gamesFlag ? { gameIds: gamesFlag.split(',') } : {}),
    });
    const json = JSON.stringify(manifest, null, 2) + '\n';
    const out = flags.get('out');
    if (out) {
      writeFileSync(out, json);
      process.stdout.write(`wrote ${out} — ${manifest.games.length} games, split ${manifest.split}\n`);
    } else {
      process.stdout.write(json);
    }
    return;
  }

  if (command === 'estimate') {
    const suitePath = flags.get('suite');
    const agentSpecText = flags.get('agent');
    if (!suitePath || !agentSpecText) usage();
    await buildEstimate({
      suitePath,
      agentSpecText,
      ...(flags.has('prices') ? { prices: /** @type {string} */ (flags.get('prices')) } : {}),
      ...(flags.has('out') ? { outDir: /** @type {string} */ (flags.get('out')) } : {}),
      ...(flags.has('no-probes') ? { noProbes: true } : {}),
      ...(flags.has('against') ? { against: /** @type {string} */ (flags.get('against')) } : {}),
      ...(flags.has('json') ? { json: true } : {}),
    });
    return;
  }

  if (command === 'run') {
    const suitePath = flags.get('suite');
    const agentSpecText = flags.get('agent');
    const outDir = flags.get('out');
    if (!suitePath || !agentSpecText || !outDir) usage();
    if (flags.has('max-invalid')) {
      throw new Error(
        '--max-invalid applies to `play`; engine-backed `run` uses the runner\'s default invalid-action policy'
      );
    }
    // A signalled run (SIGINT/SIGTERM) stops after the calls in flight and
    // still writes its run.json provenance record, so the bundle stays
    // resumable; only the in-flight episodes are lost.
    const controller = new AbortController();
    if (flags.has('max-usd') && !flags.has('prices')) {
      console.error(
        'error: --max-usd requires --prices (a spend cap needs the price table to convert calls into dollars); pass --prices <file.json>'
      );
      process.exitCode = 1;
      return;
    }
    const stop = () => {
      controller.abort();
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    try {
      const result = await runSuite({
        suitePath,
        agentSpecText,
        outDir,
        ...(flags.has('limit') ? { limit: numberFlag(flags, 'limit') } : {}),
        ...(flags.has('concurrency') ? { concurrency: numberFlag(flags, 'concurrency') } : {}),
        ...(flags.has('max-usd') ? { maxUsd: finiteNumberFlag(flags, 'max-usd') } : {}),
        ...(flags.has('max-calls') ? { maxCalls: numberFlag(flags, 'max-calls') } : {}),
        ...(flags.has('requests-per-minute')
          ? { requestsPerMinute: finiteNumberFlag(flags, 'requests-per-minute') }
          : {}),
        ...(flags.has('resume') ? { resume: true } : {}),
        signal: controller.signal,
        ...modelFlags(flags),
      });
      printRunSummary(result);
      if (result.stopped || result.run.counts.failed > 0) {
        process.exitCode = 1;
      }
    } finally {
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
    }
    return;
  }

  if (command === 'bundle' && positionals[0] === 'verify') {
    if (positionals.length !== 2) usage();
    const report = await printBundleVerify({
      outDir: positionals[1],
      ...(flags.has('json') ? { json: true } : {}),
    });
    if (!report.ok) process.exitCode = 1;
    return;
  }

  if (command === 'leaderboard') {
    const suitePath = flags.get('suite');
    if (!suitePath || positionals.length === 0) usage();
    // resolveProfile refuses an unknown name naming the selectable profiles;
    // the catch below prints that and exits 1.
    const profileFlag = flags.get('scoring-profile');
    await buildLeaderboard({
      suitePath,
      dirs: positionals,
      ...(profileFlag !== undefined ? { profile: resolveProfile(profileFlag) } : {}),
      ...(flags.has('out') ? { outDir: /** @type {string} */ (flags.get('out')) } : {}),
      ...(flags.has('json') ? { json: true } : {}),
    });
    return;
  }

  if (command === 'rate') {
    if (positionals.length === 0) usage();
    rateRunDirs({
      dirs: positionals,
      ...(flags.has('ladder') ? { ladderPath: /** @type {string} */ (flags.get('ladder')) } : {}),
      ...(flags.has('json') ? { json: true } : {}),
    });
    return;
  }

  if (command === 'serve') {
    if (positionals.length > 0 || flags.size > 0) usage();
    await serve();
    return;
  }

  usage();
}

try {
  await main(process.argv.slice(2));
} catch (err) {
  process.stderr.write(
    `error: ${err instanceof Error ? err.message : String(err)}\n`
  );
  process.exitCode = 1;
}
