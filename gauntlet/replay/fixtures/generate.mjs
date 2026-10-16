#!/usr/bin/env node
/**
 * Regenerate the replay fixtures in this directory, deterministically.
 *
 * The replay tests (replay/cli.test.js, replay/frames.test.js) must run green
 * on a clean clone forever, but they used to read recorded trajectories from
 * studies/ and reports/ — data captured from real model runs at older game
 * versions. Whenever a game's version was bumped, replay refused those
 * trajectories (correctly) and the suite went red through no fault of any
 * change. This script replaces that dependency: it records fresh episodes at
 * the CURRENT game versions with a scripted dry-run model agent, so the
 * fixtures are replayable today and the script regenerates them byte-identical
 * after any future version bump.
 *
 * Model-shaped replies: the scripted agent rambles like a model (a long
 * reply on the first turn exercises --max-reply-chars), emits one unparseable
 * guess on mastermind (the INVALID referee verdict), and otherwise gives
 * valid actions derived from the observation the game itself provided.
 *
 * Determinism: every episode is seeded and every opponent is deterministic
 * (tictactoe perfect-opponent is a fixed minimax; mastermind is solitaire),
 * and runEpisode receives a constant `now`, so startedAt/finishedAt and every
 * step's ms are fixed too. Run `node replay/fixtures/generate.mjs` twice and
 * the files do not change.
 *
 * Usage: node replay/fixtures/generate.mjs   (from gauntlet/)
 */

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runEpisode } from '../../core/runner.js';
import { getGame } from '../../games/index.js';
import { createScriptedAgent } from '../../harness/dry-run.js';
import { CELLS } from '../../games/tictactoe/index.js';

const here = dirname(fileURLToPath(import.meta.url));

// Constant clock: runEpisode stamps startedAt/finishedAt from `now()` and
// each step's ms is a difference of two such reads, so pinning `now` pins
// every timestamp in the file.
const FIXED_MS = 0;
const now = () => FIXED_MS;

const SEED = '0';

/**
 * The scripted tictactoe agent: rambles like a model on the first turn, then
 * plays the first free cell in CELLS order — legal by construction, because
 * the free set comes from the observation the game just handed it.
 * @returns {import('../../core/types.js').Agent}
 */
function tictactoeModelAgent() {
  let turn = 0;
  const ramble = 'I should take the centre if it is free, else block along a row. ';
  return createScriptedAgent((/** @type {*} */ ctx) => {
    turn += 1;
    const board = /** @type {*} */ (ctx.observation.data).board;
    const cell = CELLS.find((name) => board[CELLS.indexOf(name)] === null);
    if (!cell) throw new Error('generate.mjs: tictactoe observation has no free cell');
    const text =
      turn === 1
        ? `${ramble.repeat(4)}\n${cell}`
        : `${ramble}\n${cell}`;
    return text;
  }, { id: 'fixture-model' });
}

/**
 * Mastermind model turns: three plausible-looking guesses, then three
 * unparseable ones — the forfeit ladder the replay viewers must show.
 * @param {string[]} guesses
 * @param {string[]} badGuesses
 * @returns {import('../../core/types.js').Agent}
 */
function mastermindModelAgent(guesses, badGuesses) {
  const script = [
    ...guesses.map((g, i) => (i === 0 ? `I will open with ${g}.\nguess ${g}` : `Narrowing it down.\nguess ${g}`)),
    ...badGuesses.map((g) => `The feedback points to ${g}.\nguess ${g}`),
  ];
  return createScriptedAgent(script, { id: 'fixture-model' });
}

/** @type {{ file: string, episode: () => Promise<*> }[]} */
const EPISODES = [
  {
    // Two-player, terminal: the fixture agent loses to the perfect minimax
    // opponent, and every reply parses.
    file: 'tictactoe-perfect-opponent.json',
    episode: async () =>
      runEpisode({
        game: await getGame('tictactoe'),
        tierId: 'perfect-opponent',
        seed: SEED,
        agent: tictactoeModelAgent(),
        now,
      }),
  },
  {
    // Solitaire, valid-then-forfeit: three real guesses, then three
    // consecutive unparseable ones end the episode as forfeit-invalid.
    file: 'mastermind-forfeit.json',
    episode: async () =>
      runEpisode({
        game: await getGame('mastermind'),
        tierId: 'classic',
        seed: SEED,
        agent: mastermindModelAgent(['AABB', 'ABCC', 'AABC'], ['ZZZZ', 'AB', 'ZZQQ']),
        now,
      }),
  },
  {
    // Solitaire, mixed: one invalid guess early (the referee flags it and the
    // next turn sees the feedback), then valid guesses to budget exhaustion.
    file: 'mastermind-mixed.json',
    episode: async () => {
      const codes = ['AABB', 'ABCC', 'AABC', 'BCCA', 'CABA'];
      // More replies than the classic episode budget can consume; the runner
      // ends the episode on budget-exhausted before the script runs dry.
      const guesses = [...codes, ...Array.from({ length: 40 }, (_, i) => codes[i % codes.length])];
      const withInvalid = [...guesses.slice(0, 1), 'ZZZZ', ...guesses.slice(1)];
      return runEpisode({
        game: await getGame('mastermind'),
        tierId: 'classic',
        seed: SEED,
        agent: mastermindModelAgent(withInvalid, []),
        now,
      });
    },
  },
];

for (const { file, episode } of EPISODES) {
  const trajectory = await episode();
  if (trajectory.game.version !== (await getGame(trajectory.game.id)).spec.version) {
    throw new Error(`fixture ${file} did not record the current game version`);
  }
  writeFileSync(join(here, file), `${JSON.stringify(trajectory, null, 2)}\n`);
  console.log(`wrote ${file}: ${trajectory.steps.length} steps, ${trajectory.end.reason}`);
}
