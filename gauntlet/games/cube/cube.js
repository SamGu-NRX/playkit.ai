/**
 * Rubik's Cube (3x3x3) model for PlayKit Gauntlet: 54 facelets, the 18 face
 * turns of the half-turn metric as pure string-to-string functions, and the
 * unfolded-net renderer the observation uses.
 *
 * Facelet string layout: six faces of nine, in face order U, R, F, D, L, B,
 * each face row-major as it appears in the unfolded net. The net is
 *
 * ```
 *        UUU
 *        UUU
 *        UUU
 * LLL  FFF  RRR  BBB
 * LLL  FFF  RRR  BBB
 * LLL  FFF  RRR  BBB
 *        DDD
 *        DDD
 *        DDD
 * ```
 *
 * with every face drawn as it looks when you look straight at that face from
 * outside the cube (so the back face is shown from behind, the down face from
 * below). Centres never move, so the solved string doubles as the
 * face-to-colour map: W=up, G=right, R=front, O=back, B=left, Y=down.
 *
 * The 18 turn permutations are NOT hand-written tables. Each is derived from
 * 3D geometry: a facelet is a (position, outward-normal) pair on the cube, a
 * turn rotates both by a quarter turn about the face's outward normal
 * (clockwise as seen from outside = -90 degrees by the right-hand rule), and
 * the permutation is the induced map on the 54 (position, normal) slots. This
 * makes a wrong table essentially impossible to ship: the strict tests pin
 * quarter-turn order 4, the order-6 "sexy move", and the exact breadth-first
 * state counts 1, 18, 243, 3240, 43239 at distances 0..4 (OEIS A080601,
 * half-turn metric), which a single mis-turned sticker would break.
 *
 * Pure JS, no `node:*` imports: game code loads in the browser too.
 *
 * @module
 */

/**
 * Face order in the facelet string and in the net's middle band.
 * @type {readonly ['U', 'R', 'F', 'D', 'L', 'B']}
 */
export const FACES = ['U', 'R', 'F', 'D', 'L', 'B'];

/**
 * The colour letter each face's centre carries (and therefore every facelet
 * of that face when solved).
 * @type {{ [face: string]: string }}
 */
export const FACE_COLOURS = { U: 'W', R: 'G', F: 'R', D: 'Y', L: 'B', B: 'O' };

/**
 * The solved cube as a 54-character facelet string.
 * @type {string}
 */
export const SOLVED = FACES.map((f) => FACE_COLOURS[f].repeat(9)).join('');

/**
 * Outward normal of each face.
 * @type {{ [face: string]: [number, number, number] }}
 */
const NORMALS = {
  U: [0, 1, 0],
  R: [1, 0, 0],
  F: [0, 0, 1],
  D: [0, -1, 0],
  L: [-1, 0, 0],
  B: [0, 0, -1],
};

/**
 * Position of the facelet at (face, row, col) in cube coordinates:
 * x right, y up, z front, each in {-1, 0, 1}. Rows and columns run as the
 * face appears in the unfolded net (see the module doc).
 *
 * @param {'U' | 'R' | 'F' | 'D' | 'L' | 'B'} face
 * @param {number} r 0..2, top to bottom in the net.
 * @param {number} c 0..2, left to right in the net.
 * @returns {[number, number, number]}
 */
function faceletPos(face, r, c) {
  switch (face) {
    case 'U': return [c - 1, 1, r - 1];
    case 'R': return [1, 1 - r, 1 - c];
    case 'F': return [c - 1, 1 - r, 1];
    case 'D': return [c - 1, -1, 1 - r];
    case 'L': return [-1, 1 - r, c - 1];
    case 'B': return [1 - c, 1 - r, -1];
  }
}

/**
 * @param {[number, number, number]} p
 * @param {[number, number, number]} n
 * @returns {string}
 */
function slotKey(p, n) {
  return `${p[0]},${p[1]},${p[2]}|${n[0]},${n[1]},${n[2]}`;
}

/** Facelet slot index for every (position, normal) pair on the cube. */
const SLOT_INDEX = new Map(
  (() => {
    /** @type {[string, number][]} */
    const entries = [];
    for (let f = 0; f < 6; f++) {
      const face = FACES[f];
      for (let r = 0; r < 3; r++) {
        for (let c = 0; c < 3; c++) {
          entries.push([slotKey(faceletPos(face, r, c), NORMALS[face]), f * 9 + r * 3 + c]);
        }
      }
    }
    return entries;
  })()
);

/**
 * Rotate a coordinate vector by k right-hand quarter turns about the positive
 * axis (0=x, 1=y, 2=z).
 *
 * @param {[number, number, number]} v
 * @param {0 | 1 | 2} axis
 * @param {number} k any integer; reduced mod 4.
 * @returns {[number, number, number]}
 */
function rotate(v, axis, k) {
  const q = ((k % 4) + 4) % 4;
  if (q === 0) return [v[0], v[1], v[2]];
  const [x, y, z] = v;
  switch (axis) {
    case 0: // (x, y, z) -> (x, -z, y) per quarter
      return q === 1 ? [x, -z, y] : q === 2 ? [x, -y, -z] : [x, z, -y];
    case 1: // (x, y, z) -> (z, y, -x) per quarter
      return q === 1 ? [z, y, -x] : q === 2 ? [-x, y, -z] : [-z, y, x];
    default: // (x, y, z) -> (-y, x, z) per quarter
      return q === 1 ? [-y, x, z] : q === 2 ? [-x, -y, z] : [y, -x, z];
  }
}

/**
 * The pull permutation for one face turn: `pull[j]` is the facelet index whose
 * sticker moves INTO slot j. Built from geometry, never hand-written.
 *
 * @param {'U' | 'R' | 'F' | 'D' | 'L' | 'B'} face
 * @param {1 | 2 | 3} q quarter turns clockwise as seen from outside the face.
 * @returns {Int32Array}
 */
function buildPull(face, q) {
  const normal = NORMALS[face];
  const axis = /** @type {0 | 1 | 2} */ (normal[0] !== 0 ? 0 : normal[1] !== 0 ? 1 : 2);
  const sign = normal[axis];
  // Clockwise as seen from outside the face is -90 degrees about the outward
  // normal (right-hand rule), i.e. -90*q degrees about the positive axis
  // scaled by the normal's sign.
  const k = -q * sign;
  /** @type {Int32Array} */
  const forward = new Int32Array(54);
  for (let i = 0; i < 54; i++) {
    const f = Math.floor(i / 9);
    const r = Math.floor((i % 9) / 3);
    const c = i % 3;
    const pos = faceletPos(FACES[f], r, c);
    if (pos[axis] !== sign) {
      forward[i] = i; // not in the turning layer
      continue;
    }
    const moved = rotate(pos, axis, k);
    const turnedNormal = rotate(NORMALS[FACES[f]], axis, k);
    const j = SLOT_INDEX.get(slotKey(moved, turnedNormal));
    if (j === undefined) {
      throw new Error(`cube geometry: no facelet slot for ${slotKey(moved, turnedNormal)}`);
    }
    forward[i] = j;
  }
  // Invert old->new into the pull form new<-old.
  /** @type {Int32Array} */
  const pull = new Int32Array(54);
  for (let i = 0; i < 54; i++) pull[forward[i]] = i;
  return pull;
}

/**
 * The 18 canonical half-turn-metric tokens, in a fixed generation order
 * (legalActions returns the sorted variant).
 * @type {readonly string[]}
 */
export const MOVES = [
  'U', "U'", 'U2',
  'R', "R'", 'R2',
  'F', "F'", 'F2',
  'D', "D'", 'D2',
  'L', "L'", 'L2',
  'B', "B'", 'B2',
];

/**
 * The 18 canonical tokens sorted with the default string order (the
 * environment contract requires sorted legalActions).
 * @type {string[]}
 */
export const CANONICAL_MOVES = [...MOVES].sort();

/** @type {Map<string, Int32Array>} */
const PULL_PERMS = new Map(
  FACES.flatMap((face) => {
    /** @type {[string, Int32Array][]} */
    const perFace = [
      [face, buildPull(face, 1)],
      [`${face}'`, buildPull(face, 3)],
      [`${face}2`, buildPull(face, 2)],
    ];
    return perFace;
  })
);

/**
 * The face letter a token turns (token[0]); used for same-face search
 * pruning and parse feedback.
 * @param {string} token
 * @returns {string}
 */
export function faceOf(token) {
  return token[0];
}

/**
 * Apply one canonical turn to a facelet string. Pure.
 *
 * @param {string} state 54-character facelet string.
 * @param {string} token one of MOVES.
 * @returns {string} The new facelet string.
 */
export function applyMove(state, token) {
  const pull = PULL_PERMS.get(token);
  if (pull === undefined) {
    throw new Error(`unknown cube move ${JSON.stringify(token)}`);
  }
  /** @type {string[]} */
  const out = new Array(54);
  for (let j = 0; j < 54; j++) out[j] = state[pull[j]];
  return out.join('');
}

/**
 * Apply a sequence of canonical turns, left to right.
 *
 * @param {string} state
 * @param {readonly string[]} tokens
 * @returns {string}
 */
export function applySequence(state, tokens) {
  let s = state;
  for (const token of tokens) s = applyMove(s, token);
  return s;
}

/**
 * A state is solved exactly when it equals the solved string: centres are
 * fixed, so the facelet colours determine solvedness uniquely.
 *
 * @param {string} state
 * @returns {boolean}
 */
export function isSolved(state) {
  return state === SOLVED;
}

/**
 * How many of the 54 facelets match their face's centre colour. The greedy
 * baseline climbs this number.
 *
 * @param {string} state
 * @returns {number}
 */
export function stickerMatchCount(state) {
  let n = 0;
  for (let i = 0; i < 54; i++) {
    if (state[i] === SOLVED[i]) n++;
  }
  return n;
}

/**
 * Render a state as the unfolded nine-line net (two-space gutters).
 *
 * @param {string} state
 * @returns {string}
 */
export function renderNet(state) {
  const U = 0;
  const R = 9;
  const F = 18;
  const D = 27;
  const L = 36;
  const B = 45;
  /** @param {number} base @param {number} r */
  const row = (base, r) => state.slice(base + r * 3, base + r * 3 + 3);
  /** @param {number} r */
  const band = (r) => [row(L, r), row(F, r), row(R, r), row(B, r)].join('  ');
  return [
    `      ${row(U, 0)}`,
    `      ${row(U, 1)}`,
    `      ${row(U, 2)}`,
    band(0),
    band(1),
    band(2),
    `      ${row(D, 0)}`,
    `      ${row(D, 1)}`,
    `      ${row(D, 2)}`,
  ].join('\n');
}
