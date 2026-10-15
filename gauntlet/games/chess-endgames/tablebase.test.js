/**
 * Strict tests for the chess-endgames tablebase. These tables have one right
 * answer: the four maxima must equal the published DTM maxima, and the
 * tables' view of random legal positions must agree with chess.js everywhere
 * the two can be compared.
 *
 * @module
 */

import test from 'node:test';
import { Chess } from 'chess.js';
import { getTablebase, probePosition, squareName } from './tablebase.js';
import { streamFromSeed } from '../../core/rng.js';

/** @import { EndgamePosition } from './tablebase.js' */

/**
 * The FEN piece letter of each kind's pieces, in slot order.
 *
 * @param {string} kind
 * @returns {string[]}
 */
function pieceLetters(kind) {
  switch (kind) {
    case 'kqk':
      return ['Q'];
    case 'krk':
      return ['R'];
    case 'kbbk':
      return ['B', 'B'];
    case 'kbnk':
      return ['B', 'N'];
    default:
      throw new Error(`unknown kind ${kind}`);
  }
}

/**
 * FEN for a probed-legal position.
 *
 * @param {string} kind
 * @param {EndgamePosition} pos
 * @returns {string}
 */
function fenOf(kind, pos) {
  const letters = pieceLetters(kind);
  /** @type {(string | null)[]} */
  const grid = new Array(64).fill(null);
  grid[pos.wk] = 'K';
  grid[pos.bk] = 'k';
  pos.pieces.forEach((sq, i) => {
    grid[sq] = letters[i];
  });
  /** @type {string[]} */
  const ranks = [];
  for (let r = 7; r >= 0; r--) {
    let row = '';
    let empty = 0;
    for (let f = 0; f < 8; f++) {
      const cell = grid[r * 8 + f];
      if (cell === null) {
        empty++;
        continue;
      }
      if (empty > 0) {
        row += String(empty);
        empty = 0;
      }
      row += cell;
    }
    if (empty > 0) row += String(empty);
    ranks.push(row);
  }
  return `${ranks.join('/')} ${pos.side === 0 ? 'w' : 'b'} - - 0 1`;
}

/**
 * Sample a random position of a kind from a seed, kept only when the table
 * itself calls it legal (kings distinct and non-adjacent, pieces placed).
 *
 * @param {string} kind
 * @param {string} seed
 * @returns {EndgamePosition}
 */
function samplePosition(kind, seed) {
  const table = getTablebase(kind);
  const np = table.np;
  const rng = streamFromSeed(seed);
  for (;;) {
    const wk = rng.nextInt(0, 63);
    const bk = rng.nextInt(0, 63);
    if (bk === wk) continue;
    /** @type {number[]} */
    const pieces = [];
    for (let i = 0; i < np; i++) {
      let sq = rng.nextInt(0, 63);
      while (sq === wk || sq === bk || pieces.includes(sq)) {
        sq = rng.nextInt(0, 63);
      }
      pieces.push(sq);
    }
    const side = /** @type {0 | 1} */ (rng.nextInt(0, 1));
    const pos = { wk, bk, pieces, side };
    if (probePosition(kind, pos).legal) return pos;
  }
}

/**
 * Apply a probe move to a position; returns the child (side flipped). The
 * mover is identified by its origin square.
 *
 * @param {EndgamePosition} pos
 * @param {{ from: number, to: number }} m
 * @returns {EndgamePosition}
 */
function applyProbeMove(pos, m) {
  const child = {
    wk: pos.wk,
    bk: pos.bk,
    pieces: pos.pieces.slice(),
    side: pos.side === 0 ? /** @type {1} */ (1) : /** @type {0} */ (0),
  };
  if (m.from === pos.wk) child.wk = m.to;
  else if (m.from === pos.bk) child.bk = m.to;
  else {
    const i = pos.pieces.indexOf(m.from);
    child.pieces[i] = m.to;
  }
  return child;
}

test('kqk table maximum is the published DTM maximum 10', () => {
  assertMax('kqk', 10);
});

test('krk table maximum is the published DTM maximum 16', () => {
  assertMax('krk', 16);
});

test('kbbk table maximum is the published DTM maximum 19', () => {
  assertMax('kbbk', 19);
});

test('kbnk table maximum is the published DTM maximum 33', () => {
  assertMax('kbnk', 33);
});

/**
 * @param {string} kind
 * @param {number} expected
 */
function assertMax(kind, expected) {
  const table = getTablebase(kind);
  if (table.maxDtm !== expected) {
    throw new Error(`${kind}: table maximum ${table.maxDtm} != published ${expected}`);
  }
}

/**
 * The full cross-check for one kind: for 2,000 seeded positions, the table's
 * move set, check state and terminal flags, and DTM descent property must
 * agree with chess.js.
 *
 * @param {string} kind
 * @param {number} expectedMax
 * @returns {void}
 */
function crossCheck(kind, expectedMax) {
  const table = getTablebase(kind);
  if (table.maxDtm !== expectedMax) {
    throw new Error(`${kind}: maximum ${table.maxDtm} != ${expectedMax}`);
  }
  const COUNT = 2000;
  for (let i = 0; i < COUNT; i++) {
    const pos = samplePosition(kind, `chess-endgames-crosscheck/${kind}/${i}`);
    const fen = fenOf(kind, pos);
    const chess = new Chess(fen);
    const probe = probePosition(kind, pos);

    // Terminal agreement: chess.js ends the game exactly when the table lists
    // no moves (checkmate when the mover is in check, stalemate otherwise).
    const tableMate = probe.inCheck && probe.moves.length === 0;
    const tableStalemate = !probe.inCheck && probe.moves.length === 0;
    if (chess.isCheckmate() !== tableMate) {
      throw new Error(`${kind} ${fen}: checkmate disagreement (chess.js ${chess.isCheckmate()}, table ${tableMate})`);
    }
    if (chess.isStalemate() !== tableStalemate) {
      throw new Error(`${kind} ${fen}: stalemate disagreement (chess.js ${chess.isStalemate()}, table ${tableStalemate})`);
    }
    if (!chess.isCheckmate() && !chess.isStalemate() && probe.moves.length === 0) {
      throw new Error(`${kind} ${fen}: non-terminal per chess.js but the table lists no moves`);
    }

    // Check-state agreement.
    if (chess.isCheck() !== probe.inCheck) {
      throw new Error(`${kind} ${fen}: check-state disagreement`);
    }

    // Move-set agreement.
    const uciFromChess = chess
      .moves({ verbose: true })
      .map((m) => m.from + m.to)
      .sort();
    const uciFromTable = probe.moves
      .map((m) => squareName(m.from) + squareName(m.to))
      .sort();
    if (JSON.stringify(uciFromChess) !== JSON.stringify(uciFromTable)) {
      throw new Error(
        `${kind} ${fen}: move sets disagree: chess.js [${uciFromChess}] table [${uciFromTable}]`
      );
    }

    // DTM descent property on non-terminal positions whose children all stay
    // inside the table (captures leave the material set and are skipped):
    // an attacker value d has a child of d-1 and none below; the defender's
    // maximum child equals its own value d (maximum resistance).
    const d = table.dtm(pos);
    if (d === null || probe.moves.length === 0) continue;
    /** @type {number[]} */
    const childValues = [];
    let allInside = true;
    for (const m of probe.moves) {
      const child = applyProbeMove(pos, m);
      const capture = pos.side === 1 && child.bk !== pos.bk && pos.pieces.includes(child.bk);
      if (capture) {
        allInside = false;
        break;
      }
      const cd = table.dtm(child);
      if (cd === null) {
        allInside = false;
        break;
      }
      childValues.push(cd);
    }
    if (!allInside) continue;
    if (pos.side === 0) {
      const best = Math.min(...childValues);
      if (best !== d - 1) {
        throw new Error(`${kind} ${fen}: attacker value ${d} but best child is ${best}, expected ${d - 1}`);
      }
    } else {
      const worst = Math.max(...childValues);
      if (worst !== d) {
        throw new Error(`${kind} ${fen}: defender value ${d} but max child is ${worst}`);
      }
    }
  }
}

test('kqk cross-check: 2000 seeded positions agree with chess.js', () => {
  crossCheck('kqk', 10);
});

test('krk cross-check: 2000 seeded positions agree with chess.js', () => {
  crossCheck('krk', 16);
});

test('kbbk cross-check: 2000 seeded positions agree with chess.js', () => {
  crossCheck('kbbk', 19);
});

test('kbnk cross-check: 2000 seeded positions agree with chess.js', () => {
  crossCheck('kbnk', 33);
});
