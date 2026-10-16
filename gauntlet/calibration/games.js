/**
 * Calibration games: every game imported DIRECTLY from its packet directory.
 * Deliberately no import of `games/index.js` — the registry is being edited by
 * another thread and an integration packet registers everything later, so the
 * calibration kit must not depend on it.
 *
 * Each entry maps the game to the three baseline tracks the design doc names
 * (random / greedy / engine), wrapping each packet's own baseline factory so
 * trajectories record uniform agent ids (`random`, `greedy`, `engine`). Where
 * a packet ships no factory for a track, the calibration kit supplies one
 * (noted inline); those agents are pure functions of the observation plus the
 * core RNG seeded by the episode seed — no `Math.random`, no clocks, and no
 * `node:*` imports, so they stay browser-safe like the games themselves.
 *
 * Mapping decisions (recorded in REPORT.md too):
 * - minesweeper: `greedy` = the probability agent (falls back to lowest mine
 *   probability when deduction stalls), `engine` = the deduction agent (plays
 *   only proven-safe cells — the no-guess guarantee made flesh).
 * - tictactoe: no packet baselines exist, so `greedy` = win/block/center
 *   heuristic, `engine` = perfect minimax over the game's own `step`.
 * - sliding: `engine` = the packet's optimal-line solver agent; `greedy` =
 *   Manhattan-distance-descent with seeded tie-breaks.
 * - chess-stockfish: `greedy` = the chess packet's material-capture agent;
 *   `engine` = full node-budget Stockfish (the sf-1m ceiling tier) playing as
 *   the agent, so the ladder runs from uniform play to the strongest local
 *   engine.
 * - chess-puzzles: `greedy`/`engine` = the chess packet's greedy and
 *   fixed-strength engine agents (the pairing the puzzles packet reports).
 * - chess-endgames and cube: packet-native baseline factories used directly.
 *
 * @module
 */

import { createRandomAgent } from '../agents/random.js';
import { createSlidingSolverAgent } from '../agents/sliding-solver.js';
import { nextInt, rngFromSeed } from '../core/rng.js';

import chess from '../games/chess/index.js';
import { createGreedyBaselineAgent, createEngineBaselineAgent } from '../games/chess/baselines.js';

import minesweeper from '../games/minesweeper/index.js';
import { createDeductionAgent, createProbabilityAgent } from '../games/minesweeper/baselines.js';

import game2048 from '../games/2048/index.js';
import { greedy as greedy2048, engine as engine2048 } from '../games/2048/baselines.js';

import sliding from '../games/sliding/index.js';

import sokoban from '../games/sokoban/index.js';
import { greedyAgent as sokobanGreedy, engineAgent as sokobanEngine } from '../games/sokoban/baselines.js';

import connect4 from '../games/connect4/index.js';
import { createGreedyAgent as c4Greedy, createEngineAgent as c4Engine } from '../games/connect4/baselines.js';

import mastermind from '../games/mastermind/index.js';
import { createGreedyAgent as mastermindGreedy, createEngineAgent as mastermindEngine } from '../games/mastermind/baselines.js';

import holdem from '../games/holdem/index.js';
import { makeBaseline as holdemBaseline } from '../games/holdem/baselines.js';

import cube from '../games/cube/index.js';
import { createEngineAgent as cubeEngine, createGreedyAgent as cubeGreedy } from '../games/cube/baselines.js';

import chessEndgames from '../games/chess-endgames/index.js';
import { engineAgent as chessEndgamesEngine, greedyAgent as chessEndgamesGreedy } from '../games/chess-endgames/baselines.js';

import chessStockfish from '../games/chess-stockfish/index.js';
import { createStockfishOpponentAgent } from '../games/chess-stockfish/stockfish-agent.js';

import chessPuzzles from '../games/chess-puzzles/index.js';

import tictactoe from '../games/tictactoe/index.js';

/** @import { Agent, Game, TurnContext, TierSpec } from '../core/types.js' */

/**
 * The seat the runner will give the agent for an episode — the same rule the
 * runner uses, mirrored here because some packet baselines (chess engine,
 * hold'em) need the seat before the episode starts.
 *
 * @param {Game<*>} game
 * @param {TierSpec} tier
 * @param {string} seed
 * @returns {number}
 */
export function agentSeatFor(game, tier, seed) {
  return typeof game.agentSeat === 'function' ? game.agentSeat(tier, seed) : 0;
}

/**
 * Wrap a packet agent so trajectories record the uniform baseline id.
 *
 * @param {'random' | 'greedy' | 'engine'} kind
 * @param {Agent} inner
 * @returns {Agent}
 */
function wrap(kind, inner) {
  return {
    id: kind,
    track: /** @type {'baseline'} */ ('baseline'),
    /** @param {TurnContext} ctx */
    async act(ctx) {
      return inner.act(ctx);
    },
  };
}

/**
 * Tic-tac-toe greedy: win now, else block the opponent's win, else center,
 * corners, edges — seeded tie-breaks within the chosen class.
 *
 * @param {{ episodeSeed: string, seat: number }} episode
 * @returns {Agent}
 */
function tictactoeGreedy({ episodeSeed, seat }) {
  return {
    id: 'greedy',
    track: /** @type {'baseline'} */ ('baseline'),
    /** @param {TurnContext} ctx */
    async act(ctx) {
      const state = /** @type {{ board: (string | null)[], toMove: number }} */ (ctx.observation.data);
      const opponent = 1 - state.toMove;
      const free = ctx.legalActions ?? [];
      if (free.length === 0) throw new Error(`greedy baseline "greedy" received no legal actions`);
      /**
       * @param {string} cell
       * @param {number} trySeat
       */
      const winsWith = (cell, trySeat) => {
        const mark = trySeat === 0 ? 'X' : 'O';
        const board = state.board.slice();
        board[tictactoeCellIndex(cell)] = mark;
        return tictactoeWins(board, trySeat);
      };
      const winning = free.filter((cell) => winsWith(cell, state.toMove));
      const blocking = free.filter((cell) => winsWith(cell, opponent));
      const center = free.filter((cell) => cell === 'b2');
      const corners = free.filter((cell) => ['a1', 'c1', 'a3', 'c3'].includes(cell));
      const rest = free.filter((cell) => !corners.includes(cell) && cell !== 'b2');
      const pool = winning.length > 0 ? winning : blocking.length > 0 ? blocking : center.length > 0 ? center : corners.length > 0 ? corners : rest;
      const pick = nextInt(rngFromSeed(`${episodeSeed}/greedy/${seat}/${ctx.turn}`), 0, pool.length - 1).value;
      return { text: pool[pick] };
    },
  };
}

/**
 * @param {(string | null)[]} board
 * @param {number} seat
 * @returns {boolean}
 */
function tictactoeWins(board, seat) {
  const mark = seat === 0 ? 'X' : 'O';
  const lines = [
    [0, 1, 2], [3, 4, 5], [6, 7, 8],
    [0, 3, 6], [1, 4, 7], [2, 5, 8],
    [0, 4, 8], [2, 4, 6],
  ];
  return lines.some(([a, b, c]) => board[a] === mark && board[b] === mark && board[c] === mark);
}

/**
 * @param {string} cell
 * @returns {number}
 */
function tictactoeCellIndex(cell) {
  const col = ['a', 'b', 'c'].indexOf(cell[0]);
  return (Number(cell[1]) - 1) * 3 + col;
}

/**
 * Tic-tac-toe engine: perfect minimax from the agent's seat, scored by the
 * game's own outcome() so values agree with the scoring rules. Wins sooner
 * and loses later via a depth bonus, matching the built-in opponent's taste.
 *
 * @param {{ seat: number }} episode
 * @returns {Agent}
 */
function tictactoeEngine({ seat }) {
  return {
    id: 'engine',
    track: /** @type {'baseline'} */ ('baseline'),
    /** @param {TurnContext} ctx */
    async act(ctx) {
      const state = /** @type {*} */ (ctx.observation.data);
      const { cell } = tictactoeBest(state, seat, 0);
      return { text: cell };
    },
  };
}

/**
 * @param {*} state
 * @param {number} seat
 * @param {number} ply
 * @returns {{ cell: string, score: number }}
 */
function tictactoeBest(state, seat, ply) {
  const mover = state.toMove;
  let bestScore = -Infinity;
  let bestCell = '';
  for (const cell of tictactoe.legalActions(state, mover)) {
    const child = tictactoe.step(state, mover, cell);
    const outcome = tictactoe.outcome(child);
    let score;
    if (outcome) {
      // Negamax: terminal values are scored from the node's mover's
      // perspective; the caller negates. Scoring from the root seat here
      // inverts every odd ply and makes the search prefer losing lines.
      score = outcome.normalized[mover] * 100 - ply;
    } else {
      score = -tictactoeBest(child, seat, ply + 1).score;
    }
    if (score > bestScore) {
      bestScore = score;
      bestCell = cell;
    }
  }
  return { cell: bestCell, score: bestScore };
}

/**
 * Sliding greedy: take the legal slide that minimizes the total Manhattan
 * distance of tiles to their goal cells; tie-breaks seeded from the episode
 * seed. The observation carries the full state, so moves are simulated with
 * the game's own `step` — no duplicated move semantics.
 *
 * @param {{ episodeSeed: string, seat: number }} episode
 * @returns {Agent}
 */
function slidingGreedy({ episodeSeed, seat }) {
  return {
    id: 'greedy',
    track: /** @type {'baseline'} */ ('baseline'),
    /** @param {TurnContext} ctx */
    async act(ctx) {
      const state = /** @type {{ board: number[][], size: number }} */ (ctx.observation.data);
      const legal = ctx.legalActions ?? [];
      if (legal.length === 0) throw new Error(`greedy baseline "greedy" received no legal actions`);
      /** @type {{ action: string, distance: number }[]} */
      const scored = legal.map((action) => {
        const child = /** @type {{ board: number[][], size: number }} */ (
          sliding.step(/** @type {*} */ ({ ...state }), seat, action)
        );
        return { action, distance: manhattanDistance(child.board, child.size) };
      });
      const best = Math.min(...scored.map((s) => s.distance));
      const pool = scored.filter((s) => s.distance === best).map((s) => s.action);
      const pick = nextInt(rngFromSeed(`${episodeSeed}/greedy/${seat}/${ctx.turn}`), 0, pool.length - 1).value;
      return { text: pool[pick] };
    },
  };
}

/**
 * Total Manhattan distance of every tile to its goal cell (goal: tile v at
 * row floor((v-1)/size), column (v-1)%size; 0 is the blank).
 *
 * @param {number[][]} board
 * @param {number} size
 * @returns {number}
 */
function manhattanDistance(board, size) {
  let total = 0;
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      const tile = board[row][col];
      if (tile === 0) continue;
      const goalRow = Math.floor((tile - 1) / size);
      const goalCol = (tile - 1) % size;
      total += Math.abs(goalRow - row) + Math.abs(goalCol - col);
    }
  }
  return total;
}

/**
 * The kind of episode context packet baseline factories may need.
 *
 * @typedef {object} BaselineContext
 * @property {string} episodeSeed
 * @property {TierSpec} tier
 * @property {number} seat
 */

/**
 * @typedef {object} CalibrationGame
 * @property {string} id
 * @property {Game<*>} game
 * @property {(kind: 'greedy' | 'engine', episode: BaselineContext) => Agent} makeAgent
 */

/**
 * @typedef {'random' | 'greedy' | 'engine'} BaselineKind
 */

/**
 * @type {CalibrationGame[]}
 */
export const CALIBRATION_GAMES = [
  {
    id: 'tictactoe',
    game: tictactoe,
    makeAgent(kind, { episodeSeed, seat }) {
      return kind === 'greedy'
        ? wrap(kind, tictactoeGreedy({ episodeSeed, seat }))
        : wrap(kind, tictactoeEngine({ seat }));
    },
  },
  {
    id: 'chess',
    game: chess,
    makeAgent(kind, { episodeSeed, tier, seat }) {
      return kind === 'greedy'
        ? wrap(kind, createGreedyBaselineAgent({ id: kind, episodeSeed }))
        : wrap(kind, createEngineBaselineAgent({ tier, seed: episodeSeed, seat, id: kind }));
    },
  },
  {
    id: 'minesweeper',
    game: minesweeper,
    makeAgent(kind, { episodeSeed }) {
      return kind === 'greedy'
        ? wrap(kind, createProbabilityAgent({ episodeSeed, id: kind }))
        : wrap(kind, createDeductionAgent({ episodeSeed, id: kind }));
    },
  },
  {
    id: '2048',
    game: game2048,
    makeAgent(kind) {
      return kind === 'greedy' ? wrap(kind, greedy2048()) : wrap(kind, engine2048({ depth: 2 }));
    },
  },
  {
    id: 'sliding',
    game: sliding,
    makeAgent(kind, { episodeSeed, seat }) {
      return kind === 'greedy'
        ? wrap(kind, slidingGreedy({ episodeSeed, seat }))
        : wrap(kind, createSlidingSolverAgent({ id: kind }));
    },
  },
  {
    id: 'sokoban',
    game: sokoban,
    makeAgent(kind) {
      return kind === 'greedy' ? wrap(kind, sokobanGreedy()) : wrap(kind, sokobanEngine());
    },
  },
  {
    id: 'connect4',
    game: connect4,
    makeAgent(kind) {
      return kind === 'greedy' ? wrap(kind, c4Greedy()) : wrap(kind, c4Engine());
    },
  },
  {
    id: 'mastermind',
    game: mastermind,
    makeAgent(kind, { episodeSeed }) {
      return kind === 'greedy'
        ? wrap(kind, mastermindGreedy({ episodeSeed }))
        : wrap(kind, mastermindEngine({ episodeSeed }));
    },
  },
  {
    id: 'holdem',
    game: holdem,
    makeAgent(kind, { episodeSeed, seat }) {
      return wrap(kind, holdemBaseline(kind, episodeSeed, seat));
    },
  },
  {
    id: 'cube',
    game: cube,
    makeAgent(kind, { episodeSeed }) {
      return kind === 'greedy'
        ? wrap(kind, cubeGreedy({ episodeSeed }))
        : wrap(kind, cubeEngine({ episodeSeed }));
    },
  },
  {
    id: 'chess-endgames',
    game: chessEndgames,
    makeAgent(kind, { episodeSeed, tier, seat }) {
      return kind === 'greedy'
        ? wrap(kind, chessEndgamesGreedy(tier, episodeSeed, seat))
        : wrap(kind, chessEndgamesEngine(tier, episodeSeed, seat));
    },
  },
  {
    id: 'chess-puzzles',
    game: chessPuzzles,
    makeAgent(kind, { episodeSeed, tier }) {
      return kind === 'greedy'
        ? wrap(kind, createGreedyBaselineAgent({ id: kind, episodeSeed }))
        : wrap(kind, createEngineBaselineAgent({ tier, seed: episodeSeed, seat: 0, id: kind }));
    },
  },
  {
    id: 'chess-stockfish',
    game: chessStockfish,
    makeAgent(kind, { episodeSeed, tier, seat }) {
      if (kind === 'greedy') {
        return wrap(kind, createGreedyBaselineAgent({ id: kind, episodeSeed }));
      }
      // engine: the ladder's ceiling rung (full node budget) as the agent, so
      // the a-order check asks whether the strongest local engine still beats
      // uniform and greedy play against every opponent rung.
      const ceiling = chessStockfish.spec.tiers.find((t) => t.id === 'sf-1m');
      if (!ceiling) throw new Error('chess-stockfish is missing its sf-1m ceiling tier');
      return wrap(kind, createStockfishOpponentAgent({ tier: ceiling, seed: episodeSeed, seat, id: kind }));
    },
  },
];

/**
 * The agent for one baseline kind. The random baseline is uniform across
 * every game (the core kit's seeded uniform pick over `legalActions`), so it
 * is handled here once instead of per game; greedy and engine come from the
 * game's own adapter.
 *
 * @param {CalibrationGame} entry
 * @param {BaselineKind} kind
 * @param {BaselineContext} episode
 * @returns {Agent}
 */
export function makeBaselineAgent(entry, kind, episode) {
  if (kind === 'random') {
    return wrap(kind, createRandomAgent({ episodeSeed: episode.episodeSeed, id: kind }));
  }
  return entry.makeAgent(kind, episode);
}
