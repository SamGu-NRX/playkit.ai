/**
 * The Stockfish opponent agent for the chess-stockfish game. One engine
 * process per agent instance (the runner builds one per episode): it spawns
 * lazily on the first move, fixes Threads=1 and Hash for determinism, calls
 * `ucinewgame` once at the start of the episode, and answers every turn with
 * `position <start> moves ...` + `go nodes <budget>`.
 *
 * The `node:child_process` import is lazy (inside `act`), so the game module
 * stays free of static `node:*` imports for any bundler that walks the game
 * registry.
 *
 * @module
 */

/** @import { Agent, TierSpec } from '../../core/types.js' */
/** @import { ChessState } from '../chess/index.js' */

/**
 * Build the Stockfish opponent for one tier. The tier params carry the node
 * budget and an optional search-timeout ceiling:
 * `{ nodes: number, searchTimeoutMs?: number }`.
 *
 * @param {object} options
 * @param {TierSpec} options.tier The tier whose params set the node budget.
 * @param {string} [options.seed] Episode seed (kept for trajectory symmetry
 *   with the built-in engine baseline; the engine itself is seeded by being
 *   deterministic, not by an RNG).
 * @param {number} [options.seat] The seat the opponent plays.
 * @param {string} [options.id] Agent id recorded in trajectories.
 * @param {string} [options.enginePath] Explicit engine binary. Defaults to
 *   GAUNTLET_STOCKFISH, then a PATH search.
 * @param {number} [options.idleTimeoutMs] Idle reap timeout for the engine
 *   process (tests shrink this).
 * @returns {Agent & { dispose: () => Promise<void> }}
 */
export function createStockfishOpponentAgent({
  tier,
  seed,
  seat,
  id,
  enginePath,
  idleTimeoutMs,
} = /** @type {never} */ ({})) {
  const params = /** @type {{ nodes: number, searchTimeoutMs?: number, elo?: number }} */ (
    /** @type {*} */ (tier?.params ?? {})
  );
  const nodes = params.nodes;
  if (!Number.isInteger(nodes) || nodes <= 0) {
    throw new Error(
      `tier "${tier?.id ?? '?'}" needs params.nodes as a positive integer, got ${JSON.stringify(nodes)}`
    );
  }
  const searchTimeoutMs = params.searchTimeoutMs;
  // Optional strength limit: when set, the engine plays under UCI's
  // documented skill ceiling (UCI_LimitStrength + UCI_Elo) instead of full
  // strength. Useful for absolute calibration runs (see rating/absolute.js).
  const elo = params.elo;

  /** @type {Promise<*> | null} */
  let enginePromise = null;
  /** @type {boolean} */
  let episodeStarted = false;
  /** @type {import('../../engines/uci/client.js').UciEngine | null} */
  let currentEngine = null;
  void seed;
  void seat;

  /**
   * Lazily spawn and configure the engine (first move only).
   *
   * @returns {Promise<*>} the UciEngine instance.
   */
  function engineForEpisode() {
    if (enginePromise) return enginePromise;
    enginePromise = (async () => {
      // Lazy dynamic import: keeps node:* out of the static game graph.
      const uci = await import('../../engines/uci/client.js');
      const resolvedPath = enginePath ?? uci.findEngineBinary();
      if (!resolvedPath) {
        throw new Error(
          'no Stockfish binary found: install stockfish (e.g. apt install stockfish) or set GAUNTLET_STOCKFISH to the binary path'
        );
      }
      const instance = new uci.UciEngine({
        binaryPath: resolvedPath,
        idleTimeoutMs,
      });
      currentEngine = instance;
      await instance.start();
      await instance.setoption('Threads', 1);
      await instance.setoption('Hash', uci.DEFAULT_HASH_MB);
      if (elo !== undefined) {
        if (!Number.isInteger(elo)) {
          throw new Error(`tier params.elo must be an integer UCI_Elo value, got ${JSON.stringify(elo)}`);
        }
        await instance.setoption('UCI_LimitStrength', true);
        await instance.setoption('UCI_Elo', elo);
      }
      return instance;
    })();
    enginePromise.catch(() => {
      // Keep the rejection reachable for the next act() call too.
      enginePromise = null;
      episodeStarted = false;
    });
    return enginePromise;
  }

  return {
    id: id ?? `chess-stockfish-${tier.id}`,
    track: /** @type {'baseline'} */ ('baseline'),

    /**
     * Answer the current position with a fixed-node Stockfish search.
     *
     * @param {import('../../core/types.js').TurnContext} ctx
     * @returns {Promise<import('../../core/types.js').AgentReply>}
     */
    async act(ctx) {
      const state = /** @type {ChessState} */ (ctx.observation.data);
      const engine = await engineForEpisode();
      if (!episodeStarted) {
        await engine.ucinewgame();
        episodeStarted = true;
      }
      engine.positionFen(state.startFen, state.moves);
      const best = await engine.goNodes(nodes, { searchTimeoutMs });
      if (best.bestmove === '(none)') {
        throw new Error(
          `Stockfish returned no move for position ${state.fen} (moves: ${state.moves.length})`
        );
      }
      return {
        text: best.bestmove,
        meta: {
          engine: engine.idName,
          nodesBudget: nodes,
          depth: best.info?.depth ?? null,
          searchedNodes: best.info?.nodes ?? null,
        },
      };
    },

    /**
     * Shut the engine down explicitly (tests and any host that wants a
     * deterministic teardown; the client also reaps idle engines).
     *
     * @returns {Promise<void>}
     */
    async dispose() {
      enginePromise = null;
      episodeStarted = false;
      // `engine` is only reachable through enginePromise in flight; keep a
      // module-level handle for dispose.
      const instance = currentEngine;
      currentEngine = null;
      if (instance) await instance.quit();
    },
  };
}
