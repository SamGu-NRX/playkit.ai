#!/usr/bin/env node
/**
 * The Gauntlet CLI. Lives under `cli/` because the root .gitignore ignores
 * `bin/`, `build/`, `dist/`, `results/`, `logs/` and `*.dat` everywhere.
 *
 * Commands:
 *   list                                   List registered games and tiers.
 *   play --game <id> --tier <id> [--seed <s>] [--agent random]
 *        [--split <split>] [--out <file>] [--max-invalid <n>]
 *                                          Run one episode, print a summary,
 *                                          optionally write the trajectory.
 *   verify <file>                          Replay-verify a trajectory file.
 *
 * Node-only: imports `node:*` freely.
 * @module
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { getGame, listGames } from '../games/index.js';
import { runEpisode } from '../core/runner.js';
import { verifyTrajectory } from '../core/trajectory.js';
import { createRandomAgent } from '../agents/random.js';
import { publicSeed } from '../core/seeds.js';

/**
 * @returns {void}
 */
function usage() {
  process.stderr.write(
    [
      'usage: gauntlet list',
      '       gauntlet play --game <id> --tier <id> [--seed <seed>] [--agent random]',
      '                      [--split <split>] [--out <file>] [--max-invalid <n>]',
      '       gauntlet verify <trajectory.json>',
    ].join('\n') + '\n'
  );
  process.exit(2);
}

/**
 * @param {string[]} argv
 * @returns {Map<string, string>}
 */
function parseFlags(argv) {
  /** @type {Map<string, string>} */
  const flags = new Map();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) usage();
    if (arg.includes('=')) {
      const eq = arg.indexOf('=');
      flags.set(arg.slice(2, eq), arg.slice(eq + 1));
    } else {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) usage();
      flags.set(arg.slice(2), value);
      i++;
    }
  }
  return flags;
}

/**
 * @returns {void}
 */
function main() {
  const [command, ...rest] = process.argv.slice(2);

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
    const flags = parseFlags(rest);
    const gameId = flags.get('game');
    const tierId = flags.get('tier');
    if (!gameId || !tierId) usage();
    const agentName = flags.get('agent') ?? 'random';
    if (agentName !== 'random') {
      throw new Error(`unknown agent "${agentName}"; the bundled agent is "random"`);
    }
    const game = getGame(/** @type {string} */ (gameId));
    const seed = flags.get('seed') ?? publicSeed(game.spec.id, /** @type {string} */ (tierId), 0);
    const split = flags.get('split') ?? 'public';
    const maxInvalid = flags.has('max-invalid')
      ? Number(flags.get('max-invalid'))
      : undefined;
    const agent = createRandomAgent({ episodeSeed: seed });
    runEpisode({
      game,
      tierId: /** @type {string} */ (tierId),
      seed,
      split,
      agent,
      ...(maxInvalid !== undefined ? { maxConsecutiveInvalid: maxInvalid } : {}),
    }).then((trajectory) => {
      const out = flags.get('out');
      if (out) {
        writeFileSync(out, JSON.stringify(trajectory, null, 2) + '\n');
      }
      const outcome = trajectory.end.outcome;
      if (!outcome) throw new Error('the episode ended without an outcome');
      const normalized = outcome.normalized
        .map((/** @type {number} */ score, /** @type {number} */ seat) => `seat${seat}=${score.toFixed(3)}`)
        .join(' ');
      process.stdout.write(
        [
          `game     ${trajectory.game.id}/${trajectory.tier}`,
          `seed     ${trajectory.seed} (${trajectory.split})`,
          `agent    ${trajectory.agent.id} at seat ${trajectory.agent.seat} (track ${trajectory.agent.track})`,
          `end      ${trajectory.end.reason} after ${trajectory.end.agentActions} agent actions (${trajectory.end.invalidActions} invalid)`,
          `outcome  ${normalized} — ${outcome.reason}`,
          ...(out ? [`saved    ${out}`] : []),
        ].join('\n') + '\n'
      );
      process.exitCode = 0;
    });
    return;
  }

  if (command === 'verify') {
    if (rest.length !== 1) usage();
    const raw = JSON.parse(readFileSync(rest[0], 'utf8'));
    const gameId = raw && raw.game && raw.game.id;
    if (typeof gameId !== 'string') {
      throw new Error('not a gauntlet trajectory: missing game.id');
    }
    const game = getGame(gameId);
    verifyTrajectory(game, raw).then((result) => {
      if (result.ok) {
        process.stdout.write(
          `ok: ${gameId}/${raw.tier} seed ${raw.seed} replays cleanly (${raw.steps.length} steps, end ${raw.end.reason})\n`
        );
      } else {
        process.stderr.write(
          `FAIL: step ${result.step}: ${result.reason}\n`
        );
        process.exitCode = 1;
      }
    });
    return;
  }

  usage();
}

try {
  main();
} catch (err) {
  process.stderr.write(
    `error: ${err instanceof Error ? err.message : String(err)}\n`
  );
  process.exitCode = 1;
}
