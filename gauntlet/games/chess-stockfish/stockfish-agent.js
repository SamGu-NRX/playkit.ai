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
 * @param {string[]} [options.engineArgs] Extra argv passed to the spawned
 *   engine (tests use it to turn on fixture recording).
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
  engineArgs,
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
  /** Options actually sent to this episode's engine; recorded in every meta. */
  let configuredOptions = /** @type {Record<string, number | boolean>} */ ({});
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
        engineArgs,
        idleTimeoutMs,
      });
      currentEngine = instance;
      await instance.start();
      // Pin exactly the documented configuration, but only for options the
      // engine actually advertises: recent Stockfish releases dropped
      // Contempt, and the client is engine-generic. Whatever was sent is
      // recorded in every reply's meta.
      configuredOptions = {};
      /** @type {Array<[string, number]>} */
      const pinned = [
        ['Threads', 1],
        ['Hash', uci.DEFAULT_HASH_MB],
        ['MultiPV', 1],
        ['Contempt', 0],
      ];
      for (const [optionName, value] of pinned) {
        if (!instance.options.has(optionName)) continue;
        await instance.setoption(optionName, value);
        configuredOptions[optionName] = value;
      }
      if (elo !== undefined) {
        if (!Number.isInteger(elo)) {
          throw new Error(`tier params.elo must be an integer UCI_Elo value, got ${JSON.stringify(elo)}`);
        }
        if (!instance.options.has('UCI_Elo')) {
          throw new Error(
            `tier params.elo was set, but the engine at "${resolvedPath}" does not advertise a UCI_Elo option`
          );
        }
        if (instance.options.has('UCI_LimitStrength')) {
          await instance.setoption('UCI_LimitStrength', true);
          configuredOptions.UCI_LimitStrength = true;
        }
        await instance.setoption('UCI_Elo', elo);
        configuredOptions.UCI_Elo = elo;
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
      const info = best.info;
      const score =
        info?.scoreMate != null
          ? { mate: info.scoreMate }
          : info?.scoreCp != null
            ? { cp: info.scoreCp }
            : null;
      return {
        text: best.bestmove,
        meta: {
          engine: engine.idName,
          binaryPath: engine.binaryPath,
          nodesBudget: nodes,
          depth: info?.depth ?? null,
          searchedNodes: info?.nodes ?? null,
          nps: info?.nps ?? null,
          score,
          options: configuredOptions,
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
