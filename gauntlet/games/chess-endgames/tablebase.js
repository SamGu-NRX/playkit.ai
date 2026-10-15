/**
 * Self-built distance-to-mate (DTM) tablebases for four pawnless endgames:
 * KQK, KRK, KBBK (bishops on opposite colours) and KBNK. The tables are built
 * lazily, once per process, by retrograde analysis and then kept in memory.
 * Pure JS: no `node:*`, no network, no external tablebases.
 *
 * DTM counts moves by the attacking side (White): a position with DTM `d` and
 * White to move is mate in `d` White moves against any defence. Drawn or
 * unprovable positions report `null`. The published maxima these tables must
 * reproduce are KQK 10, KRK 16, KBBK 19, KBNK 33 (attacker to move); the
 * strict tests assert exactly that.
 *
 * Storage uses the 8-fold symmetry of the pawnless board: every position is
 * stored under its canonical orientation, the one where the white king sits on
 * the lexicographically smallest square of its symmetry orbit (10 squares).
 * Each side-to-move table is therefore a dense typed array of
 * `10 * 64^pieces` bytes; kqk/krk use 40,960 bytes per side, kbbk/kbnk
 * 2,621,440 per side. Byte encoding: 0 mate, 1..60 DTM in attacker moves,
 * 254 drawn/unprovable, 255 illegal.
 *
 * Squares are 0..63 with `square = rank * 8 + file` (a1 = 0, h1 = 7,
 * a8 = 56, h8 = 63).
 *
 * @module
 */

const V_DRAW = 254;
const V_ILLEGAL = 255;

/**
 * @typedef {'q' | 'r' | 'b' | 'n'} PieceType
 */

/**
 * @typedef {object} EndgamePosition
 * @property {number} wk White king square.
 * @property {number} bk Black king square.
 * @property {number[]} pieces White non-king piece squares, in the kind's
 *   piece order (for kbbk the two bishops in any order; values are equal).
 * @property {0 | 1} side 0 = White (attacker) to move, 1 = Black to move.
 */

/**
 * @typedef {object} ProbeMove
 * @property {number} from
 * @property {number} to
 */

/**
 * @typedef {object} PositionProbe
 * @property {boolean} legal
 * @property {boolean} inCheck True when the side to move is in check
 *   (Black can be in check; White never is in these endings).
 * @property {ProbeMove[]} moves Legal moves of the side to move.
 */

/**
 * @typedef {object} TablebaseStats
 * @property {number} legalPositions
 * @property {number} reverseEdges
 * @property {number} valueBytes
 * @property {number} buildMs Wall-clock build time, metadata only — it never
 *   feeds game state.
 */

/**
 * @typedef {object} Tablebase
 * @property {string} kind
 * @property {number} np Number of white non-king pieces.
 * @property {number} maxDtm Maximum DTM over legal White-to-move positions.
 * @property {TablebaseStats} stats
 * @property {(pos: EndgamePosition) => number | null} dtm DTM in attacker
 *   moves for the side to move, or null when drawn/unprovable/illegal.
 */

/**
 * The four endgames. `pieces` fixes the piece order used for indexing.
 *
 * @type {Record<string, { pieces: PieceType[] }>}
 */
const KINDS = {
  kqk: { pieces: ['q'] },
  krk: { pieces: ['r'] },
  kbbk: { pieces: ['b', 'b'] },
  kbnk: { pieces: ['b', 'n'] },
};

/**
 * @param {string} kindId
 * @returns {{ pieces: PieceType[], np: number }}
 */
function kindOf(kindId) {
  const kind = KINDS[kindId];
  if (!kind) throw new Error(`unknown endgame kind "${kindId}"`);
  return { pieces: kind.pieces, np: kind.pieces.length };
}

// ---------------------------------------------------------------------------
// Geometry (shared by all four tables).
// ---------------------------------------------------------------------------

/** @type {Int32Array[]} */
const KING_MOVES = [];
/** @type {Int32Array[]} */
const KNIGHT_MOVES = [];
/** RAYS[sq * 8 + dir] lists the squares from `sq` outward along `dir`. */
/** @type {Int32Array[]} */
const RAYS = [];
const KING_ATT = new Uint8Array(64 * 64);
const KNIGHT_ATT = new Uint8Array(64 * 64);
const ROOK_ALIGNED = new Uint8Array(64 * 64);
const BISHOP_ALIGNED = new Uint8Array(64 * 64);
const QUEEN_ALIGNED = new Uint8Array(64 * 64);
/** Strictly-between squares of any aligned pair, as a 64-bit-style bitmask
 *  split into two 32-bit halves (low = squares 0..31). */
const BETWEEN_LO = new Uint32Array(64 * 64);
const BETWEEN_HI = new Uint32Array(64 * 64);

const DIRS = [
  [1, 0], [-1, 0], [0, 1], [0, -1], // rook directions
  [1, 1], [1, -1], [-1, 1], [-1, -1], // bishop directions
];

(function buildGeometry() {
  for (let sq = 0; sq < 64; sq++) {
    const f = sq & 7;
    const r = sq >> 3;
    /** @type {number[]} */
    const km = [];
    /** @type {number[]} */
    const nm = [];
    for (let df = -1; df <= 1; df++) {
      for (let dr = -1; dr <= 1; dr++) {
        if (df === 0 && dr === 0) continue;
        const nf = f + df;
        const nr = r + dr;
        if (nf < 0 || nf > 7 || nr < 0 || nr > 7) continue;
        const t = nr * 8 + nf;
        km.push(t);
        KING_ATT[sq * 64 + t] = 1;
      }
    }
    const knightDeltas = [
      [1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2],
    ];
    for (const [df, dr] of knightDeltas) {
      const nf = f + df;
      const nr = r + dr;
      if (nf < 0 || nf > 7 || nr < 0 || nr > 7) continue;
      nm.push(nr * 8 + nf);
      KNIGHT_ATT[sq * 64 + (nr * 8 + nf)] = 1;
    }
    KING_MOVES.push(Int32Array.from(km));
    KNIGHT_MOVES.push(Int32Array.from(nm));
    for (let d = 0; d < 8; d++) {
      const df = DIRS[d][0];
      const dr = DIRS[d][1];
      /** @type {number[]} */
      const ray = [];
      let nf = f + df;
      let nr = r + dr;
      while (nf >= 0 && nf < 8 && nr >= 0 && nr < 8) {
        ray.push(nr * 8 + nf);
        nf += df;
        nr += dr;
      }
      RAYS.push(Int32Array.from(ray));
    }
  }
  for (let a = 0; a < 64; a++) {
    for (let b = 0; b < 64; b++) {
      if (a === b) continue;
      const df = (b & 7) - (a & 7);
      const dr = (b >> 3) - (a >> 3);
      if (df !== 0 && dr !== 0 && Math.abs(df) !== Math.abs(dr)) continue;
      const sf = Math.sign(df);
      const sr = Math.sign(dr);
      let f = (a & 7) + sf;
      let r = (a >> 3) + sr;
      while (f !== (b & 7) || r !== (b >> 3)) {
        const s = r * 8 + f;
        if (s < 32) BETWEEN_LO[a * 64 + b] |= 1 << s;
        else BETWEEN_HI[a * 64 + b] |= 1 << (s - 32);
        f += sf;
        r += sr;
      }
      QUEEN_ALIGNED[a * 64 + b] = 1;
      if (df === 0 || dr === 0) ROOK_ALIGNED[a * 64 + b] = 1;
      else BISHOP_ALIGNED[a * 64 + b] = 1;
    }
  }
})();

// ---------------------------------------------------------------------------
// 8-fold symmetry: canonical orientation has the white king on the
// lexicographically smallest square of its orbit.
// ---------------------------------------------------------------------------

/** @type {((f: number, r: number) => [number, number])[]} */
const TRANSFORMS = [
  (f, r) => [f, r],
  (f, r) => [r, 7 - f],
  (f, r) => [7 - f, 7 - r],
  (f, r) => [7 - r, f],
  (f, r) => [7 - f, r],
  (f, r) => [f, 7 - r],
  (f, r) => [r, f],
  (f, r) => [7 - r, 7 - f],
];

const SQ_T = new Uint8Array(8 * 64);
for (let t = 0; t < 8; t++) {
  for (let sq = 0; sq < 64; sq++) {
    const tr = TRANSFORMS[t](sq & 7, sq >> 3);
    SQ_T[t * 64 + sq] = tr[1] * 8 + tr[0];
  }
}

const ORBIT_MIN = new Uint8Array(64);
for (let sq = 0; sq < 64; sq++) {
  let m = 255;
  for (let t = 0; t < 8; t++) {
    const s = SQ_T[t * 64 + sq];
    if (s < m) m = s;
  }
  ORBIT_MIN[sq] = m;
}

/** Squares that are the minimum of their orbit: exactly 10 representatives. */
/** @type {number[]} */
const TRI_SQUARES = [];
for (let sq = 0; sq < 64; sq++) {
  if (ORBIT_MIN[sq] === sq) TRI_SQUARES.push(sq);
}
if (TRI_SQUARES.length !== 10) {
  throw new Error(`symmetry broken: ${TRI_SQUARES.length} orbit representatives`);
}

const TRI_INDEX = new Int8Array(64).fill(-1);
TRI_SQUARES.forEach((sq, i) => {
  TRI_INDEX[sq] = i;
});

/** For each white king square, the transforms that map it to its orbit
 *  minimum (1 or 2 transforms). Canonicalisation only needs these. */
/** @type {Int32Array[]} */
const CANON_TS = [];
for (let sq = 0; sq < 64; sq++) {
  /** @type {number[]} */
  const ts = [];
  for (let t = 0; t < 8; t++) {
    if (SQ_T[t * 64 + sq] === ORBIT_MIN[sq]) ts.push(t);
  }
  CANON_TS.push(Int32Array.from(ts));
}

/**
 * Canonical packed index of a position's piece placement (no side).
 *
 * @param {number} np
 * @param {number} wk
 * @param {number} bk
 * @param {number} p1
 * @param {number} p2 Second piece square, ignored when np === 1.
 * @returns {number}
 */
function canonicalPieceIndex(np, wk, bk, p1, p2) {
  const ts = CANON_TS[wk];
  const tri = TRI_INDEX[ORBIT_MIN[wk]];
  let best = 0;
  for (let i = 0; i < ts.length; i++) {
    const t = ts[i] * 64;
    const bk2 = SQ_T[t + bk];
    const a2 = SQ_T[t + p1];
    const j =
      np === 1
        ? (tri * 64 + bk2) * 64 + a2
        : ((tri * 64 + bk2) * 64 + a2) * 64 + SQ_T[t + p2];
    if (i === 0 || j < best) best = j;
  }
  return best;
}

/**
 * Combined canonical index (side to move included).
 *
 * @param {number} np
 * @param {number} sideSize
 * @param {number} wk
 * @param {number} bk
 * @param {number} p1
 * @param {number} p2
 * @param {0 | 1} side
 * @returns {number}
 */
function canonicalIndex(np, sideSize, wk, bk, p1, p2, side) {
  return side * sideSize + canonicalPieceIndex(np, wk, bk, p1, p2);
}

// ---------------------------------------------------------------------------
// Attack tests.
// ---------------------------------------------------------------------------

/**
 * Does a white sliding piece on `q` attack `t`? Blockers are the occupied
 * squares strictly between (at most the white king and one other white
 * piece); -1 means absent.
 *
 * @param {PieceType} type
 * @param {number} q
 * @param {number} t
 * @param {number} b1
 * @param {number} b2
 * @returns {boolean}
 */
function sliderAttacks(type, q, t, b1, b2) {
  const aligned =
    type === 'r' ? ROOK_ALIGNED : type === 'b' ? BISHOP_ALIGNED : QUEEN_ALIGNED;
  if (!aligned[q * 64 + t]) return false;
  let lo = BETWEEN_LO[q * 64 + t];
  let hi = BETWEEN_HI[q * 64 + t];
  while (lo !== 0) {
    const s = 31 - Math.clz32(lo & -lo);
    if (s === b1 || s === b2) return false;
    lo ^= lo & -lo;
  }
  while (hi !== 0) {
    const s = 32 + (31 - Math.clz32(hi & -hi));
    if (s === b1 || s === b2) return false;
    hi ^= hi & -hi;
  }
  return true;
}

/**
 * @param {PieceType} type
 * @param {number} q
 * @param {number} t
 * @param {number} b1
 * @param {number} b2
 * @returns {boolean}
 */
function pieceAttacks(type, q, t, b1, b2) {
  if (type === 'n') return KNIGHT_ATT[q * 64 + t] === 1;
  return sliderAttacks(type, q, t, b1, b2);
}

/**
 * Is the black king on `bk` attacked by a white piece (not the white king,
 * whose adjacency the caller tests)? Captured pieces are marked gone.
 *
 * @param {PieceType[]} pieces
 * @param {number} wk
 * @param {number} bk
 * @param {number} p1
 * @param {number} p2
 * @param {boolean} p1Gone
 * @param {boolean} p2Gone
 * @returns {boolean}
 */
function blackKingAttacked(pieces, wk, bk, p1, p2, p1Gone, p2Gone) {
  const two = pieces.length === 2;
  if (!p1Gone && pieceAttacks(pieces[0], p1, bk, wk, two && !p2Gone ? p2 : -1)) {
    return true;
  }
  if (two && !p2Gone && pieceAttacks(pieces[1], p2, bk, wk, p1Gone ? -1 : p1)) {
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Move generation. `onMove(cwk, cbk, cp1, cp2, captureAll)` receives child
// tuples; for Black's moves `captureAll` marks a capture of white material,
// which leaves this endgame's index space and is a terminal draw.
// ---------------------------------------------------------------------------

/**
 * @param {{ pieces: PieceType[], np: number }} kind
 * @param {number} wk
 * @param {number} bk
 * @param {number} p1
 * @param {number} p2 -1 when np === 1.
 * @param {(cwk: number, cbk: number, cp1: number, cp2: number) => void} onMove
 */
function genWhiteMoves(kind, wk, bk, p1, p2, onMove) {
  const [t1, t2] = kind.pieces;
  for (let i = 0; i < KING_MOVES[wk].length; i++) {
    const t = KING_MOVES[wk][i];
    if (t === bk || t === p1 || t === p2) continue;
    if (KING_ATT[t * 64 + bk]) continue;
    onMove(t, bk, p1, p2);
  }
  if (t1 === 'n') {
    const moves = KNIGHT_MOVES[p1];
    for (let i = 0; i < moves.length; i++) {
      const t = moves[i];
      if (t === wk || t === bk || t === p2) continue;
      onMove(wk, bk, t, p2);
    }
  } else {
    const dirs = t1 === 'r' ? 4 : t1 === 'b' ? 4 : 8;
    const dir0 = t1 === 'b' ? 4 : 0;
    for (let d = dir0; d < dir0 + dirs; d++) {
      const ray = RAYS[p1 * 8 + d];
      for (let i = 0; i < ray.length; i++) {
        const s = ray[i];
        if (s === wk || s === p2) break;
        if (s === bk) break;
        onMove(wk, bk, s, p2);
      }
    }
  }
  if (kind.np === 2) {
    if (t2 === 'n') {
      const moves = KNIGHT_MOVES[p2];
      for (let i = 0; i < moves.length; i++) {
        const t = moves[i];
        if (t === wk || t === bk || t === p1) continue;
        onMove(wk, bk, p1, t);
      }
    } else {
      // Piece 2 is the second bishop in kbbk, the knight being handled above
      // only when it is piece 2 in kbnk — bishops slide.
      for (let d = 4; d < 8; d++) {
        const ray = RAYS[p2 * 8 + d];
        for (let i = 0; i < ray.length; i++) {
          const s = ray[i];
          if (s === wk || s === p1) break;
          if (s === bk) break;
          onMove(wk, bk, p1, s);
        }
      }
    }
  }
}

/**
 * @param {{ pieces: PieceType[], np: number }} kind
 * @param {number} wk
 * @param {number} bk
 * @param {number} p1
 * @param {number} p2
 * @param {(cwk: number, cbk: number, cp1: number, cp2: number, captureAll: boolean) => void} onMove
 */
function genBlackMoves(kind, wk, bk, p1, p2, onMove) {
  const [t1, t2] = kind.pieces;
  const two = kind.np === 2;
  for (let i = 0; i < KING_MOVES[bk].length; i++) {
    const t = KING_MOVES[bk][i];
    if (t === wk || KING_ATT[t * 64 + wk]) continue;
    const c1 = t === p1;
    const c2 = two && t === p2;
    const attacked =
      (!c1 && pieceAttacks(t1, p1, t, wk, c2 || !two ? -1 : p2)) ||
      (two && !c2 && pieceAttacks(t2, p2, t, wk, c1 ? -1 : p1));
    if (attacked) continue;
    onMove(wk, t, c1 ? -1 : p1, c2 ? -1 : p2, c1 || c2);
  }
}

// ---------------------------------------------------------------------------
// Retrograde build.
// ---------------------------------------------------------------------------

/**
 * Build the DTM table for one endgame kind.
 *
 * @param {string} kindId
 * @returns {Tablebase & { values: Uint8Array, sideSize: number }}
 */
function buildTablebase(kindId) {
  const kind = kindOf(kindId);
  const np = kind.np;
  const sideSize = np === 1 ? 10 * 64 * 64 : 10 * 64 * 64 * 64;
  const total = 2 * sideSize;
  const startedMs = Date.now();

  const values = new Uint8Array(total);
  const counters = new Uint8Array(total);
  const revCount = new Uint32Array(total + 1);
  /** @type {number[]} */
  const mates = [];
  let legalPositions = 0;

  /** Mutable cursor shared with the move callbacks (no per-call closures). */
  const cur = { side: 0, wk: 0, bk: 0, p1: 0, p2: -1, moves: 0, combined: 0 };

  /**
   * @param {number} cwk
   * @param {number} cbk
   * @param {number} cp1
   * @param {number} cp2
   * @param {boolean} [captureAll]
   */
  function countCb(cwk, cbk, cp1, cp2, captureAll) {
    cur.moves++;
    if (captureAll) return;
    revCount[canonicalIndex(np, sideSize, cwk, cbk, cp1, cp2, cur.side === 0 ? 1 : 0)]++;
  }

  // Pass 1: legality, move counts, mates, reverse-edge counts.
  for (let side = 0; side <= 1; side++) {
    cur.side = side;
    for (let tri = 0; tri < TRI_SQUARES.length; tri++) {
      const wk = TRI_SQUARES[tri];
      cur.wk = wk;
      for (let bk = 0; bk < 64; bk++) {
        if (KING_ATT[wk * 64 + bk]) continue;
        cur.bk = bk;
        for (let p1 = 0; p1 < 64; p1++) {
          if (p1 === wk || p1 === bk) continue;
          const p2Max = np === 2 ? 64 : 1;
          for (let p2 = 0; p2 < p2Max; p2++) {
            if (np === 2 && (p2 === wk || p2 === bk || p2 === p1)) continue;
            const pp2 = np === 2 ? p2 : -1;
            cur.p1 = p1;
            cur.p2 = pp2;
            const idx =
              np === 1
                ? (tri * 64 + bk) * 64 + p1
                : ((tri * 64 + bk) * 64 + p1) * 64 + p2;
            const combined = side * sideSize + idx;
            if (side === 0 && blackKingAttacked(kind.pieces, wk, bk, p1, pp2, false, false)) {
              values[combined] = V_ILLEGAL;
              continue;
            }
            legalPositions++;
            cur.moves = 0;
            if (side === 0) genWhiteMoves(kind, wk, bk, p1, pp2, countCb);
            else genBlackMoves(kind, wk, bk, p1, pp2, countCb);
            counters[combined] = cur.moves;
            if (side === 1 && cur.moves === 0 && blackKingAttacked(kind.pieces, wk, bk, p1, pp2, false, false)) {
              values[combined] = 0; // checkmate
              mates.push(combined);
              // else stalemate: stays V_DRAW forever, which is correct.
            } else {
              values[combined] = V_DRAW;
            }
          }
        }
      }
    }
  }

  // Prefix sums -> reverse offsets.
  const revOffsets = new Uint32Array(total + 1);
  let acc = 0;
  for (let i = 0; i < total; i++) {
    revOffsets[i] = acc;
    acc += revCount[i];
  }
  revOffsets[total] = acc;
  const revEdges = new Int32Array(acc);
  for (let i = 0; i < total; i++) revCount[i] = revOffsets[i]; // reuse as fill cursor

  /**
   * @param {number} cwk
   * @param {number} cbk
   * @param {number} cp1
   * @param {number} cp2
   * @param {boolean} [captureAll]
   */
  function fillCb(cwk, cbk, cp1, cp2, captureAll) {
    if (captureAll) return;
    const child = canonicalIndex(np, sideSize, cwk, cbk, cp1, cp2, cur.side === 0 ? 1 : 0);
    revEdges[revCount[child]++] = cur.combined;
  }

  // Pass 2: fill reverse edges.
  for (let side = 0; side <= 1; side++) {
    cur.side = side;
    for (let tri = 0; tri < TRI_SQUARES.length; tri++) {
      const wk = TRI_SQUARES[tri];
      cur.wk = wk;
      for (let bk = 0; bk < 64; bk++) {
        if (wk === bk || KING_ATT[wk * 64 + bk]) continue;
        cur.bk = bk;
        for (let p1 = 0; p1 < 64; p1++) {
          if (p1 === wk || p1 === bk) continue;
          const p2Max = np === 2 ? 64 : 1;
          for (let p2 = 0; p2 < p2Max; p2++) {
            if (np === 2 && (p2 === wk || p2 === bk || p2 === p1)) continue;
            const pp2 = np === 2 ? p2 : -1;
            cur.p1 = p1;
            cur.p2 = pp2;
            if (side === 0 && blackKingAttacked(kind.pieces, wk, bk, p1, pp2, false, false)) {
              continue;
            }
            const idx =
              np === 1
                ? (tri * 64 + bk) * 64 + p1
                : ((tri * 64 + bk) * 64 + p1) * 64 + p2;
            cur.combined = side * sideSize + idx;
            if (side === 0) genWhiteMoves(kind, wk, bk, p1, pp2, fillCb);
            else genBlackMoves(kind, wk, bk, p1, pp2, fillCb);
          }
        }
      }
    }
  }

  // Layered retrograde from the mates. White-to-move values finalise on the
  // first (smallest) finalised defender child; defender values finalise when
  // the last child finalises, which is the largest.
  let current = mates;
  while (current.length > 0) {
    /** @type {number[]} */
    const next = [];
    for (let i = 0; i < current.length; i++) {
      const x = current[i];
      const v = values[x];
      const from = revOffsets[x];
      const to = revOffsets[x + 1];
      if (x >= sideSize) {
        // Defender position finalised at v: attacker parents get v + 1.
        for (let e = from; e < to; e++) {
          const p = revEdges[e];
          if (values[p] !== V_DRAW) continue;
          values[p] = v + 1;
          next.push(p);
        }
      } else {
        // Attacker position finalised at v: defender parents whose every
        // child is finalised get v (the last child carries the maximum).
        for (let e = from; e < to; e++) {
          const q = revEdges[e];
          if (values[q] !== V_DRAW) continue;
          if (--counters[q] === 0) {
            values[q] = v;
            next.push(q);
          }
        }
      }
    }
    current = next;
  }

  let maxDtm = 0;
  for (let i = 0; i < sideSize; i++) {
    const v = values[i];
    if (v < 60 && v > maxDtm) maxDtm = v;
  }

  return {
    kind: kindId,
    np,
    maxDtm,
    values,
    sideSize,
    stats: {
      legalPositions,
      reverseEdges: acc,
      valueBytes: total,
      buildMs: Date.now() - startedMs,
    },
    dtm(pos) {
      return dtmLookup(values, sideSize, np, pos);
    },
  };
}

/**
 * @param {Uint8Array} values
 * @param {number} sideSize
 * @param {number} np
 * @param {EndgamePosition} pos
 * @returns {number | null}
 */
function dtmLookup(values, sideSize, np, pos) {
  const p1 = pos.pieces[0];
  const p2 = np === 2 ? (pos.pieces.length > 1 ? pos.pieces[1] : -1) : -1;
  const combined = canonicalIndex(np, sideSize, pos.wk, pos.bk, p1, p2, pos.side);
  const v = values[combined];
  return v >= V_DRAW ? null : v;
}

/** Built-table cache: lazy, once per process per kind. */
const cache = new Map();

/**
 * Get (building on first use) the tablebase for an endgame kind.
 *
 * @param {string} kindId 'kqk' | 'krk' | 'kbbk' | 'kbnk'
 * @returns {Tablebase}
 */
export function getTablebase(kindId) {
  const cached = cache.get(kindId);
  if (cached) return cached;
  const built = buildTablebase(kindId);
  cache.set(kindId, built);
  return built;
}

/**
 * Legal moves and check status of a raw position, without needing a built
 * table. Used by the strict tests against chess.js.
 *
 * @param {string} kindId
 * @param {EndgamePosition} pos
 * @returns {PositionProbe}
 */
export function probePosition(kindId, pos) {
  const kind = kindOf(kindId);
  const np = kind.np;
  const p1 = pos.pieces[0];
  const p2 = np === 2 ? (pos.pieces.length > 1 ? pos.pieces[1] : -1) : -1;
  const { wk, bk, side } = pos;
  /** @type {ProbeMove[]} */
  const moves = [];
  const illegal =
    p1 < 0 ||
    p1 > 63 ||
    wk === bk ||
    p1 === wk ||
    p1 === bk ||
    (np === 2 && (p2 === wk || p2 === bk || p2 === p1)) ||
    KING_ATT[wk * 64 + bk] === 1 ||
    (side === 0 && blackKingAttacked(kind.pieces, wk, bk, p1, p2, false, false));
  if (illegal) {
    return { legal: false, inCheck: false, moves };
  }
  const inCheck = side === 1 && blackKingAttacked(kind.pieces, wk, bk, p1, p2, false, false);
  if (side === 0) {
    genWhiteMoves(kind, wk, bk, p1, p2, (cwk, cbk, cp1, cp2) => {
      if (cwk !== wk) moves.push({ from: wk, to: cwk });
      else if (cp1 !== p1) moves.push({ from: p1, to: cp1 });
      else moves.push({ from: p2, to: cp2 });
      void cbk;
      void cp1;
      void cp2;
    });
  } else {
    genBlackMoves(kind, wk, bk, p1, p2, (cwk, cbk, cp1, cp2, captureAll) => {
      void captureAll;
      moves.push({ from: bk, to: cbk });
      void cwk;
      void cp1;
      void cp2;
    });
  }
  return { legal: true, inCheck, moves };
}

// ---------------------------------------------------------------------------
// Square and FEN helpers (shared by the game, baselines and tests).
// ---------------------------------------------------------------------------

/**
 * @param {number} sq
 * @returns {string}
 */
export function squareName(sq) {
  return String.fromCharCode(97 + (sq & 7)) + String((sq >> 3) + 1);
}

/**
 * @param {string} name Two-character algebraic name, e.g. "e4".
 * @returns {number}
 */
export function squareFromName(name) {
  const file = name.charCodeAt(0) - 97;
  const rank = name.charCodeAt(1) - 49;
  if (file < 0 || file > 7 || rank < 0 || rank > 7) {
    throw new Error(`bad square name ${JSON.stringify(name)}`);
  }
  return rank * 8 + file;
}

/**
 * Parse a FEN piece-placement field into an endgame position.
 *
 * @param {string} kindId
 * @param {string} placement e.g. "k7/8/1K6/8/8/8/8/7Q".
 * @param {0 | 1} side
 * @returns {EndgamePosition}
 */
export function positionFromPlacement(kindId, placement, side) {
  const kind = kindOf(kindId);
  if (placement.split('/').length !== 8) {
    throw new Error(`placement must have 8 ranks: ${JSON.stringify(placement)}`);
  }
  /** @type {{ sq: number, ch: string }[]} */
  const typedPieces = [];
  let wk = -1;
  let bk = -1;
  let rank = 7;
  let file = 0;
  for (const ch of placement) {
    if (ch === '/') {
      rank--;
      file = 0;
      continue;
    }
    if (ch >= '1' && ch <= '8') {
      file += Number(ch);
      continue;
    }
    const sq = rank * 8 + file;
    if (ch === 'K') wk = sq;
    else if (ch === 'k') bk = sq;
    else typedPieces.push({ sq, ch: ch.toLowerCase() });
    file++;
  }
  if (wk < 0 || bk < 0 || typedPieces.length !== kind.np) {
    throw new Error(
      `not a ${kindId} placement: ${JSON.stringify(placement)}`
    );
  }
  if (kind.np === 2 && kind.pieces[0] !== kind.pieces[1]) {
    // Mixed piece types: order by the kind's type sequence — the table
    // indexes slot 0 as `kind.pieces[0]` (e.g. the kbnk bishop).
    typedPieces.sort(
      (a, b) =>
        kind.pieces.indexOf(/** @type {PieceType} */ (a.ch)) -
        kind.pieces.indexOf(/** @type {PieceType} */ (b.ch))
    );
  }
  return {
    wk,
    bk,
    pieces: typedPieces.map((x) => x.sq),
    side,
  };
}

/**
 * DTM in attacker moves for the side to move, or null when drawn,
 * unprovable or illegal.
 *
 * @param {Tablebase} table
 * @param {EndgamePosition} pos
 * @returns {number | null}
 */
export function dtm(table, pos) {
  return table.dtm(pos);
}

