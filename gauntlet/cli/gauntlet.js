#!/usr/bin/env node
/**
 * The Gauntlet CLI. Lives under `cli/` because the root .gitignore ignores
 * `bin/`, `build/`, `dist/`, `results/`, `logs/` and `*.dat` everywhere.
 *
 * Commands:
 *   list                                   List registered games and tiers.
 *   replay <file> [--step N] [--format text|json] [--max-reply-chars K]
 *                                          Show a recorded episode turn by turn
 *                                          in the terminal. Delegates to the
 *                                          standalone viewer in replay/cli.js
 *                                          (same arguments, same exit codes:
 *                                          2 on usage errors, 1 when the
 *                                          trajectory is refused by replay
 *                                          verification).
 *   play --game <id> --tier <id> [--seed <s>] [--agent <spec>]
 *        [--split <split>] [--out <file>] [--max-invalid <n>]
 *        [--prices <file>] [--dry-run --script <file>]
 *                                          Run one episode, print a summary
 *                                          (with a per-call usage and cost
 *                                          line for model agents), optionally
 *                                          write the trajectory.
 *   verify <file-or-dir>                   Replay-verify a trajectory file or
 *                                          every trajectory in a directory.
 *                                          --episode-time-limit-ms <ms> (on
 *                                          `play` too) caps one episode's
 *                                          wall clock the same way.
 *   suite build --split public|eval [--salt-file <file>]
 *        [--seeds-per-tier <n>] [--games <id,id>] [--out <file>]
 *                                          Write (or print) a suite manifest.
 *   run --suite <file> --agent <spec> --out <dir> [--limit <n>]
 *        [--concurrency <n>] [--max-usd <usd>] [--max-calls <n>]
 *        [--requests-per-minute <n>] [--max-output-tokens <n>]
 *        [--call-timeout-ms <ms>] [--episode-time-limit-ms <ms>]
 *        [--thinking-budget <n>]
 *        [--reasoning-effort <low|medium|high|xhigh|max>] [--prices <file>]
 *        [--dry-run --script <file>]
 *                                          Run the agent over the manifest.
 *                                          --episode-time-limit-ms <ms> caps
 *                                          each episode's wall clock: when it
 *                                          passes, the episode ends with a
 *                                          time-limit trajectory that scores
 *                                          like a forfeit and still replays.
 *                                          Recorded in run.json's limits.
 *   page --agent <spec> --out <dir> [--base-url <url>] [--api-key-env <var>]
 *        [--moves <n>] [--seed <s>] [--timeout-ms <ms>]
 *                                          Attach the agent to the vendored
 *                                          2048 page through the overlay's
 *                                          own injection path, one move at a
 *                                          time under the bridge referee, and
 *                                          write page/<seed>.json (a
 *                                          refereed bridge-session log) plus
 *                                          page/run.json (provenance and
 *                                          turn accounting) into the bundle;
 *                                          `verify <dir>` and `bundle verify`
 *                                          replay it. Exit status is non-zero
 *                                          when the referee flags a move.
 *                                          Needs Playwright from the nested
 *                                          gauntlet/bridge/browser package.
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
 *   --help, -h                             Print this usage on stdout, exit 0.
 *
 * Agent specs:
 *   random                          The bundled seeded random agent (baseline).
 *   baseline:<game>:<greedy|engine> A game packet's bundled baseline; a suite
 *                                   run with this spec covers that game only.
 *                                   Every registered game resolves its
 *                                   baselines: packets whose games/<id>/baselines.js
 *                                   exports createGreedyAgent/createEngineAgent
 *                                   ({ episodeSeed }) need no CLI entry; the
 *                                   explicit table in cli/agents.js covers
 *                                   packets whose factory signature differs.
 *   skill:<p>:<expert-spec>         The skill dial (agents/skill-dial.js): the
 *                                   expert degraded toward random play by a
 *                                   per-turn probability p in [0, 1];
 *                                   <expert-spec> is "random" or any baseline
 *                                   spec, e.g. skill:0.25:baseline:sokoban:
 *                                   engine. The trajectory records the dial's
 *                                   own id, dial-<expert id>-p<p*100>.
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
 *                                   the worst-case cost quote.
 *                                   --reasoning-effort <low|medium|high|xhigh|max>
 *                                   sets reasoning effort for every provider
 *                                   (openai sends reasoning.effort;
 *                                   openai-chat sends it as reasoning_effort,
 *                                   which is how Google's Gemini
 *                                   OpenAI-compatible endpoint takes it; the
 *                                   anthropic pairing is validated per model
 *                                   by harness/model-agent.js).
 *                                   Settings are recorded in run.json's limits
 *                                   and in the agent's leaderboard label, and
 *                                   can also be written inline on the spec as a
 *                                   trailing :thinking-budget=<n> or
 *                                   :reasoning-effort=<low|medium|high|xhigh|max>.
 *
 * Node-only: imports `node:*` freely.
 * @module
 */

import { writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
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
import { runPageSubcommand } from './page.js';
import { parseAgentSpec } from './agents.js';

const USAGE_TEXT = [
  'usage: gauntlet list',
  '       gauntlet play --game <id> --tier <id> [--seed <seed>] [--agent <spec>]',
  '                      [--split <split>] [--out <file>] [--max-invalid <n>]',
  '                      [--episode-time-limit-ms <ms>] [--prices <file>] [--dry-run --script <file>]',
  '       gauntlet verify <trajectory.json-or-dir>',
  '       gauntlet replay <trajectory.json> [--step N] [--format text|json]',
  '                      [--max-reply-chars K]',
  '       gauntlet suite build --split public|eval [--salt-file <file>]',
  '                      [--seeds-per-tier <n>] [--games <id,id>] [--out <file>]',
  '       gauntlet run --suite <file> --agent <spec> --out <dir> [--limit <n>]',
  '                      [--max-invalid <n>] [--concurrency <n>] [--max-usd <usd>] [--max-calls <n>]',
  '                      [--requests-per-minute <n>] [--max-output-tokens <n>]',
  '                      [--call-timeout-ms <ms>] [--episode-time-limit-ms <ms>] [--thinking-budget <n>] [--reasoning-effort low|medium|high|xhigh|max]',
  '                      [--prices <file>] [--dry-run --script <file>]',
  '       gauntlet estimate --suite <file> --agent <spec> [--prices <file>] [--out <dir>]',
  '                         [--no-probes] [--against <runDir>] [--json]',
  '       gauntlet page --agent <spec> --out <dir> [--base-url <url>] [--api-key-env <var>]',
  '                      [--moves <n>] [--seed <s>] [--timeout-ms <ms>]',
  '       gauntlet leaderboard --suite <file> [--out <dir>] [--scoring-profile rhae-v1] [--json] <dirs...>',
  '       gauntlet rate <dirs...> [--ladder <file>] [--json]',
  '       gauntlet serve',
  '',
  'agent specs: random | baseline:<game>:<greedy|engine> | skill:<p>:<expert-spec>',
  '             | model:<provider>/<model>',
  '',
  '  skill:<p>:<expert-spec> — the skill dial over "random" or a baseline spec',
  '',
  '  --help, -h              print this usage on stdout and exit 0',
].join('\n') + '\n';

/**
 * Print the usage text. `--help` sends it to stdout and exits 0; argument
 * errors send it to stderr and exit 2.
 *
 * @param {import('node:net').Socket | { write: (s: string) => void }} stream
 * @returns {void}
 */
function printUsage(stream) {
  stream.write(USAGE_TEXT);
}

/**
 * Exits the process; typed `never` so guards narrow after it.
 *
 * @returns {never}
 */
function usage() {
  printUsage(process.stderr);
  process.exit(2);
}

/**
 * Flag grammar per command: the flags each command takes, which of them are
 * boolean, and how many positionals it accepts. `replay` is absent — it
 * delegates raw argv to replay/cli.js, which owns its own grammar.
 *
 * @typedef {object} CommandFlags
 * @property {string} label
 * @property {string[]} flags
 * @property {ReadonlySet<string>} booleans
 * @property {number | 'any'} positionals
 */

/** @type {Record<string, CommandFlags>} */
const COMMAND_FLAGS = {
  list: { label: 'gauntlet list', flags: [], booleans: new Set(), positionals: 0 },
  play: {
    label: 'gauntlet play',
    flags: [
      'agent', 'api-key-env', 'base-url', 'call-timeout-ms', 'dry-run',
      'episode-time-limit-ms', 'game',
      'max-invalid', 'max-output-tokens', 'out', 'prices', 'reasoning-effort',
      'script', 'seed', 'split', 'thinking-budget', 'tier',
    ],
    booleans: new Set(['dry-run']),
    positionals: 0,
  },
  verify: { label: 'gauntlet verify', flags: [], booleans: new Set(), positionals: 1 },
  suite: {
    label: 'gauntlet suite build',
    flags: ['games', 'out', 'salt-file', 'seeds-per-tier', 'split'],
    booleans: new Set(),
    positionals: 1,
  },
  estimate: {
    label: 'gauntlet estimate',
    flags: ['against', 'agent', 'json', 'no-probes', 'out', 'prices', 'suite'],
    booleans: new Set(['json', 'no-probes']),
    positionals: 0,
  },
  run: {
    label: 'gauntlet run',
    flags: [
      'agent', 'api-key-env', 'base-url', 'call-timeout-ms', 'concurrency',
      'dry-run', 'episode-time-limit-ms', 'limit', 'max-calls', 'max-invalid',
      'max-output-tokens',
      'max-usd', 'out', 'prices', 'reasoning-effort', 'requests-per-minute',
      'resume', 'script', 'suite', 'thinking-budget',
    ],
    booleans: new Set(['dry-run', 'resume']),
    positionals: 0,
  },
  // Only the flags cli/page.js reads; it ignores --thinking-budget and
  // --reasoning-effort, so accepting them would silently drop them.
  page: {
    label: 'gauntlet page',
    flags: [
      'agent', 'api-key-env', 'base-url', 'call-timeout-ms', 'dry-run',
      'max-output-tokens', 'moves', 'out', 'prices', 'script', 'seed',
      'timeout-ms', 'url-path',
    ],
    booleans: new Set(['dry-run']),
    positionals: 0,
  },
  bundle: { label: 'gauntlet bundle verify', flags: ['json'], booleans: new Set(['json']), positionals: 2 },
  leaderboard: {
    label: 'gauntlet leaderboard',
    flags: ['json', 'out', 'scoring-profile', 'suite'],
    booleans: new Set(['json']),
    positionals: 'any',
  },
  rate: { label: 'gauntlet rate', flags: ['json', 'ladder'], booleans: new Set(['json']), positionals: 'any' },
  serve: { label: 'gauntlet serve', flags: [], booleans: new Set(), positionals: 0 },
};

/**
 * @typedef {object} ParsedArgs
 * @property {string[]} positionals
 * @property {Map<string, string>} flags
 */

/**
 * Parse argv into positionals and flags against the command's grammar.
 * `--key=value`, `--key value`, and bare `--key` (boolean, stored as "true").
 * A declared boolean never consumes the next token — `--dry-run model:...`
 * leaves the spec where the researcher put it instead of eating it — and a
 * declared value-taking flag requires one. An unknown flag fails naming the
 * flags the command takes, and a command that takes no positionals refuses
 * them (pointing at --agent when the stray positional looks like an agent
 * spec).
 *
 * @param {string[]} argv
 * @param {CommandFlags | null} commandSpec Null skips validation (the replay
 *   delegate owns its own grammar).
 * @returns {ParsedArgs}
 */
function parseArgs(argv, commandSpec) {
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
    const eq = arg.indexOf('=');
    const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    if (commandSpec && !commandSpec.flags.includes(name)) {
      throw new Error(
        `unknown flag "--${name}" for ${commandSpec.label}; flags it takes: ${
          commandSpec.flags.map((f) => `--${f}`).join(', ') || '(none)'
        }`
      );
    }
    if (eq !== -1) {
      flags.set(name, arg.slice(eq + 1));
      continue;
    }
    if (commandSpec && commandSpec.booleans.has(name)) {
      flags.set(name, 'true');
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) {
      if (commandSpec) {
        throw new Error(`--${name} requires a value (${commandSpec.label} --${name} <value>)`);
      }
      flags.set(name, 'true');
    } else {
      flags.set(name, value);
      i++;
    }
  }
  if (
    commandSpec &&
    commandSpec.positionals !== 'any' &&
    positionals.length > commandSpec.positionals
  ) {
    const stray = positionals[commandSpec.positionals];
    const hint = /^(random|baseline:|skill:|model:)/.test(stray)
      ? ' — an agent spec goes in --agent <spec>, not a positional'
      : '';
    throw new Error(
      `unexpected positional ${JSON.stringify(stray)} for ${commandSpec.label}${hint}`
    );
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
 * @returns {{ dryRun: boolean, prices?: string, script?: string, baseUrl?: string, apiKeyEnv?: string, maxOutputTokens?: number, callTimeoutMs?: number, thinkingBudget?: number, reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max' }}
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
 * Validate an explicit --reasoning-effort value; the provider and model
 * pairing is validated per model by the harness (harness/model-agent.js).
 *
 * @param {string} raw
 * @returns {'low' | 'medium' | 'high' | 'xhigh' | 'max'}
 */
function validateReasoningEffort(raw) {
  if (raw !== 'low' && raw !== 'medium' && raw !== 'high' && raw !== 'xhigh' && raw !== 'max') {
    throw new Error(
      `--reasoning-effort must be low, medium, high, xhigh or max, got ${JSON.stringify(raw)}`
    );
  }
  return raw;
}

/**
 * The play summary's usage line for model agents: provider calls, reported
 * input/output token totals, the priced cost, and the mean per-call latency —
 * counted over the agent's provider-call steps only (the bundled opponent's
 * steps carry no usage and are not calls).
 * Any unmeasured or unpriced step renders its figure as `unknown` — never a
 * partial sum, and never $0 masquerading as measured. Baselines and dry-run
 * rehearsals record no usage, so the line is absent for them.
 *
 * @param {*} trajectory
 * @returns {string | null} The formatted line, or null when nothing was measured.
 */
function usageSummaryLine(trajectory) {
  const steps = /** @type {Array<{ usage?: { inputTokens: number | null, outputTokens: number | null, costUsd: number | null } | null, ms: number }> | undefined} */ (
    trajectory?.steps
  );
  // A dry run replays scripted replies and records no provider usage; its
  // output stays as it always was, without a usage line.
  if (trajectory?.agent?.dryRun) {
    return null;
  }
  // Only the agent's provider calls carry usage; the bundled opponent's steps
  // (random or baseline) have none and are not calls.
  const callSteps = (steps ?? []).filter((s) => s.usage);
  if (callSteps.length === 0) {
    return null;
  }
  const calls = callSteps.length;
  const tokensUnknown = callSteps.some(
    (s) => !s.usage || s.usage.inputTokens === null || s.usage.outputTokens === null
  );
  const inTokens = tokensUnknown
    ? null
    : callSteps.reduce((sum, s) => sum + (/** @type {*} */ (s.usage).inputTokens ?? 0), 0);
  const outTokens = tokensUnknown
    ? null
    : callSteps.reduce((sum, s) => sum + (/** @type {*} */ (s.usage).outputTokens ?? 0), 0);
  const costUnknown = callSteps.some((s) => !s.usage || s.usage.costUsd === null);
  const costUsd = costUnknown
    ? null
    : callSteps.reduce((sum, s) => sum + (/** @type {*} */ (s.usage).costUsd ?? 0), 0);
  const meanMs = callSteps.reduce((sum, s) => sum + s.ms, 0) / calls;
  const latency =
    meanMs >= 1000 ? `${(meanMs / 1000).toFixed(2)} s/call` : `${Math.max(1, Math.round(meanMs))} ms/call`;
  const tokens =
    inTokens === null || outTokens === null
      ? 'tokens unknown'
      : `${inTokens.toLocaleString('en-US')} in / ${outTokens.toLocaleString('en-US')} out tok`;
  const cost =
    costUsd === null
      ? 'cost unknown'
      : `$${costUsd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 })}`;
  return `usage    ${calls} ${calls === 1 ? 'call' : 'calls'} · ${tokens} · ${cost} · ${latency}`;
}

// A closed pipe (e.g. `gauntlet list | head`) must not crash the process.
process.stdout?.on?.('error', () => {});

/**
 * @param {string[]} argv
 * @returns {Promise<void>}
 */
async function main(argv) {
  const [command, ...rest] = argv;
  if (command === 'help' || argv.includes('--help') || argv.includes('-h')) {
    // Help goes to stdout and exits 0; argument errors keep stderr and exit 2.
    printUsage(process.stdout);
    return;
  }
  const commandSpec = command === 'replay' ? null : (COMMAND_FLAGS[command ?? ''] ?? null);
  const { positionals, flags } = parseArgs(rest, commandSpec);

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
    const episodeTimeLimit = flags.has('episode-time-limit-ms')
      ? numberFlag(flags, 'episode-time-limit-ms')
      : undefined;
    const trajectory = await runEpisode({
      game,
      tierId: tier.id,
      seed,
      split,
      agent,
      ...(maxInvalid !== undefined ? { maxConsecutiveInvalid: maxInvalid } : {}),
      ...(episodeTimeLimit !== undefined ? { episodeTimeLimitMs: episodeTimeLimit } : {}),
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
    const usageLine = usageSummaryLine(trajectory);
    process.stdout.write(
      [
        `game     ${trajectory.game.id}/${trajectory.tier}`,
        `seed     ${trajectory.seed} (${trajectory.split})`,
        `agent    ${trajectory.agent.id} at seat ${trajectory.agent.seat} (track ${trajectory.agent.track}${trajectory.agent.dryRun ? ', dry run' : ''})`,
        `end      ${trajectory.end.reason} after ${trajectory.end.agentActions} agent actions (${trajectory.end.invalidActions} invalid)`,
        `outcome  ${normalized} — ${outcome.reason}`,
        ...(usageLine ? [usageLine] : []),
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

  if (command === 'page') {
    const agentSpecText = flags.get('agent');
    const outDir = flags.get('out');
    if (!agentSpecText || !outDir) usage();
    const result = await runPageSubcommand({
      agentSpecText: /** @type {string} */ (agentSpecText),
      outDir: /** @type {string} */ (outDir),
      ...(flags.has('moves') ? { maxMoves: numberFlag(flags, 'moves') } : {}),
      ...(flags.has('seed') ? { seed: numberFlag(flags, 'seed') } : {}),
      ...(flags.has('timeout-ms') ? { timeoutMs: numberFlag(flags, 'timeout-ms') } : {}),
      ...(flags.has('url-path') ? { urlPath: /** @type {string} */ (flags.get('url-path')) } : {}),
      ...modelFlags(flags),
    });
    // A referee-flagged move fails the command: the bundle is written for the
    // audit, but the exit status says the session did not verify.
    if (!result.verified.ok) process.exitCode = 1;
    return;
  }

  if (command === 'replay') {
    // Delegate to the standalone viewer (replay/cli.js): one implementation,
    // the same argument grammar, and the same exit codes (2 usage, 1 refused
    // by replay verification). The raw arguments pass through untouched —
    // parseArgs ran without validation, and the viewer owns its grammar.
    const viewer = fileURLToPath(new URL('../replay/cli.js', import.meta.url));
    const result = spawnSync(process.execPath, [viewer, ...rest], {
      stdio: 'inherit',
    });
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
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
    const modelOpts = modelFlags(flags);
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
        ...(flags.has('episode-time-limit-ms')
          ? { episodeTimeLimitMs: numberFlag(flags, 'episode-time-limit-ms') }
          : {}),
        ...(flags.has('resume') ? { resume: true } : {}),
        signal: controller.signal,
        ...modelOpts,
        ...(modelOpts.reasoningEffort !== undefined
          ? {
              // run.js's reasoningEffort typedef narrows until the
              // frontier-effort packet widens it; the wider value flows
              // through and the harness validates per model.
              reasoningEffort: /** @type {'low' | 'medium' | 'high'} */ (modelOpts.reasoningEffort),
            }
          : {}),
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
