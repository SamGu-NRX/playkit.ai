/**
 * Tic-Tac-Toe: the Gauntlet smoke game. Two seats, perfect information, a
 * perfect minimax opponent with seeded tie-breaks, and the agent's seat
 * alternating with the seed. benchmark: false — this game exists to exercise
 * the contract end to end, not to rank agents.
 *
 * @module
 */

import { GauntletRuleError } from '../../core/errors.js';
import { fnv1a64 } from '../../core/canonical.js';
import { nextInt, streamFromSeed } from '../../core/rng.js';

/** @import { Agent, Game, Observation, ParseResult, TierSpec, TurnContext } from '../../core/types.js' */

const COLUMN_LETTERS = ['a', 'b', 'c'];
const MARKS = ['X', 'O'];

/**
 * Canonical cell names, sorted: columns a-c, rows 1-3, row 1 at the top.
 * @type {string[]}
 */
export const CELLS = ['a1', 'a2', 'a3', 'b1', 'b2', 'b3', 'c1', 'c2', 'c3'];

const LINES = [
  [0, 1, 2],
  [3, 4, 5],
  [6, 7, 8],
  [0, 3, 6],
  [1, 4, 7],
  [2, 5, 8],
  [0, 4, 8],
  [2, 4, 6],
];

/**
 * Game state: plain JSON, so it survives a round trip unchanged.
 *
 * @typedef {object} TictactoeState
 * @property {(string | null)[]} board Nine cells, index = row * 3 + column.
 * @property {number} toMove Seat 0 (X) or 1 (O).
 * @property {'playing' | 'won' | 'draw'} status
 * @property {number | null} winner Winning seat, when status is "won".
 * @property {number} moveCount
 */

/**
 * Seat of a mark character.
 *
 * @param {string | null} mark
 * @returns {number | null}
 */
function seatOf(mark) {
  if (mark === null) return null;
  return mark === 'X' ? 0 : 1;
}

/**
 * Canonical name of a board index.
 *
 * @param {number} index
 * @returns {string}
 */
function cellName(index) {
  return COLUMN_LETTERS[index % 3] + String(Math.floor(index / 3) + 1);
}

/**
 * Apply a move to a state, returning a fresh state. Shared by step() and the
 * minimax search.
 *
 * @param {TictactoeState} state
 * @param {number} seat
 * @param {number} index Board index.
 * @returns {TictactoeState}
 */
function applyMove(state, seat, index) {
  const board = state.board.slice();
  board[index] = MARKS[seat];
  let status = /** @type {TictactoeState['status']} */ ('playing');
  let winner = /** @type {number | null} */ (null);
  for (const line of LINES) {
    const [a, b, c] = line;
    if (board[a] !== null && board[a] === board[b] && board[a] === board[c]) {
      status = 'won';
      winner = seatOf(board[a]);
      break;
    }
  }
  if (status === 'playing' && board.every((cell) => cell !== null)) {
    status = 'draw';
  }
  return {
    board,
    toMove: 1 - seat,
    status,
    winner,
    moveCount: state.moveCount + 1,
  };
}

/**
 * Negamax over the full tic-tac-toe tree. The score prefers winning sooner
 * (100 - moveCount) and losing later, so the opponent plays perfectly and
 * delays unavoidable losses. Terminal states must be evaluated by the caller
 * before recursing.
 *
 * @param {TictactoeState} state Non-terminal position.
 * @returns {{ score: number, moves: number[] }} Best score for the seat to
 *   move and the board indices achieving it.
 */
function negamax(state) {
  const me = state.toMove;
  let bestScore = -Infinity;
  /** @type {number[]} */
  const moves = [];
  for (let index = 0; index < 9; index++) {
    if (state.board[index] !== null) continue;
    const child = applyMove(state, me, index);
    let score;
    if (child.status === 'won') {
      score = 100 - child.moveCount; // I win; sooner is better.
    } else if (child.status === 'draw') {
      score = 0;
    } else {
      score = -negamax(child).score;
    }
    if (score > bestScore) {
      bestScore = score;
      moves.length = 0;
      moves.push(index);
    } else if (score === bestScore) {
      moves.push(index);
    }
  }
  return { score: bestScore, moves: moves };
}

export const tictactoe = {
  spec: {
    id: 'tictactoe',
    version: '1.0.0',
    title: 'Tic-Tac-Toe',
    seats: /** @type {1 | 2} */ (2),
    information: /** @type {import('../../core/types.js').InformationMode} */ ('perfect'),
    stochastic: false,
    tags: /** @type {import('../../core/types.js').GameTag[]} */ (['adversarial', 'planning', 'spatial']),
    benchmark: false,
    requires: [],
    rulesText: [
      'Standard 3x3 tic-tac-toe on a board with columns a-c (left to right) and rows 1-3 (top to bottom).',
      'Seat 0 plays X and moves first; seat 1 plays O. Players alternate; a player wins by placing three of their marks in a row, column, or diagonal. A full board with no line is a draw.',
      'Action grammar: name an empty cell as <column><row>, e.g. "a1" is the top-left cell and "c3" the bottom-right.',
      'Documented alternates: "play a1", "place a1", "move a1", "mark a1", uppercase letters, and surrounding quotes or backticks are all accepted.',
      'Playing an occupied or unknown cell is invalid and consumes an action attempt.',
    ].join(' '),
    tiers: /** @type {import('../../core/types.js').TierSpec[]} */ ([
      {
        id: 'perfect-opponent',
        rank: 1,
        scoring: 'outcome',
        maxActions: 20,
        publicSeeds: 8,
        params: { opponent: 'minimax-perfect', tieBreak: 'seeded' },
      },
    ]),
  },

  /**
   * @param {TierSpec} _tier
   * @param {string} _seed
   * @returns {TictactoeState}
   */
  reset(_tier, _seed) {
    return {
      board: new Array(9).fill(null),
      toMove: 0,
      status: 'playing',
      winner: null,
      moveCount: 0,
    };
  },

  /**
   * @param {TictactoeState} state
   * @returns {number | null}
   */
  toAct(state) {
    return state.status === 'playing' ? state.toMove : null;
  },

  /**
   * @param {TictactoeState} state
   * @param {number} seat
   * @returns {Observation}
   */
  observe(state, seat) {
    const you = MARKS[seat];
    const mover = MARKS[state.toMove];
    /** @type {string[]} */
    const rows = [];
    rows.push('    a   b   c');
    for (let row = 0; row < 3; row++) {
      const cells = [0, 1, 2].map((col) => {
        const mark = state.board[row * 3 + col];
        return mark === null ? '.' : mark;
      });
      rows.push(`${row + 1}   ${cells.join('   ')}`);
    }
    const board = rows.join('\n');
    const legal =
      state.status === 'playing'
        ? CELLS.filter((cell) => state.board[cellIndex(cell)] === null)
        : [];
    const statusText =
      state.status === 'playing'
        ? `${mover} to move.`
        : state.status === 'draw'
          ? 'Game over: draw.'
          : `Game over: ${MARKS[/** @type {number} */ (state.winner)]} wins.`;
    const legalText =
      legal.length > 0
        ? `Legal actions (${legal.length}, at most 64 so all are listed): ${legal.join(', ')}`
        : 'Legal actions: none (game over).';
    return {
      text: [
        `Tic-Tac-Toe, tier ${this.spec.tiers[0].id}. You are seat ${seat} (${you}).`,
        board,
        statusText,
        legalText,
      ].join('\n'),
      data: { ...state, you: seat },
    };
  },

  /**
   * @param {TictactoeState} state
   * @param {number} seat
   * @returns {string[]}
   */
  legalActions(state, seat) {
    if (state.status !== 'playing' || seat !== state.toMove) return [];
    return CELLS.filter((cell) => state.board[cellIndex(cell)] === null);
  },

  /**
   * @param {TictactoeState} state
   * @param {number} seat
   * @param {string} text
   * @returns {ParseResult}
   */
  parseAction(state, seat, text) {
    if (state.status !== 'playing') {
      return { ok: false, error: 'the game is over' };
    }
    if (seat !== state.toMove) {
      return { ok: false, error: `it is not seat ${seat}'s turn` };
    }
    let s = String(text).trim();
    // Strip wrapping quotes/backticks.
    if (
      s.length >= 2 &&
      ((s.startsWith('`') && s.endsWith('`')) ||
        (s.startsWith('"') && s.endsWith('"')) ||
        (s.startsWith("'") && s.endsWith("'")))
    ) {
      s = s.slice(1, -1).trim();
    }
    s = s.toLowerCase();
    // Documented alternates: an optional verb before the cell.
    s = s.replace(/^(play|place|move|mark)\s+/, '');
    const match = /^([abc])\s*([123])$/.exec(s);
    if (!match) {
      return {
        ok: false,
        error: `cannot parse ${JSON.stringify(String(text))} as a cell; use <column><row>, e.g. "b2"`,
      };
    }
    const cell = match[1] + match[2];
    const index = cellIndex(cell);
    if (state.board[index] !== null) {
      return { ok: false, error: `cell ${cell} is occupied` };
    }
    return { ok: true, action: cell };
  },

  /**
   * @param {TictactoeState} state
   * @param {number} seat
   * @param {string} action
   * @returns {TictactoeState}
   */
  step(state, seat, action) {
    if (state.status !== 'playing') {
      throw new GauntletRuleError('the game is over');
    }
    if (seat !== state.toMove) {
      throw new GauntletRuleError(`it is seat ${state.toMove}'s turn, not seat ${seat}'s`);
    }
    if (typeof action !== 'string' || !CELLS.includes(action)) {
      throw new GauntletRuleError(`unknown action ${JSON.stringify(action)}`);
    }
    const index = cellIndex(action);
    if (state.board[index] !== null) {
      throw new GauntletRuleError(`cell ${action} is occupied`);
    }
    return applyMove(state, seat, index);
  },

  /**
   * @param {TictactoeState} state
   * @returns {import('../../core/types.js').Outcome | null}
   */
  outcome(state) {
    if (state.status === 'playing') return null;
    const seat0 = seatOf(state.status === 'won' ? MARKS[/** @type {number} */ (state.winner)] : null);
    /** @type {Array<'win' | 'loss' | 'draw'>} */
    let raw;
    /** @type {number[]} */
    let normalized;
    let reason;
    if (state.status === 'draw') {
      raw = ['draw', 'draw'];
      normalized = [0.5, 0.5];
      reason = 'draw: the board filled with no line';
    } else if (seat0 === 0) {
      raw = ['win', 'loss'];
      normalized = [1, 0];
      reason = 'seat 0 (X) won with three in a row';
    } else {
      raw = ['loss', 'win'];
      normalized = [0, 1];
      reason = 'seat 1 (O) won with three in a row';
    }
    return { normalized, raw, reason };
  },

  /**
   * Truncation on this outcome tier assesses the current position under
   * perfect play: a decided position scores as the game would have, an
   * unfinished position scores by its minimax value (a forced win for the
   * mover scores like a win, a forced loss like a loss; only an undecided
   * position scores a draw).
   *
   * @param {TictactoeState} state
   * @returns {import('../../core/types.js').Outcome}
   */
  truncate(state) {
    if (state.status !== 'playing') {
      return /** @type {import('../../core/types.js').Outcome} */ (this.outcome(state));
    }
    const position = negamax(state);
    /** @type {number[]} */
    let normalized;
    let reason;
    if (position.score > 0) {
      const winner = state.toMove;
      normalized = winner === 0 ? [1, 0] : [0, 1];
      reason = `truncated: seat ${winner} (${MARKS[winner]}) has a forced win from the current position`;
    } else if (position.score < 0) {
      const winner = 1 - state.toMove;
      normalized = winner === 0 ? [1, 0] : [0, 1];
      reason = `truncated: seat ${winner} (${MARKS[winner]}) has a forced win from the current position`;
    } else {
      normalized = [0.5, 0.5];
      reason = 'truncated: the position assesses as a drawn game under perfect play';
    }
    return {
      normalized,
      raw: null,
      reason,
    };
  },

  /**
   * The perfect opponent: minimax over the full game tree, with seeded
   * tie-breaks among equally good moves.
   *
   * @param {TierSpec} tier
   * @param {string} seed
   * @param {number} seat
   * @returns {Agent}
   */
  opponent(tier, seed, seat) {
    return {
      id: 'minimax-perfect',
      track: 'baseline',
      async act(ctx) {
        const data = /** @type {TictactoeState & { you?: number }} */ (ctx.observation.data);
        const { moves } = negamax(data);
        if (moves.length === 0) {
          throw new GauntletRuleError('minimax opponent found no legal move');
        }
        const stream = streamFromSeed(`${tier.id}/${seed}/opponent/${seat}/turn${ctx.turn}`);
        const index = moves[nextInt(stream.getState(), 0, moves.length - 1).value];
        return { text: cellName(index) };
      },
    };
  },

  /**
   * The agent's seat alternates with the seed, so it plays both sides across
   * the public seed set.
   *
   * @param {TierSpec} tier
   * @param {string} seed
   * @returns {number}
   */
  agentSeat(tier, seed) {
    return Number(BigInt('0x' + fnv1a64(`${tier.id}/${seed}`)) % 2n);
  },
};

/**
 * @param {string} cell
 * @returns {number}
 */
function cellIndex(cell) {
  const col = COLUMN_LETTERS.indexOf(cell[0]);
  const row = Number(cell[1]) - 1;
  return row * 3 + col;
}

/** @type {Game<TictactoeState>} */
export default tictactoe;
