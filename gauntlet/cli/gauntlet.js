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
 *        [--max-invalid <n>] [--prices <file>] [--dry-run --script <file>]
 *                                          Run the agent over the manifest.
 *   leaderboard --suite <file> [--out <dir>] [--json] <dirs...>
 *                                          Score run directories, render JSON
 *                                          and Markdown through gauntlet/scoring.
 *   serve                                  Serve the JSON-Lines wire protocol
 *                                          on stdin/stdout (protocol/server.js).
 *
 * Agent specs:
 *   random                          The bundled seeded random agent (baseline).
 *   baseline:<game>:<greedy|engine> A game packet's bundled baseline; a suite
 *                                   run with this spec covers that game only.
 *   model:<provider>/<model>        An official-track model agent (provider
 *                                   anthropic or openai). Live runs need the
 *                                   provider API key in the environment and
 *                                   --prices for cost accounting; --dry-run
 *                                   with --script <file> replays replies.
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
import { runSuite } from './run.js';
import { verifyPath } from './verify.js';
import { buildLeaderboard } from './leaderboard.js';
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
      '                      [--max-invalid <n>] [--prices <file>] [--dry-run --script <file>]',
      '       gauntlet leaderboard --suite <file> [--out <dir>] [--json] <dirs...>',
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
 * @param {Map<string, string>} flags
 * @returns {{ dryRun: boolean, prices?: string, script?: string }}
 */
function modelFlags(flags) {
  return {
    dryRun: flags.has('dry-run'),
    ...(flags.has('prices') ? { prices: /** @type {string} */ (flags.get('prices')) } : {}),
    ...(flags.has('script') ? { script: /** @type {string} */ (flags.get('script')) } : {}),
  };
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

  if (command === 'run') {
    const suitePath = flags.get('suite');
    const agentSpecText = flags.get('agent');
    const outDir = flags.get('out');
    if (!suitePath || !agentSpecText || !outDir) usage();
    await runSuite({
      suitePath,
      agentSpecText,
      outDir,
      ...(flags.has('limit') ? { limit: numberFlag(flags, 'limit') } : {}),
      ...(flags.has('max-invalid') ? { maxInvalid: numberFlag(flags, 'max-invalid') } : {}),
      ...modelFlags(flags),
    });
    return;
  }

  if (command === 'leaderboard') {
    const suitePath = flags.get('suite');
    if (!suitePath || positionals.length === 0) usage();
    await buildLeaderboard({
      suitePath,
      dirs: positionals,
      ...(flags.has('out') ? { outDir: /** @type {string} */ (flags.get('out')) } : {}),
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
