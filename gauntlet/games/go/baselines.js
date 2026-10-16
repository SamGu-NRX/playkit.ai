/**
 * Baseline agents for Go (9x9): a greedy heuristic (captures first, then
 * ataris, avoiding self-atari) and GNU Go at level 10 as the engine ceiling.
 * Deterministic: the greedy's tie-breaks come from the episode seed through
 * the core RNG, and the engine's play comes from its own `--seed`, so no
 * clocks and no `Math.random` anywhere.
 *
 * The GTP engine agent keeps no engine state between replies: each `act`
 * clears the board, replays the recorded history through `play` commands,
 * and then calls `genmove`. GNU Go's own replies therefore never need to be
 * deduplicated, and any divergence between the engine's internal board and
 * the game's is impossible by construction. One process serves a whole
 * episode; `dispose()` shuts it down (the episode runner calls it in its
 * `finally`).
 *
 * @module
 */

import { checkMove, groupAndLiberties } from './rules.js';
import { nextInt, rngFromSeed } from '../../core/rng.js';
import { fnv1a64 } from '../../core/canonical.js';

/** @import { Agent, TurnContext } from '../../core/types.js' */
/** @import { GoState } from './rules.js' */

/**
 * A nonzero integer seed for GNU Go's `--seed` flag, derived from an
 * arbitrary seed string. GNU Go reseeds from the clock on `--seed 0`, so 0
 * is never returned.
 *
 * @param {string} seed
 * @returns {number}
 */
export function gnugoSeedInt(seed) {
  return Number(BigInt('0x' + fnv1a64(seed)) % 900000000n) + 1;
}

/**
 * Stones of `colour` with exactly one liberty on a board.
 *
 * @param {number[]} board
 * @param {number} colour
 * @returns {number}
 */
function stonesInAtari(board, colour) {
  let count = 0;
  const counted = new Set();
  for (let index = 0; index < board.length; index++) {
    if (board[index] !== colour || counted.has(index)) continue;
    const group = groupAndLiberties(board, index);
    for (const stone of group.stones) counted.add(stone);
    if (group.liberties === 1) count += group.stones.length;
  }
  return count;
}

/**
 * The shared GTP engine agent used by the tier ladder and the engine
 * baseline. Spawns lazily on the first move, one process per agent instance.
 *
 * @param {object} options
 * @param {string} [options.id] Agent id recorded in trajectories.
 * @param {number} options.level GNU Go level 1-10.
 * @param {string} options.episodeSeed Deterministic seed for the engine's
 *   `--seed` flag (same seed and moves, same replies).
 * @param {string} [options.binaryPath] Explicit binary. Defaults to
 *   GAUNTLET_GNUGO, then PATH and /usr/games.
 * @param {number} [options.genmoveTimeoutMs] Deadline per `genmove`. Default
 *   60000; level 10 endgames on 9x9 stay far below it.
 * @returns {Agent & { dispose: () => Promise<void> }}
 */
export function createGtpEngineAgent({
  id,
  level,
  episodeSeed,
  binaryPath,
  genmoveTimeoutMs = 60000,
} = /** @type {never} */ ({})) {
  if (!Number.isInteger(level) || level < 1 || level > 10) {
    throw new Error(`createGtpEngineAgent: level must be an integer 1-10, got ${JSON.stringify(level)}`);
  }
  const seedInt = gnugoSeedInt(episodeSeed ?? `go/level-${level}`);
  /** @type {Promise<*> | null} */
  let enginePromise = null;
  /** @type {import('../../engines/gtp/client.js').GtpEngine | null} */
  let currentEngine = null;

  /**
   * Lazily spawn and configure the engine (first move only).
   *
   * @returns {Promise<*>} the GtpEngine instance.
   */
  function engineForEpisode() {
    if (enginePromise) return enginePromise;
    enginePromise = (async () => {
      // Lazy dynamic import: keeps node:* out of the static game graph.
      const gtp = await import('../../engines/gtp/client.js');
      const resolved = binaryPath ?? gtp.findGtpBinary();
      if (!resolved) {
        throw new Error(
          'no GNU Go binary found: install gnugo (apt-get install gnugo) or set GAUNTLET_GNUGO to the binary path'
        );
      }
      const engine = new gtp.GtpEngine({
        binaryPath: resolved,
        engineArgs: ['--mode', 'gtp', '--level', String(level), '--seed', String(seedInt)],
      });
      currentEngine = engine;
      await engine.start();
      await engine.boardsize(9);
      await engine.komi(7);
      return engine;
    })();
    enginePromise.catch(() => {
      // Keep the rejection reachable for the next act() call too.
      enginePromise = null;
    });
    return enginePromise;
  }

  return {
    id: id ?? `gnugo-level-${level}`,
    track: /** @type {'baseline'} */ ('baseline'),

    /**
     * Answer the current position from a freshly replayed engine board.
     *
     * @param {TurnContext} ctx
     * @returns {Promise<{ text: string, meta?: Record<string, *> }>}
     */
    async act(ctx) {
      const state = /** @type {GoState} */ (ctx.observation.data);
      if (state.status !== 'playing') {
        throw new Error('engine agent asked to move in a finished game');
      }
      const engine = await engineForEpisode();
      // Rebuild from scratch every reply: genmove leaves the engine's own
      // move on its board, so an incremental history replay would double-play
      // it. A clear_board + full replay is stateless and exact.
      await engine.clearBoard();
      await engine.komi(7);
      for (let i = 0; i < state.history.length; i++) {
        const move = state.history[i];
        const color = i % 2 === 0 ? 'black' : 'white';
        const vertex = move === 'pass' ? 'pass' : move.slice('play '.length);
        await engine.play(color, vertex);
      }
      const color = state.toMove === 0 ? 'black' : 'white';
      const reply = await engine.genmove(color, { timeoutMs: genmoveTimeoutMs });
      const upper = String(reply).trim().toUpperCase();
      const meta = {
        engine: engine.idName,
        binaryPath: engine.binaryPath,
        level,
        seed: seedInt,
        historyLength: state.history.length,
      };
      if (upper === 'PASS') return { text: 'pass', meta };
      if (upper === 'RESIGN') {
        // The game has no resign concept; the engine concedes the move.
        return { text: 'pass', meta: { ...meta, resigned: true } };
      }
      return { text: `play ${upper}`, meta };
    },

    /**
     * Shut the engine down (the runner calls this in its finally).
     *
     * @returns {Promise<void>}
     */
    async dispose() {
      enginePromise = null;
      const engine = currentEngine;
      currentEngine = null;
      if (engine) await engine.quit();
    },
  };
}

/**
 * The greedy baseline: captures first, then moves that put opponent stones
 * in atari, then moves that relieve own ataris; self-atari is penalized;
 * ties break seeded. Reads the state from the observation payload.
 *
 * @param {{ episodeSeed: string }} options
 * @returns {Agent}
 */
export function createGreedyAgent({ episodeSeed } = /** @type {never} */ ({})) {
  return {
    id: 'greedy',
    track: /** @type {'baseline'} */ ('baseline'),

    /**
     * @param {TurnContext} ctx
     * @returns {Promise<{ text: string }>}
     */
    async act(ctx) {
      const state = /** @type {GoState} */ (ctx.observation.data);
      if (state.status !== 'playing') {
        throw new Error('greedy agent asked to move in a finished game');
      }
      const legal = ctx.legalActions ?? [];
      if (legal.length === 0) throw new Error('greedy baseline received no legal actions');
      if (!legal.includes('pass')) {
        throw new Error('greedy baseline: "pass" missing from the legal actions');
      }
      const seat = state.toMove;
      const colour = seat + 1;
      const enemy = seat === 0 ? 2 : 1;

      /** @type {{ action: string, value: number }[]} */
      const scored = [];
      for (const action of legal) {
        if (action === 'pass') {
          // Passing achieves nothing while moves exist; scored below every
          // real move. On the rare pass-only turn the loop returns it.
          scored.push({ action, value: -1000 });
          continue;
        }
        const parsed = /^play ([A-J])([1-9])$/.exec(action);
        if (!parsed) throw new Error(`greedy baseline: cannot re-parse action "${action}"`);
        const col = (/** @type {readonly string[]} */ (['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'J'])).indexOf(parsed[1]);
        const row = Number(parsed[2]) - 1;
        const check = checkMove(state, seat, col, row);
        if (!check.ok || !check.board) {
          // Should not happen for an action from legalActions; score it last.
          scored.push({ action, value: -2000 });
          continue;
        }
        const ownAtariAfter = stonesInAtari(check.board, colour);
        const enemyAtariAfter = stonesInAtari(check.board, enemy);
        const ownAtariBefore = stonesInAtari(state.board, colour);
        const enemyAtariBefore = stonesInAtari(state.board, enemy);
        const value =
          check.capturedStones * 100 +
          (enemyAtariAfter - enemyAtariBefore) * 12 -
          (ownAtariAfter - ownAtariBefore) * 30 +
          (ownAtariAfter === 0 ? 4 : 0);
        scored.push({ action, value });
      }
      const best = Math.max(...scored.map((entry) => entry.value));
      const pool = scored.filter((entry) => entry.value === best).map((entry) => entry.action);
      const pick = nextInt(rngFromSeed(`${episodeSeed ?? 'go'}/greedy/${ctx.turn}`), 0, pool.length - 1).value;
      return { text: pool[pick] };
    },
  };
}

/**
 * The engine baseline: GNU Go at level 10, the ceiling the ladder climbs
 * toward. Same reply machinery as the tier opponent.
 *
 * @param {{ episodeSeed: string }} options
 * @returns {Agent & { dispose: () => Promise<void> }}
 */
export function createEngineAgent({ episodeSeed } = /** @type {never} */ ({})) {
  return createGtpEngineAgent({
    id: 'engine',
    level: 10,
    episodeSeed: episodeSeed ?? 'go/engine-baseline',
  });
}
