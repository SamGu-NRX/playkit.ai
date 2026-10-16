// Runner dispose tests: every engine-backed actor built for an episode —
// the per-episode opponents, and the agent when it offers dispose — must be
// shut down by runEpisode's finally, on success and on throw, so a finished
// episode never leaves a child process alive until the UCI client's 60 s
// idle reap.
//
// The engine here is the real fake-UCI fixture spawned as a child process
// (engines/uci/fixtures/fake-uci-engine.mjs), tagged with a unique argv
// marker so the OS-level "no child alive" check only counts this file's
// engines and cannot be confused by a parallel test file's fixtures.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runEpisode } from './runner.js';
import { UciEngine } from '../engines/uci/client.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, '..', 'engines', 'uci', 'fixtures', 'fake-uci-engine.mjs');
const TAG = `runner-dispose-${process.pid}`;

/**
 * Count live fixture child processes carrying this test's tag, by scanning
 * /proc cmdlines. Only engines spawned with the tag match; the tag contains
 * this process's pid, which no other test file uses.
 *
 * @returns {Promise<number>}
 */
async function countTaggedEngineChildren() {
  let entries;
  try {
    entries = readdirSync('/proc');
  } catch {
    return -1; // not Linux: the OS-level check is unavailable
  }
  let count = 0;
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const cmdline = await readFile(`/proc/${entry}/cmdline`, 'utf8');
      if (cmdline.includes(TAG)) count++;
    } catch {
      // The process exited between readdir and read; it is not alive.
    }
  }
  return count;
}

/**
 * Poll until no tagged engine child is alive, or fail. The dispose path
 * must release children well inside one second.
 *
 * @returns {Promise<void>}
 */
async function assertNoEngineChildren() {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    if ((await countTaggedEngineChildren()) === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const left = await countTaggedEngineChildren();
  assert.equal(left, 0, 'an engine child outlived the episode (dispose was not called)');
}

/**
 * A minimal two-seat game: both seats answer "ok"; the episode ends after a
 * fixed number of plies. `step` throws once `throwAtStep` is reached, to
 * drive the throw path.
 *
 * @param {{ throwAtStep?: number, opponent: (seat: number) => import('./types.js').Agent }} options
 */
function toyGame({ opponent, throwAtStep = Infinity }) {
  let steps = 0;
  return {
    spec: {
      id: 'runner-dispose-toy',
      version: '0.0.1',
      title: 'Runner dispose toy game',
      seats: /** @type {1 | 2} */ (2),
      information: /** @type {import('./types.js').InformationMode} */ ('perfect'),
      stochastic: false,
      tags: /** @type {import('./types.js').GameTag[]} */ (['planning']),
      benchmark: false,
      requires: [],
      rulesText: 'Both seats answer ok; the episode ends after six plies.',
      tiers: [
        {
          id: 't',
          rank: 1,
          scoring: /** @type {import('./types.js').ScoringMode} */ ('efficiency'),
          maxActions: 10,
          publicSeeds: 1,
          params: {},
        },
      ],
    },
    reset() {
      return { moves: 0 };
    },
    toAct(/** @type {{ moves: number }} */ state) {
      return state.moves >= 6 ? null : state.moves % 2;
    },
    observe(/** @type {{ moves: number }} */ state, /** @type {number} */ seat) {
      return { text: `turn ${state.moves} for seat ${seat}`, data: state };
    },
    legalActions() {
      return ['ok'];
    },
    parseAction(/** @type {{ moves: number }} */ _state, /** @type {number} */ _seat, /** @type {string} */ text) {
      if (text === 'ok') {
        return /** @type {import('./types.js').ParseResult} */ ({ ok: true, action: 'ok' });
      }
      return /** @type {import('./types.js').ParseResult} */ (
        { ok: false, error: 'the only action is ok' }
      );
    },
    step(/** @type {{ moves: number }} */ state) {
      steps++;
      if (steps >= throwAtStep) {
        throw new Error('toy game exploded mid-episode');
      }
      return { moves: state.moves + 1 };
    },
    truncate(/** @type {{ moves: number }} */ _state) {
      return {
        normalized: [0.5, 0.5],
        raw: null,
        reason: 'truncated at the action budget',
        solved: false,
        par: 6,
      };
    },
    outcome() {
      return {
        normalized: [0.5, 0.5],
        raw: null,
        reason: 'six plies played',
        solved: true,
        par: 6,
      };
    },
    agentSeat() {
      return 0;
    },
    opponent(/** @type {*} */ _tier, /** @type {string} */ _seed, /** @type {number} */ seat) {
      return opponent(seat);
    },
  };
}

/**
 * A fixture-backed opponent: spawns the fake UCI engine on the first act
 * (tagged argv), answers "ok" with the engine's bestmove recorded in meta.
 * Mirrors the stockfish-agent lifecycle: lazy spawn, explicit dispose.
 *
 * @param {{ spawned: number[], disposed: number[], seat: number }} log
 */
function fixtureOpponent(log) {
  /** @type {Promise<UciEngine> | null} */
  let enginePromise = null;
  /** @type {UciEngine | null} */
  let engine = null;
  return {
    id: 'fixture-opponent',
    track: /** @type {'baseline'} */ ('baseline'),
    async act(/** @type {any} */ ctx) {
      if (!enginePromise) {
        enginePromise = (async () => {
          const instance = new UciEngine({
            binaryPath: process.execPath,
            engineArgs: [FIXTURE, `--tag=${TAG}`],
          });
          await instance.start();
          engine = instance;
          log.spawned.push(log.seat);
          return instance;
        })();
      }
      const instance = await enginePromise;
      instance.positionStart([]);
      const best = await instance.goNodes(50);
      return { text: 'ok', meta: { bestmove: best.bestmove } };
    },
    async dispose() {
      log.disposed.push(log.seat);
      const instance = engine;
      engine = null;
      enginePromise = null;
      if (instance) await instance.quit();
    },
  };
}

test('runEpisode disposes the episode engine: no child outlives the episode', async () => {
  /** @type {{ spawned: number[], disposed: number[], seat: number }} */
  const log = { spawned: [], disposed: [], seat: 1 };
  const game = toyGame({ opponent: () => fixtureOpponent(log) });
  const agent = {
    id: 'toy-agent',
    track: /** @type {'baseline'} */ ('baseline'),
    async act() {
      return { text: 'ok' };
    },
  };

  // Several episodes in a row: each one builds a fresh opponent, and none of
  // them may leave an engine behind.
  for (let episode = 0; episode < 3; episode++) {
    const spawnedBefore = log.spawned.length;
    const trajectory = await runEpisode({
      game,
      tierId: 't',
      seed: `dispose-success-${episode}`,
      agent,
    });
    assert.equal(trajectory.end.reason, 'terminal');
    assert.equal(log.spawned.length, spawnedBefore + 1, 'each episode spawns exactly one engine');
    assert.equal(log.disposed.length, episode + 1, 'dispose ran before runEpisode resolved');
    await assertNoEngineChildren();
  }
});

test('runEpisode disposes the engine on a mid-episode throw', async () => {
  /** @type {{ spawned: number[], disposed: number[], seat: number }} */
  const log = { spawned: [], disposed: [], seat: 1 };
  const game = toyGame({ opponent: () => fixtureOpponent(log), throwAtStep: 3 });
  const agent = {
    id: 'toy-agent',
    track: /** @type {'baseline'} */ ('baseline'),
    async act() {
      return { text: 'ok' };
    },
  };

  await assert.rejects(
    runEpisode({ game, tierId: 't', seed: 'dispose-throw', agent }),
    /toy game exploded mid-episode/
  );
  assert.equal(log.spawned.length, 1, 'the engine spawned before the throw');
  assert.equal(log.disposed.length, 1, 'dispose ran even though the episode threw');
  await assertNoEngineChildren();
});

test('runEpisode disposes the agent too when it offers dispose', async () => {
  /** @type {number[]} */
  const agentDisposes = [];
  /** @type {{ spawned: number[], disposed: number[], seat: number }} */
  const log = { spawned: [], disposed: [], seat: 1 };
  const game = toyGame({ opponent: () => fixtureOpponent(log) });
  const agent = {
    id: 'toy-agent',
    track: /** @type {'baseline'} */ ('baseline'),
    async act() {
      return { text: 'ok' };
    },
    async dispose() {
      agentDisposes.push(1);
    },
  };

  const trajectory = await runEpisode({ game, tierId: 't', seed: 'dispose-agent', agent });
  assert.equal(trajectory.end.reason, 'terminal');
  assert.equal(agentDisposes.length, 1, 'the agent dispose ran exactly once');
  assert.equal(log.disposed.length, 1, 'the opponent dispose ran too');
  await assertNoEngineChildren();
});
