/**
 * Lichess chess puzzles for the Gauntlet: the agent plays the full solution
 * of tactics puzzles drawn from the CC0 Lichess puzzle database, in tiers by
 * Lichess puzzle rating — the difficulty scale human attempts have
 * calibrated. This is the closest a Gauntlet game comes to ARC-AGI's
 * human-calibrated difficulty.
 *
 * Shape of an episode: the state starts at the puzzle's position after the
 * opponent's move (the dump's FEN is one move earlier; reset applies that
 * move). The agent plays for the winning side; after each of its moves the
 * opponent's reply from the solution line is played automatically inside
 * step(), so one agent action is one player move, not one ply. Every move the
 * agent plays must be exactly the next move of the solution line, with one
 * chess-rules exception: any move that delivers checkmate wins immediately
 * (this accepts alternative mates in a mate-in-one, where more than one move
 * ends the king). An illegal or unparseable move is an invalid attempt
 * (runner feedback, budget consumed); a legal move that is not the line ends
 * the episode unsolved; completing the line scores 1. Tier maxActions is the
 * sample's largest player-move count plus 2.
 *
 * The solution line is grader-side data: it lives in the game state so step()
 * can adjudicate, but observations never carry it. The board itself is
 * perfect information.
 *
 * Seeds are `<game>/<tier>/public/<index>` (index into the committed sample,
 * built by scripts/sample.js) or `<game>/<tier>/eval/<PuzzleId>` (resolved
 * against the eval sample registered by the Node-only loadEvalPuzzles in
 * eval-loader.node.js). Unknown seeds throw a loud error.
 *
 * Browser-safe: no `node:*` imports. Reuses gauntlet/games/chess/ for
 * notation parsing, board rendering, move replay and the baseline agents, and
 * does not modify that directory.
 *
 * @module
 */

import { Chess } from 'chess.js';
import { GauntletRuleError } from '../../core/errors.js';
import { internals, legalUcis, matchUci, replayUci } from '../chess/engine.js';
import { renderBoard, renderMoves } from '../chess/render.js';
import { parseNotationAsAction } from '../chess/notation.js';
import {
  PUBLIC_SEEDS,
  getEvalPuzzle,
  getPublicPuzzle,
} from './puzzles.js';
import { QUALITY, TIERS, tierIds } from './selection.js';

/** @import { FastChess } from '../chess/engine.js' */
/** @import { Agent, Game, GameSpec, GameTag, InformationMode, Observation, Outcome, ParseResult, TierSpec } from '../../core/types.js' */
/** @import { PuzzleRecord } from './selection.js' */

export const GAME_ID = 'chess-puzzles';

/**
 * How an episode ended.
 *
 * @typedef {object} Termination
 * @property {'solved' | 'wrong-move' | 'failed'} type
 * @property {string} detail Human-readable detail (grader-side; the outcome
 *   reason carries it after the episode, never a live observation).
 */

/**
 * Game state: plain JSON. `moves` starts with the opponent's pre-move from
 * the dump; `solution` is the full dump line (grader-side); `solutionIndex`
 * points at the next expected move in it.
 *
 * @typedef {object} PuzzleState
 * @property {string} puzzleId
 * @property {number} rating
 * @property {string} startFen The dump FEN: the position before the opponent's move.
 * @property {string[]} moves UCI played so far, pre-move first.
 * @property {string[]} san SAN mirror of `moves`.
 * @property {string} fen The position after `moves`.
 * @property {'w' | 'b'} playerColor The solving side.
 * @property {string[]} solution Full UCI solution line from the dump.
 * @property {number} solutionIndex Index of the next expected move.
 * @property {Termination | null} termination
 */

/**
 * Build the game state for a puzzle record.
 *
 * @param {PuzzleRecord} record
 * @returns {PuzzleState}
 */
export function stateFromPuzzle(record) {
  const solution = record.Moves.split(' ');
  const chessApi = new Chess(record.FEN);
  const fast = /** @type {FastChess} */ (/** @type {unknown} */ (chessApi));
  const preMove = matchUci(chessApi, solution[0]);
  if (!preMove) {
    throw new Error(
      `chess-puzzles: puzzle ${record.PuzzleId} has an illegal opening move "${solution[0]}" for FEN "${record.FEN}"`
    );
  }
  const san0 = fast._moveToSan(preMove, fast._moves({ legal: true }));
  fast._makeMove(preMove);
  const end = endAfterPly(chessApi, 'opponent');
  return {
    puzzleId: record.PuzzleId,
    rating: record.Rating,
    startFen: record.FEN,
    moves: [solution[0]],
    san: [san0],
    fen: chessApi.fen(),
    playerColor: chessApi.turn(),
    solution,
    solutionIndex: 1,
    termination: end,
  };
}

/**
 * Resolve a seed string to its puzzle record. Public seeds index the
 * committed sample; eval seeds name a puzzle in the registered eval sample.
 * Throws loudly (with the expected shapes) on anything else.
 *
 * @param {string} tierId
 * @param {string} seed
 * @returns {PuzzleRecord}
 */
export function resolvePuzzle(tierId, seed) {
  const parts = typeof seed === 'string' ? seed.split('/') : [];
  if (parts.length !== 4 || parts[0] !== GAME_ID) {
    throw new Error(
      `chess-puzzles: unknown seed ${JSON.stringify(seed)}; expected "${GAME_ID}/<tier>/public/<index>" or "${GAME_ID}/<tier>/eval/<PuzzleId>"`
    );
  }
  const [, seedTier, split, key] = parts;
  if (!tierIds().includes(seedTier)) {
    throw new Error(
      `chess-puzzles: seed ${JSON.stringify(seed)} names unknown tier "${seedTier}" (tiers: ${tierIds().join(', ')})`
    );
  }
  if (seedTier !== tierId) {
    throw new Error(
      `chess-puzzles: seed ${JSON.stringify(seed)} is for tier "${seedTier}" but reset was called for tier "${tierId}"`
    );
  }
  if (split === 'public') {
    const index = Number(key);
    if (!Number.isInteger(index)) {
      throw new Error(
        `chess-puzzles: public seed index must be an integer, got ${JSON.stringify(key)} in ${JSON.stringify(seed)}`
      );
    }
    return getPublicPuzzle(seedTier, index);
  }
  if (split === 'eval') {
    return getEvalPuzzle(seedTier, key);
  }
  throw new Error(
    `chess-puzzles: seed ${JSON.stringify(seed)} must use the "public" or "eval" split, got "${split}"`
  );
}

/**
 * Whether the position is over after the mover's ply, and who won it. A
 * side with no legal moves is mated (the mover wins) or stalemated (draw —
 * the solving side failed to win).
 *
 * @param {Chess} chessApi Position after the ply.
 * @param {'agent' | 'opponent'} mover
 * @returns {Termination | null}
 */
function endAfterPly(chessApi, mover) {
  const fast = /** @type {FastChess} */ (/** @type {unknown} */ (chessApi));
  if (fast._moves({ legal: true }).length > 0) return null;
  if (chessApi.isCheck()) {
    return mover === 'agent'
      ? { type: 'solved', detail: 'checkmate delivered' }
      : { type: 'failed', detail: 'the solution line mates the solving side (corrupt puzzle)' };
  }
  return {
    type: 'failed',
    detail: mover === 'agent' ? 'stalemate: the solving side has no winning line' : 'stalemate after the opponent reply',
  };
}

/**
 * Build the tier list from the bands and the quality filters: maxActions is
 * the filter's longest admissible player-move count plus 2, so ANY puzzle
 * the filters admit is completable within the budget — eval puzzles obey
 * only the filter bound, not the public sample's shape. The engine params
 * are the SAME at every tier — the tier ladder is the puzzles'
 * human-calibrated rating, not the baseline's strength — and exist so the
 * bundled engine baseline (which reads tier.params) is one fixed-strength
 * agent across the ladder.
 *
 * @type {TierSpec[]}
 */
const tiers = TIERS.map((band) => ({
  id: band.id,
  rank: band.rank,
  scoring: /** @type {'outcome'} */ ('outcome'),
  maxActions: QUALITY.maxPlayerMoves + 2,
  publicSeeds: PUBLIC_SEEDS,
  params: {
    min: band.min,
    max: band.max,
    depth: 2,
    nodeBudget: 20000,
    quiescenceMaxPlies: 8,
  },
}));

const RULES_GRAMMAR =
  'Action grammar: UCI coordinates, e.g. "e2e4" or "a7a8q" for promotion; Standard Algebraic Notation like "Nf3", "exd5", "O-O" is also accepted, with or without check/mate marks.';

const RULES_SCORING = [
  'You play the winning side of a known chess tactics puzzle. The position shown is after the opponent\'s last move; find the winning continuation.',
  'After each of your moves the opponent\'s reply is played automatically (you do not choose it).',
  'Every move you play must be exactly the next move of the winning line. A move that is not on the line — even a legal, good-looking one — ends the episode immediately unsolved (score 0).',
  'Exception: delivering checkmate at any point wins immediately, even if the mating move is not the line\'s next move (a mate in one may have more than one mating move).',
  'An unknown, unparseable or illegal move is an invalid attempt: it consumes an action attempt and the position is re-presented. Too many consecutive invalid attempts forfeit the episode.',
  `The action budget is ${QUALITY.maxPlayerMoves + 2} actions (the longest admissible line is ${QUALITY.maxPlayerMoves} player moves, plus 2 spare attempts); running out of budget ends the episode unsolved.`,
].join(' ');

/** @type {GameSpec} */
const spec = {
  id: GAME_ID,
  version: '1.0.0',
  title: 'Lichess Chess Puzzles',
  seats: /** @type {1 | 2} */ (1),
  information: /** @type {InformationMode} */ ('perfect'),
  stochastic: false,
  tags: /** @type {GameTag[]} */ (['deduction', 'adversarial']),
  benchmark: true,
  requires: [],
  rulesText: [
    'Chess tactics puzzles from the Lichess puzzle database (CC0), tiered by Lichess puzzle rating — the difficulty scale calibrated by millions of human attempts.',
    `Tier rating bands: ${TIERS.map((t) => `${t.id} [${t.min}, ${t.max ?? '∞'})`).join('; ')}.`,
    RULES_GRAMMAR,
    RULES_SCORING,
  ].join(' '),
  tiers,
};

/**
 * Sorted legal UCI actions for the solving seat; empty for a finished
 * puzzle or a foreign seat. Module-level so observe() can call it without
 * binding concerns.
 *
 * @param {PuzzleState} state
 * @param {number} seat
 * @returns {string[]}
 */
function legalActionsOf(state, seat) {
  if (state.termination) return [];
  if (seat !== 0) return [];
  return legalUcis(replayUci(state.startFen, state.moves));
}

/** @type {Game<PuzzleState>} */
export const chessPuzzles = {
  spec,

  /**
   * Deterministic in (tier, seed): the seed names the puzzle, so there is
   * nothing to draw — reset applies the dump's pre-move and returns the
   * position the solving side faces.
   *
   * @param {TierSpec} tier
   * @param {string} seed
   * @returns {PuzzleState}
   */
  reset(tier, seed) {
    const record = resolvePuzzle(tier.id, seed);
    return stateFromPuzzle(record);
  },

  /**
   * The solving seat, or null when the puzzle is over. One seat; the
   * opponent's replies are played inside step().
   *
   * @param {PuzzleState} state
   * @returns {number | null}
   */
  toAct(state) {
    if (state.termination) return null;
    return 0;
  },

  /**
   * Full observation: board, side to move, history, and the legal-action
   * list (the conformance contract requires listing them when there are 64
   * or fewer). The solution line is grader-side data and is never rendered;
   * the next correct move is of course among the listed legal actions — that
   * is the puzzle.
   *
   * @param {PuzzleState} state
   * @param {number} seat
   * @returns {Observation}
   */
  observe(state, seat) {
    const chessApi = replayUci(state.startFen, state.moves);
    const legal = this.legalActions(state, seat);
    const color = state.playerColor === 'w' ? 'white' : 'black';
    const lines = [
      `Chess puzzle ${state.puzzleId} (Lichess rating ${state.rating}). You are seat ${seat}, playing ${color} (${state.playerColor === 'w' ? 'uppercase' : 'lowercase'} pieces).`,
      renderBoard(chessApi),
      `Side to move: ${chessApi.turn() === 'w' ? 'white' : 'black'}${chessApi.isCheck() ? ', in check' : ''}`,
      `Moves so far: ${renderMoves(state.san)}`,
      RULES_SCORING,
      legal.length > 0
        ? legal.length <= 64
          ? `Legal actions (${legal.length}, all listed): ${legal.join(', ')}`
          : `Legal actions: ${legal.length} (too many to list; use UCI like "e2e4").`
        : 'Legal actions: none (puzzle over).',
    ];
    return {
      text: lines.join('\n'),
      // No `solution`, no `solutionIndex`: the grader-side line stays out of
      // every observation payload. startFen/moves drive the reused baselines.
      data: {
        puzzleId: state.puzzleId,
        rating: state.rating,
        startFen: state.startFen,
        moves: state.moves,
        san: state.san,
        fen: state.fen,
        playerColor: state.playerColor,
        you: seat,
      },
    };
  },

  /**
   * Sorted legal UCI actions for the solving seat; empty for a finished
   * puzzle or a foreign seat.
   *
   * @param {PuzzleState} state
   * @param {number} seat
   * @returns {string[]}
   */
  legalActions(state, seat) {
    return legalActionsOf(state, seat);
  },

  /**
   * Parse UCI or SAN against the current position; canonical output is UCI.
   * Any legal move of the solving side parses — wrong moves are a matter for
   * step(), not the parser.
   *
   * @param {PuzzleState} state
   * @param {number} seat
   * @param {string} text
   * @returns {ParseResult}
   */
  parseAction(state, seat, text) {
    if (state.termination) {
      return { ok: false, error: 'the puzzle is over' };
    }
    if (seat !== 0) {
      return { ok: false, error: `it is not seat ${seat}'s turn` };
    }
    return parseNotationAsAction(replayUci(state.startFen, state.moves), text);
  },

  /**
   * Apply the agent's move. Throws GauntletRuleError for a finished puzzle,
   * a foreign seat, or an illegal/unknown action. A legal move either wins
   * by checkmate, is on the line (continue with the opponent's reply), or
   * ends the episode unsolved.
   *
   * @param {PuzzleState} state
   * @param {number} seat
   * @param {string} action
   * @returns {PuzzleState}
   */
  step(state, seat, action) {
    if (state.termination) {
      throw new GauntletRuleError('the puzzle is over');
    }
    if (seat !== 0) {
      throw new GauntletRuleError(`chess-puzzles is one-seat: seat ${seat} has no turn`);
    }
    if (typeof action !== 'string') {
      throw new GauntletRuleError(`unknown action ${JSON.stringify(action)}`);
    }
    const chessApi = replayUci(state.startFen, state.moves);
    const move = matchUci(chessApi, action);
    if (!move) {
      throw new GauntletRuleError(
        `illegal or unknown action ${JSON.stringify(action)}; the observation lists the legal actions`
      );
    }
    const fast = /** @type {FastChess} */ (/** @type {unknown} */ (chessApi));
    const sanText = fast._moveToSan(move, fast._moves({ legal: true }));
    fast._makeMove(move);
    const moves = [...state.moves, action];
    const san = [...state.san, sanText];
    const base = {
      puzzleId: state.puzzleId,
      rating: state.rating,
      startFen: state.startFen,
      playerColor: state.playerColor,
      solution: state.solution,
    };

    // 1. Chess rules first: checkmate ends the game, whoever's move it was
    // on the line. This is what accepts an alternative mate in one.
    const end = endAfterPly(chessApi, 'agent');
    if (end) {
      return {
        ...base,
        moves,
        san,
        fen: chessApi.fen(),
        solutionIndex: state.solutionIndex + 1,
        termination: end,
      };
    }

    // 2. A legal move that is not the line's next move ends the episode.
    const expected = state.solution[state.solutionIndex];
    if (action !== expected) {
      return {
        ...base,
        moves,
        san,
        fen: chessApi.fen(),
        solutionIndex: state.solutionIndex + 1,
        termination: { type: 'wrong-move', detail: `played ${action}, the line expects ${expected}` },
      };
    }

    // 3. Expected move: if the line ends here, the puzzle is solved.
    const nextIndex = state.solutionIndex + 1;
    if (nextIndex >= state.solution.length) {
      return {
        ...base,
        moves,
        san,
        fen: chessApi.fen(),
        solutionIndex: nextIndex,
        termination: { type: 'solved', detail: 'solution line completed' },
      };
    }

    // 4. Play the opponent's reply from the line.
    const reply = state.solution[nextIndex];
    const replyMove = matchUci(chessApi, reply);
    if (!replyMove) {
      throw new GauntletRuleError(
        `chess-puzzles: puzzle ${state.puzzleId} solution line is corrupt: "${reply}" is not legal after ${action}`
      );
    }
    const replySan = fast._moveToSan(replyMove, fast._moves({ legal: true }));
    fast._makeMove(replyMove);
    const replyEnd = endAfterPly(chessApi, 'opponent');
    return {
      ...base,
      moves: [...moves, reply],
      san: [...san, replySan],
      fen: chessApi.fen(),
      solutionIndex: nextIndex + 1,
      termination: replyEnd,
    };
  },

  /**
   * Outcome of a terminated state, or null while the puzzle runs.
   *
   * @param {PuzzleState} state
   * @returns {Outcome | null}
   */
  outcome(state) {
    const termination = state.termination;
    if (!termination) return null;
    if (termination.type === 'solved') {
      return {
        normalized: [1],
        raw: /** @type {Outcome['raw']} */ (['win']),
        reason: `puzzle ${state.puzzleId} solved: ${termination.detail}`,
      };
    }
    return {
      normalized: [0],
      raw: /** @type {Outcome['raw']} */ (['loss']),
      reason: `puzzle ${state.puzzleId} failed: ${termination.detail}`,
    };
  },

  /**
   * Budget exhaustion: unsolved.
   *
   * @param {PuzzleState} _state
   * @returns {Outcome}
   */
  truncate(_state) {
    return {
      normalized: [0],
      raw: null,
      reason: 'action budget exhausted before the solution line was completed',
    };
  },
};

/**
 * One-seat game: no opponent(). The agent seat is the default 0, so
 * agentSeat() is omitted as well.
 */

/**
 * Build the quality-filter summary the observation rules text and SOURCE.md
 * share, for tooling and tests.
 *
 * @returns {string}
 */
export function qualitySummary() {
  return (
    `RatingDeviation <= ${QUALITY.maxRatingDeviation}, Popularity >= ${QUALITY.minPopularity}, ` +
    `NbPlays >= ${QUALITY.minNbPlays}, player moves <= ${QUALITY.maxPlayerMoves}`
  );
}

/**
 * A demonstration agent that plays the solution line from the state (test
 * and tooling helper, NOT a bundled baseline: it reads grader-side data and
 * would score 100% by construction).
 *
 * @param {string} [id]
 * @returns {Agent}
 */
export function createLinePlayingAgent(id = 'line-player') {
  return {
    id,
    track: /** @type {'baseline'} */ ('baseline'),
    async act(/** @type {import('../../core/types.js').TurnContext} */ ctx) {
      void ctx;
      throw new Error('createLinePlayingAgent reads the game state directly; use playSolutionLine in tests');
    },
  };
}

/**
 * Play the full solution line of a state through the game contract, returning
 * the final state (test helper for the committed-sample replay).
 *
 * @param {Game<PuzzleState>} game
 * @param {TierSpec} tier
 * @param {string} seed
 * @returns {PuzzleState}
 */
export function playSolutionLine(game, tier, seed) {
  let state = game.reset(tier, seed);
  let guard = 0;
  while (game.toAct(state) !== null) {
    guard++;
    if (guard > 32) throw new Error(`playSolutionLine: episode ${seed} does not terminate`);
    const expected = state.solution[state.solutionIndex];
    const legal = game.legalActions(state, 0);
    if (!legal.includes(expected)) {
      throw new Error(`playSolutionLine: expected move "${expected}" is not legal in seed ${seed}`);
    }
    state = game.step(state, 0, expected);
  }
  return state;
}

export default chessPuzzles;
