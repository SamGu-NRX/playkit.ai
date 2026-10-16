/**
 * Self-built distance-to-mate (DTM) tablebases for the four pawnless endings
 * the chess-endgames game uses: KQK, KRK, KBBK (bishops on opposite colours)
 * and KBNK. DTM is counted in the attacker's (White's) moves, including the
 * mating move: a position where White mates in one has DTM 1; a position with
 * Black to move that is already checkmate has DTM 0.
 *
 * The tables are built by retrograde analysis, in this module, from scratch:
 * there is no shipped data file and no external service. Positions are
 * indexed by their canonical representative under the 8-fold symmetry group of
 * the board (identity, the two mirror reflections, the two diagonal
 * reflections and the two rotations), so every physical position shares one
 * stored value with its symmetric images. Values live in Uint8Arrays.
 *
 * Value encoding in `dtm` (indexed by canonicalEncoding * 2 + sideToMove):
 * - 0          Black to move and already checkmated (zero White moves needed).
 * - 1..200     DTM in White moves from here.
 * - 255        No forced mate for White: a draw by best defence (stalemate,
 *              insufficient material after a capture, the defender escaping,
 *              same-coloured bishops in KBBK) or a position that cannot occur
 *              (kings adjacent, overlapping pieces). Both are draws for the
 *              purposes of probing.
 *
 * The build is lazy and runs once per process per endgame; the value arrays
 * are then kept in memory (about 65 MiB for all four). Pure JS, no `node:*`.
 *
 * @module
 */

/** Endgame ids, in tier order. */
export const ENDGAME_IDS = /** @type {const} */ (['kqk', 'krk', 'kbbk', 'kbnk']);

/**
 * Material of each endgame. `attackers` are White's non-king pieces in fixed
 * identity order; `identicalPair` marks KBBK, whose two bishops are the same
 * piece type and therefore get square-sorted in the canonical encoding.
 *
 * @type {Record<string, { attackers: string[], pieces: 3 | 4, identicalPair: boolean }>}
 */
const ENDGAME_SPECS = {
  kqk: { attackers: ['q'], pieces: 3, identicalPair: false },
  krk: { attackers: ['r'], pieces: 3, identicalPair: false },
  kbbk: { attackers: ['b', 'b'], pieces: 4, identicalPair: true },
  kbnk: { attackers: ['b', 'n'], pieces: 4, identicalPair: false },
};

/**
 * @param {string} endgameId
 * @returns {{ attackers: string[], pieces: 3 | 4, identicalPair: boolean }}
 */
function specOf(endgameId) {
  const spec = ENDGAME_SPECS[endgameId];
  if (!spec) {
    throw new Error(`unknown endgame "${endgameId}" (known: ${ENDGAME_IDS.join(', ')})`);
  }
  return spec;
}

/* ------------------------------------------------------------------ *
 * Geometry: precomputed attack and ray tables over 0..63 squares
 * (a1 = 0, h1 = 7, a8 = 56, h8 = 63; square = rank * 8 + file).
 * ------------------------------------------------------------------ */

/** @type {number[][]} King neighbourhoods. */
const KING_ATT = [];
/** @type {number[][]} Knight jumps. */
const KNIGHT_ATT = [];
/**
 * Rays: RAYS[d][sq] walks outward from sq in direction d until the board edge.
 * Directions 0-3 are orthogonal (rook-like), 4-7 diagonal (bishop-like).
 * @type {number[][][]}
 */
const RAYS = [];

(function initGeometry() {
  for (let sq = 0; sq < 64; sq++) {
    const r = sq >> 3;
    const f = sq & 7;
    /** @type {number[]} */
    const king = [];
    /** @type {number[]} */
    const knight = [];
    for (let dr = -1; dr <= 1; dr++) {
      for (let df = -1; df <= 1; df++) {
        if (dr === 0 && df === 0) continue;
        const nr = r + dr;
        const nf = f + df;
        if (nr >= 0 && nr < 8 && nf >= 0 && nf < 8) king.push(nr * 8 + nf);
      }
    }
    for (const [dr, df] of [
      [1, 2],
      [2, 1],
      [2, -1],
      [1, -2],
      [-1, -2],
      [-2, -1],
      [-2, 1],
      [-1, 2],
    ]) {
      const nr = r + dr;
      const nf = f + df;
      if (nr >= 0 && nr < 8 && nf >= 0 && nf < 8) knight.push(nr * 8 + nf);
    }
    KING_ATT.push(king);
    KNIGHT_ATT.push(knight);
  }
  const STEPS = /** @type {const} */ ([
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
    [1, 1],
    [1, -1],
    [-1, 1],
    [-1, -1],
  ]);
  for (const [dr, df] of STEPS) {
    /** @type {number[][]} */
    const dirRays = [];
    for (let sq = 0; sq < 64; sq++) {
      const r = sq >> 3;
      const f = sq & 7;
      /** @type {number[]} */
      const ray = [];
      let nr = r + dr;
      let nf = f + df;
      while (nr >= 0 && nr < 8 && nf >= 0 && nf < 8) {
        ray.push(nr * 8 + nf);
        nr += dr;
        nf += df;
      }
      dirRays.push(ray);
    }
    RAYS.push(dirRays);
  }
})();

/**
 * @param {number} a
 * @param {number} b
 * @returns {boolean}
 */
function squaresAdjacent(a, b) {
  if (a === b) return false;
  const dr = Math.abs((a >> 3) - (b >> 3));
  const df = Math.abs((a & 7) - (b & 7));
  return dr <= 1 && df <= 1;
}

/**
 * @param {number[]} arr
 * @param {number} sq
 * @returns {boolean}
 */
function listHas(arr, sq) {
  for (let i = 0; i < arr.length; i++) {
    if (arr[i] === sq) return true;
  }
  return false;
}

/**
 * Is `sq` attacked by White in the position (white king `wk`, attackers `a1`
 * of type `t1` and optionally `a2` of type `t2`)? `ignore` removes one
 * attacker square first (the piece Black is about to capture). Sliders are
 * blocked by any standing piece, including the White king.
 *
 * @param {number} sq
 * @param {number} wk
 * @param {number} a1
 * @param {string} t1
 * @param {number} a2 -1 when the endgame has one attacker.
 * @param {string} t2 Ignored when a2 is -1.
 * @param {number} [ignore]
 * @returns {boolean}
 */
function attackedByWhite(sq, wk, a1, t1, a2, t2, ignore = -1) {
  if (sq !== wk && listHas(KING_ATT[sq], wk)) return true;
  const a2Live = a2 >= 0 && a2 !== ignore;
  for (let d = 0; d < 8; d++) {
    const ray = RAYS[d][sq];
    const sliderKind = d < 4 ? 'r' : 'b';
    for (let i = 0; i < ray.length; i++) {
      const s = ray[i];
      if (s === ignore) continue; // captured piece: square is empty, rays pass through
      if (s === wk) break; // own king blocks (its attack is the adjacency check above)
      if (s === a1) {
        if (t1 === 'q' || t1 === sliderKind) return true;
        break;
      }
      if (a2Live && s === a2) {
        if (t2 === 'q' || t2 === sliderKind) return true;
        break;
      }
    }
  }
  if (a1 !== ignore && t1 === 'n' && listHas(KNIGHT_ATT[a1], sq)) return true;
  if (a2Live && t2 === 'n' && listHas(KNIGHT_ATT[a2], sq)) return true;
  return false;
}

/* ------------------------------------------------------------------ *
 * 8-fold symmetry and canonical indexing.
 * ------------------------------------------------------------------ */

/**
 * TRANS[t][sq] = square sq mapped through symmetry t. The group is generated
 * by the file mirror (r,f)->(r,7-f) and the diagonal transpose (r,f)->(f,r):
 * identity, both mirrors, 180-degree rotation, both diagonal reflections and
 * both 90-degree rotations. All eight preserve the moves of every pawnless
 * piece (orthogonals map to orthogonals, diagonals to diagonals).
 * @type {Uint8Array[]}
 */
const TRANS = [];

(function initTransforms() {
  for (let t = 0; t < 8; t++) {
    const map = new Uint8Array(64);
    for (let sq = 0; sq < 64; sq++) {
      const r = sq >> 3;
      const f = sq & 7;
      let nr = r;
      let nf = f;
      if (t & 1) nf = 7 - nf; // file mirror
      if (t & 2) nr = 7 - nr; // rank mirror
      if (t & 4) {
        const tmp = nr;
        nr = nf; // diagonal transpose
        nf = tmp;
      }
      map[sq] = nr * 8 + nf;
    }
    TRANS.push(map);
  }
})();

/**
 * Squares that are the minimum of their symmetry orbit: a position whose
 * white king lies anywhere else always has a symmetry image with a smaller
 * packed encoding, so only king squares in this set can begin a canonical
 * representative. Derived from TRANS rather than hand-listed.
 * @type {number[]}
 */
const KING_CANON_SQUARES = [];
(function initKingCanonSquares() {
  const isMin = new Array(64).fill(true);
  for (let t = 0; t < 8; t++) {
    for (let sq = 0; sq < 64; sq++) {
      if (TRANS[t][sq] < sq) isMin[sq] = false;
    }
  }
  for (let sq = 0; sq < 64; sq++) {
    if (isMin[sq]) KING_CANON_SQUARES.push(sq);
  }
})();

/**
 * Canonical encoding of a 3-piece position: the minimum over the eight
 * symmetries of (wk<<12) | (attacker<<6) | bk.
 *
 * @param {number} wk
 * @param {number} at
 * @param {number} bk
 * @returns {number}
 */
function canon3(wk, at, bk) {
  let best = 0xffffffff;
  for (let t = 0; t < 8; t++) {
    const T = TRANS[t];
    const e = ((T[wk] << 12) | (T[at] << 6) | T[bk]) >>> 0;
    if (e < best) best = e;
  }
  return best;
}

/**
 * Canonical encoding of a 4-piece position: the minimum over the eight
 * symmetries of (wk<<18) | (p<<12) | (q<<6) | bk. With `identicalPair` the
 * two attacker squares are square-sorted after each transform (the pieces are
 * the same type, so either assignment describes the same physical position).
 *
 * @param {number} wk
 * @param {number} p
 * @param {number} q
 * @param {number} bk
 * @param {boolean} identicalPair
 * @returns {number}
 */
function canon4(wk, p, q, bk, identicalPair) {
  let best = 0xffffffff;
  for (let t = 0; t < 8; t++) {
    const T = TRANS[t];
    let s1 = T[p];
    let s2 = T[q];
    if (identicalPair && s2 < s1) {
      const tmp = s1;
      s1 = s2;
      s2 = tmp;
    }
    const e = ((T[wk] << 18) | (s1 << 12) | (s2 << 6) | T[bk]) >>> 0;
    if (e < best) best = e;
  }
  return best;
}

/**
 * Plain (non-canonical) encoding of a 3-piece position.
 *
 * @param {number} wk
 * @param {number} at
 * @param {number} bk
 * @returns {number}
 */
function enc3(wk, at, bk) {
  return ((wk << 12) | (at << 6) | bk) >>> 0;
}

/**
 * Plain (non-canonical) encoding of a 4-piece position.
 *
 * @param {number} wk
 * @param {number} p
 * @param {number} q
 * @param {number} bk
 * @returns {number}
 */
function enc4(wk, p, q, bk) {
  return ((wk << 18) | (p << 12) | (q << 6) | bk) >>> 0;
}

/* ------------------------------------------------------------------ *
 * Table construction (retrograde analysis).
 * ------------------------------------------------------------------ */

/**
 * @typedef {object} BuiltTable
 * @property {Uint8Array} dtm Value per canonical index (see module docs).
 * @property {number} maxDTM Highest finite White-to-move value in the table.
 */

/**
 * Reverse moves by White: every White-to-move parent P (as canonical
 * encodings) from which some legal White move produces Q. White cannot
 * capture (Black has only the king), so all reverse moves are quiet. P must
 * be a legal position and, because it is White to move there, Black must not
 * be in check in P.
 *
 * @param {{ attackers: string[], pieces: 3 | 4, identicalPair: boolean }} spec
 * @param {number} qwk
 * @param {number} qa1
 * @param {number} qa2
 * @param {number} qbk
 * @param {Int32Array} out Scratch array to write encodings into.
 * @returns {number} Number of encodings written (not deduplicated).
 */
function whiteParentEncs(spec, qwk, qa1, qa2, qbk, out) {
  const [t1, t2] = spec.attackers;
  let n = 0;
  // Reverse White king move: the king stood on f and stepped to qwk.
  const kingMoves = KING_ATT[qwk];
  for (let i = 0; i < kingMoves.length; i++) {
    const f = kingMoves[i];
    if (f === qa1 || f === qa2 || f === qbk) continue;
    if (squaresAdjacent(f, qbk)) continue; // kings would touch in P
    if (attackedByWhite(qbk, f, qa1, t1, qa2, t2)) continue; // Black in check with White to move
    out[n++] = spec.pieces === 3 ? enc3(f, qa1, qbk) : enc4(f, qa1, qa2, qbk);
  }
  // Reverse quiet move of attacker 1: it stood on f and moved to qa1.
  n = reverseAttacker(spec, qwk, qa2, qbk, qa1, t1, t2, out, n, true);
  // Reverse quiet move of attacker 2 (four-piece endings).
  if (spec.pieces === 4) {
    n = reverseAttacker(spec, qwk, qa1, qbk, qa2, t2, t1, out, n, false);
  }
  return n;
}

/**
 * Reverse quiet moves of one attacker: candidate from-squares f for a piece
 * of type `t` that moved f -> at, with the OTHER attacker standing at `other`.
 *
 * @param {{ attackers: string[], pieces: 3 | 4, identicalPair: boolean }} spec
 * @param {number} qwk
 * @param {number} other
 * @param {number} qbk
 * @param {number} at
 * @param {string} t
 * @param {string} otherType
 * @param {Int32Array} out
 * @param {number} n
 * @param {boolean} firstSlot True when the moving piece occupies attacker slot
 *   a1 (attacker 1); false when it occupies slot a2 (attacker 2), in which
 *   case its source square must be written into the second slot.
 * @returns {number}
 */
function reverseAttacker(spec, qwk, other, qbk, at, t, otherType, out, n, firstSlot) {
  /**
   * @param {number} f
   * @returns {void}
   */
  const push = (f) => {
    if (f === qwk || f === other || f === qbk) return; // f must be empty in Q
    if (attackedByWhite(qbk, qwk, f, t, other, otherType)) return; // Black in check in P
    out[n++] = spec.pieces === 3
      ? enc3(qwk, f, qbk)
      : firstSlot
        ? enc4(qwk, f, other, qbk)
        : enc4(qwk, other, f, qbk);
  };
  if (t === 'n') {
    const jumps = KNIGHT_ATT[at];
    for (let i = 0; i < jumps.length; i++) push(jumps[i]);
    return n;
  }
  const startDir = t === 'r' ? 0 : t === 'b' ? 4 : 0; // queen uses all eight
  const endDir = t === 'r' ? 4 : t === 'b' ? 8 : 8;
  for (let d = startDir; d < endDir; d++) {
    const ray = RAYS[d][at];
    for (let i = 0; i < ray.length; i++) {
      const f = ray[i];
      if (f === qwk || f === other || f === qbk) break; // first blocker: the forward slide could not have passed it
      push(f);
    }
  }
  return n;
}

/**
 * Reverse moves by Black: every Black-to-move parent P (canonical encodings)
 * from which some legal Black move produces Q. Only quiet king returns are
 * enumerated: if Black could capture a White piece, P is a draw for White
 * (the capture yields bare kings) and never needs a value, so such parents
 * are deliberately skipped. A quiet king return exists only when Q's Black
 * king stands unattacked (the forward move may not step into check).
 *
 * @param {{ attackers: string[], pieces: 3 | 4, identicalPair: boolean }} spec
 * @param {number} qwk
 * @param {number} qa1
 * @param {number} qa2
 * @param {number} qbk
 * @param {Int32Array} out Scratch array.
 * @returns {number}
 */
function blackParentEncs(spec, qwk, qa1, qa2, qbk, out) {
  const [t1, t2] = spec.attackers;
  if (attackedByWhite(qbk, qwk, qa1, t1, qa2, t2)) return 0; // Black is in check in Q: the last move gave check, so it was not a quiet king move
  let n = 0;
  const kingMoves = KING_ATT[qbk];
  for (let i = 0; i < kingMoves.length; i++) {
    const f = kingMoves[i];
    if (f === qwk || f === qa1 || f === qa2) continue;
    if (squaresAdjacent(f, qwk)) continue; // kings would touch in P
    out[n++] = spec.pieces === 3 ? enc3(qwk, qa1, f) : enc4(qwk, qa1, qa2, f);
  }
  return n;
}

/**
 * Legal Black king destinations from `bk`: quiet moves (empty square not
 * attacked by White) and captures (attacker square not defended once the
 * captured piece's own attack is removed). Used by the initial pass.
 *
 * @param {number} wk
 * @param {number} a1
 * @param {string} t1
 * @param {number} a2
 * @param {string} t2
 * @param {number} bk
 * @returns {{ quiet: number[], captures: number }}
 */
function blackKingOptions(wk, a1, t1, a2, t2, bk) {
  /** @type {number[]} */
  const quiet = [];
  let captures = 0;
  const moves = KING_ATT[bk];
  for (let i = 0; i < moves.length; i++) {
    const dest = moves[i];
    if (dest === wk) continue; // may not move onto the White king
    if (dest === a1 || dest === a2) {
      if (!attackedByWhite(dest, wk, a1, t1, a2, t2, dest)) captures++;
      continue;
    }
    if (!attackedByWhite(dest, wk, a1, t1, a2, t2)) quiet.push(dest);
  }
  return { quiet, captures };
}

/**
 * Canonical encoding of a position given in raw slot order.
 *
 * @param {{ pieces: 3 | 4, identicalPair: boolean }} spec
 * @param {number} rawEnc
 * @returns {number}
 */
function canonOfRaw(spec, rawEnc) {
  if (spec.pieces === 3) {
    return canon3(rawEnc >>> 12, (rawEnc >>> 6) & 63, rawEnc & 63);
  }
  return canon4(rawEnc >>> 18, (rawEnc >>> 12) & 63, (rawEnc >>> 6) & 63, rawEnc & 63, spec.identicalPair);
}

/**
 * Build one endgame's table by retrograde analysis.
 *
 * @param {string} endgameId
 * @returns {BuiltTable}
 */
export function buildTable(endgameId) {
  const spec = specOf(endgameId);
  const identical = spec.identicalPair;
  const four = spec.pieces === 4;
  const size = four ? 2 ** 25 : 2 ** 19;
  const dtm = new Uint8Array(size).fill(255);
  const counts = new Uint8Array(size);
  /** @type {number[]} */
  const queueB0 = [];

  /**
   * @param {number} wk
   * @param {number} a1
   * @param {number} a2
   * @param {number} bk
   * @returns {number}
   */
  const canon = (wk, a1, a2, bk) =>
    four ? canon4(wk, a1, a2, bk, identical) : canon3(wk, a1, bk);

  // Initial pass: seed checkmates (dtm 0) and set defender child counts.
  for (const wk of KING_CANON_SQUARES) {
    for (let a1 = 0; a1 < 64; a1++) {
      if (a1 === wk) continue;
      const a2Limit = four ? 64 : 1;
      for (let a2i = 0; a2i < a2Limit; a2i++) {
        const a2 = four ? a2i : -1;
        if (four && (a2 === a1 || a2 === wk)) continue;
        if (four && identical && a2 < a1) continue; // sorted-pair representative
        for (let bk = 0; bk < 64; bk++) {
          if (bk === wk || bk === a1 || bk === a2) continue;
          if (squaresAdjacent(wk, bk)) continue;
          const enc = four ? enc4(wk, a1, a2, bk) : enc3(wk, a1, bk);
          if (canon(wk, a1, a2, bk) !== enc) continue; // not the canonical representative
          const [t1, t2] = spec.attackers;
          const idxB = enc * 2 + 1;
          const { quiet, captures } = blackKingOptions(wk, a1, t1, a2, t2, bk);
          if (quiet.length === 0 && captures === 0) {
            // No defence left: checkmate when the king is attacked, stalemate
            // (a draw, left at 255) when it is not.
            if (attackedByWhite(bk, wk, a1, t1, a2, t2)) {
              dtm[idxB] = 0;
              queueB0.push(idxB);
            }
            continue;
          }
          // Defender child classes: distinct canonical encodings of quiet
          // children, plus a permanent sentinel when a capture (a draw) exists.
          /** @type {number[]} */
          const childEncs = [];
          for (const dest of quiet) {
            const childEnc = canon(wk, a1, a2, dest);
            let seen = false;
            for (let i = 0; i < childEncs.length; i++) {
              if (childEncs[i] === childEnc) {
                seen = true;
                break;
              }
            }
            if (!seen) childEncs.push(childEnc);
          }
          counts[idxB] = childEncs.length + (captures > 0 ? 60 : 0);
        }
      }
    }
  }

  // Retrograde breadth-first search: alternate White-parent expansion (which
  // sets attacker values to d+1 from defender value d) and defender
  // child-count exhaustion (which sets defender value d once every child has
  // entered the attacker side, the last one at d, so the max is exactly d).
  /** @type {number[]} */
  let frontier = queueB0;
  /** @type {number[]} */
  let scratch = [];
  let side = /** @type {'B' | 'W'} */ ('B');
  let d = 0;
  const parentScratch = new Int32Array(64);
  const canonScratch = new Int32Array(64);
  /**
   * Canonicalize the raw parent encodings in parentScratch and dedupe them.
   * @param {number} nRaw
   * @returns {number} Number of unique canonical encodings in canonScratch.
   */
  const canonicalizeParents = (nRaw) => {
    let m = 0;
    for (let i = 0; i < nRaw; i++) {
      const c = canonOfRaw(spec, parentScratch[i]);
      let seen = false;
      for (let j = 0; j < m; j++) {
        if (canonScratch[j] === c) {
          seen = true;
          break;
        }
      }
      if (!seen) canonScratch[m++] = c;
    }
    return m;
  };
  while (frontier.length > 0) {
    /** @type {number[]} */
    const next = [];
    if (side === 'B') {
      for (const qIdx of frontier) {
        const enc = qIdx >>> 1;
        const qwk = four ? enc >>> 18 : enc >>> 12;
        const qa1 = four ? (enc >>> 12) & 63 : (enc >>> 6) & 63;
        const qa2 = four ? (enc >>> 6) & 63 : -1;
        const qbk = enc & 63;
        const nParents = canonicalizeParents(
          whiteParentEncs(spec, qwk, qa1, qa2, qbk, parentScratch),
        );
        for (let i = 0; i < nParents; i++) {
          const pIdx = canonScratch[i] * 2; // White to move
          if (dtm[pIdx] === 255) {
            dtm[pIdx] = d + 1;
            next.push(pIdx);
          }
        }
      }
      side = 'W';
      d += 1;
    } else {
      for (const qIdx of frontier) {
        const enc = qIdx >>> 1;
        const qwk = four ? enc >>> 18 : enc >>> 12;
        const qa1 = four ? (enc >>> 12) & 63 : (enc >>> 6) & 63;
        const qa2 = four ? (enc >>> 6) & 63 : -1;
        const qbk = enc & 63;
        const nParents = canonicalizeParents(
          blackParentEncs(spec, qwk, qa1, qa2, qbk, parentScratch),
        );
        for (let i = 0; i < nParents; i++) {
          const pIdx = canonScratch[i] * 2 + 1; // Black to move
          if (dtm[pIdx] === 255 && counts[pIdx] > 0) {
            counts[pIdx] -= 1;
            if (counts[pIdx] === 0) {
              dtm[pIdx] = d;
              next.push(pIdx);
            }
          }
        }
      }
      side = 'B';
    }
    frontier = next;
    scratch = frontier; // keep a reference so large frontiers are not re-created
    void scratch;
  }

  // Highest finite attacker-to-move value: the published-table maximum.
  let maxDTM = 0;
  for (let idx = 0; idx < size; idx += 2) {
    const v = dtm[idx];
    if (v <= 200 && v > maxDTM) maxDTM = v;
  }
  return { dtm, maxDTM };
}

/* ------------------------------------------------------------------ *
 * Lazy per-process caches and probing.
 * ------------------------------------------------------------------ */

/** @type {Map<string, BuiltTable>} */
const BUILT = new Map();

/**
 * Build (once) and return the table for an endgame.
 *
 * @param {string} endgameId
 * @returns {BuiltTable}
 */
export function getTable(endgameId) {
  let table = BUILT.get(endgameId);
  if (!table) {
    table = buildTable(endgameId);
    BUILT.set(endgameId, table);
  }
  return table;
}

/**
 * Parse a FEN piece placement and side to move into squares. Returns null for
 * any position that does not have exactly this endgame's material.
 *
 * @param {string} endgameId
 * @param {string} fen
 * @returns {{ wk: number, a1: number, a2: number, bk: number, whiteToMove: boolean, attackers: string[] } | null}
 */
export function parseEndgameFen(endgameId, fen) {
  const spec = specOf(endgameId);
  const fields = String(fen).trim().split(/\s+/);
  if (fields.length < 2) return null;
  const placement = fields[0];
  const whiteToMove = fields[1] === 'w';
  const rows = placement.split('/');
  if (rows.length !== 8) return null;
  let wk = -1;
  let bk = -1;
  /** @type {number[]} */
  const attackerSquares = [];
  /** @type {string[]} */
  const attackerTypes = [];
  for (let rowIdx = 0; rowIdx < 8; rowIdx++) {
    const row = rows[rowIdx];
    const rank = 7 - rowIdx;
    let file = 0;
    for (let i = 0; i < row.length; i++) {
      const ch = row[i];
      if (ch >= '1' && ch <= '8') {
        file += Number(ch);
        continue;
      }
      const sq = rank * 8 + file;
      if (ch === 'K') {
        if (wk >= 0) return null;
        wk = sq;
      } else if (ch === 'k') {
        if (bk >= 0) return null;
        bk = sq;
      } else {
        const lower = ch.toLowerCase();
        if (ch !== lower) {
          attackerSquares.push(sq);
          attackerTypes.push(lower);
        } else {
          return null; // unexpected black piece
        }
      }
      file += 1;
    }
    if (file !== 8) return null;
  }
  if (wk < 0 || bk < 0) return null;
  if (attackerSquares.length !== spec.attackers.length) return null;
  // Attacker types must match the endgame's multiset.
  const expected = [...spec.attackers].sort().join('');
  const actual = [...attackerTypes].sort().join('');
  if (expected !== actual) return null;
  const a1 = attackerSquares[0];
  const a2 = attackerSquares.length > 1 ? attackerSquares[1] : -1;
  const t1 = attackerTypes[0];
  const t2 = attackerTypes.length > 1 ? attackerTypes[1] : '';
  // Reorder the attacker slots to the spec's identity order.
  let fa1 = a1;
  let fa2 = a2;
  const [e1, e2] = spec.attackers;
  if (spec.attackers.length === 2 && t1 !== e1) {
    fa1 = a2;
    fa2 = a1;
  }
  void e2;
  void t2;
  if (squaresAdjacent(wk, bk)) return null; // impossible position
  if (fa1 === wk || fa1 === bk || fa2 === wk || fa2 === bk) return null;
  return { wk, a1: fa1, a2: fa2, bk, whiteToMove, attackers: spec.attackers };
}

/**
 * Probe the table for a position.
 *
 * @param {string} endgameId
 * @param {string} fen
 * @returns {{ dtm: number | null, draw: boolean }}
 *   `dtm` is the distance to mate in White moves with the side to move as the
 *   FEN states it (null when White cannot force mate). `draw` is true for
 *   every no-mate answer, including positions outside this endgame's material.
 */
export function probe(endgameId, fen) {
  const parsed = parseEndgameFen(endgameId, fen);
  if (!parsed) return { dtm: null, draw: true };
  const table = getTable(endgameId);
  const { wk, a1, a2, bk, whiteToMove } = parsed;
  const enc = parsed.attackers.length === 2
    ? canon4(wk, a1, a2, bk, specOf(endgameId).identicalPair)
    : canon3(wk, a1, bk);
  const idx = enc * 2 + (whiteToMove ? 0 : 1);
  const value = table.dtm[idx];
  if (value <= 200) return { dtm: value, draw: false };
  return { dtm: null, draw: true };
}

/**
 * The table's highest finite DTM with the attacker to move: 10 for KQK,
 * 16 for KRK, 19 for KBBK and 33 for KBNK when the tables are correct.
 *
 * @param {string} endgameId
 * @returns {number}
 */
export function tableMaxDTM(endgameId) {
  return getTable(endgameId).maxDTM;
}

/**
 * Raw position classification from the table's own move generator, for
 * cross-checking against chess.js in tests.
 *
 * @param {string} endgameId
 * @param {string} fen
 * @returns {{ checkmate: boolean, stalemate: boolean, legalMoves: number } | null}
 *   Null when the FEN does not match this endgame's material.
 */
export function rawFlags(endgameId, fen) {
  const parsed = parseEndgameFen(endgameId, fen);
  if (!parsed) return null;
  const spec = specOf(endgameId);
  const [t1, t2] = spec.attackers;
  const { wk, a1, a2, bk, whiteToMove } = parsed;
  const stmWhite = whiteToMove;
  // The side to move is the defender (Black) in every position this module
  // stores side-to-move flags for; classify the defender's situation when
  // Black is to move, and the attacker's escape options when White is.
  if (stmWhite) {
    // White to move: no special flags; count king + attacker moves is not
    // needed by the game, so only the defender flags are computed below.
    return { checkmate: false, stalemate: false, legalMoves: -1 };
  }
  const inCheck = attackedByWhite(bk, wk, a1, t1, a2, t2);
  const { quiet, captures } = blackKingOptions(wk, a1, t1, a2, t2, bk);
  const moves = quiet.length + captures;
  return {
    checkmate: inCheck && moves === 0,
    stalemate: !inCheck && moves === 0,
    legalMoves: moves,
  };
}
