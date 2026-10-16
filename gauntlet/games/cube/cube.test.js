import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CANONICAL_MOVES,
  FACE_COLOURS,
  FACES,
  MOVES,
  SOLVED,
  applyMove,
  applySequence,
  renderNet,
  stickerMatchCount,
} from './cube.js';

/**
 * Independent plain breadth-first state count from solved (no solver imports,
 * no same-face pruning): the model must produce the exact cube-group counts
 * of OEIS A080601 (half-turn metric) or it is not a cube.
 * @param {number} maxDepth
 * @returns {number[]}
 */
function bfsStateCounts(maxDepth) {
  let frontier = [SOLVED];
  const seen = new Set(frontier);
  /** @type {number[]} */
  const counts = [1];
  for (let depth = 1; depth <= maxDepth; depth++) {
    /** @type {string[]} */
    const next = [];
    for (const state of frontier) {
      for (const move of MOVES) {
        const n = applyMove(state, move);
        if (seen.has(n)) continue;
        seen.add(n);
        next.push(n);
      }
    }
    counts.push(next.length);
    frontier = next;
  }
  return counts;
}

test('the solved string is six uniform faces with the documented centre colours', () => {
  assert.equal(SOLVED.length, 54);
  for (let f = 0; f < 6; f++) {
    const face = SOLVED.slice(f * 9, f * 9 + 9);
    assert.equal(face, FACE_COLOURS[FACES[f]].repeat(9));
  }
  assert.equal(FACE_COLOURS.U, 'W');
  assert.equal(FACE_COLOURS.R, 'G');
  assert.equal(FACE_COLOURS.F, 'R');
  assert.equal(FACE_COLOURS.D, 'Y');
  assert.equal(FACE_COLOURS.L, 'B');
  assert.equal(FACE_COLOURS.B, 'O');
});

test('the 18 canonical tokens are unique, half-turn-metric, and sorted', () => {
  assert.equal(MOVES.length, 18);
  assert.equal(new Set(MOVES).size, 18);
  for (const face of FACES) {
    for (const suffix of ['', "'", '2']) assert.ok(MOVES.includes(face + suffix));
  }
  assert.deepEqual(CANONICAL_MOVES, [...CANONICAL_MOVES].sort());
  assert.deepEqual(CANONICAL_MOVES, [...MOVES].sort());
});

test('every quarter turn has order 4 and every half turn order 2', () => {
  for (const move of MOVES) {
    const once = applyMove(SOLVED, move);
    const twice = applyMove(once, move);
    const thrice = applyMove(twice, move);
    const fourth = applyMove(thrice, move);
    assert.equal(fourth, SOLVED, `${move}^4 must be identity`);
    if (move.endsWith('2')) {
      assert.equal(twice, SOLVED, `${move} must be order 2`);
    } else {
      assert.notEqual(once, SOLVED, `${move} must not be order 1`);
      assert.notEqual(twice, SOLVED, `${move} must not be order 2`);
      assert.notEqual(thrice, SOLVED, `${move} must not be order 3`);
    }
  }
});

test("R U R' U' has order exactly 6", () => {
  const sexy = ['R', 'U', "R'", "U'"];
  let state = SOLVED;
  for (let i = 1; i <= 6; i++) {
    state = applySequence(state, sexy);
    if (i < 6) assert.notEqual(state, SOLVED, `order divides at ${i}`);
  }
  assert.equal(state, SOLVED, 'order must be exactly 6');
});

test('breadth-first state counts at distances 0..4 are exactly 1, 18, 243, 3240, 43239 (OEIS A080601)', () => {
  assert.deepEqual(bfsStateCounts(4), [1, 18, 243, 3240, 43239]);
});

test('the net renders the solved cube in the documented nine-line layout', () => {
  assert.equal(
    renderNet(SOLVED),
    [
      '      WWW',
      '      WWW',
      '      WWW',
      'BBB  RRR  GGG  OOO',
      'BBB  RRR  GGG  OOO',
      'BBB  RRR  GGG  OOO',
      '      YYY',
      '      YYY',
      '      YYY',
    ].join('\n')
  );
});

test('net fixture: after R (hand-derived)', () => {
  // Hand derivation: R's own face rotates in place (uniform, invisible);
  // F's right column moves up to U's right column; U's right column moves to
  // B's left column (reversed, invisible in a uniform column); B's left
  // column moves to D's right column (reversed); D's right column moves to
  // F's right column. Colours: U=W, F=R, D=Y, B=O.
  assert.equal(
    renderNet(applySequence(SOLVED, ['R'])),
    [
      '      WWR',
      '      WWR',
      '      WWR',
      'BBB  RRY  GGG  WOO',
      'BBB  RRY  GGG  WOO',
      'BBB  RRY  GGG  WOO',
      '      YYO',
      '      YYO',
      '      YYO',
    ].join('\n')
  );
});

test('net fixture: after U (hand-derived)', () => {
  // U turns its own face clockwise (uniform, invisible) and cycles the top
  // rows: F's top row goes to L, L's to B, B's to R, R's to F.
  assert.equal(
    renderNet(applySequence(SOLVED, ['U'])),
    [
      '      WWW',
      '      WWW',
      '      WWW',
      'RRR  GGG  OOO  BBB',
      'BBB  RRR  GGG  OOO',
      'BBB  RRR  GGG  OOO',
      '      YYY',
      '      YYY',
      '      YYY',
    ].join('\n')
  );
});

test('net fixture: after F (hand-derived)', () => {
  // F turns its own face clockwise (uniform, invisible) and cycles the ring
  // around F: U's bottom row goes down R's left column, R's left column goes
  // along D's top row (reversed; the uniform G column reversed is still GGG),
  // D's top row goes down L's right column, L's right column goes along U's
  // bottom row (reversed).
  assert.equal(
    renderNet(applySequence(SOLVED, ['F'])),
    [
      '      WWW',
      '      WWW',
      '      BBB',
      'BBY  RRR  WGG  OOO',
      'BBY  RRR  WGG  OOO',
      'BBY  RRR  WGG  OOO',
      '      GGG',
      '      YYY',
      '      YYY',
    ].join('\n')
  );
});

test('net fixture: after R U (hand-derived; pins row/col order within moved lines)', () => {
  // Applying U to the after-R state: L's top row becomes F's old top row
  // ("RRY", non-uniform, so the order within the moved line is pinned), F's
  // top row becomes B's old top row ("WOO"), R's top row becomes L's old top
  // row ("BBB"), B's top row becomes R's old top row ("GGG").
  assert.equal(
    renderNet(applySequence(SOLVED, ['R', 'U'])),
    [
      '      WWW',
      '      WWW',
      '      RRR',
      'RRY  GGG  WOO  BBB',
      'BBB  RRY  GGG  WOO',
      'BBB  RRY  GGG  WOO',
      '      YYO',
      '      YYO',
      '      YYO',
    ].join('\n')
  );
});

test('applyMove is pure and applySequence composes left to right', () => {
  const scrambled = applySequence(SOLVED, ['R', 'U', 'F']);
  assert.notEqual(scrambled, SOLVED);
  // the inverse of a sequence is the reversed sequence of inverted turns
  const inverse = ["F'", "U'", "R'"];
  assert.equal(applySequence(scrambled, inverse), SOLVED);
  assert.equal(applySequence(SOLVED, ['U', "U'"]), SOLVED);
  assert.equal(applySequence(SOLVED, ['U', 'U', 'U', 'U']), SOLVED);
});

test('stickerMatchCount counts facelets matching their centre colour', () => {
  assert.equal(stickerMatchCount(SOLVED), 54);
  // A face turn leaves the 8 non-centre stickers of the turned face matching
  // (they rotate in place on a uniform face) but moves 12 ring facelets onto
  // foreign faces: 54 - 12.
  assert.equal(stickerMatchCount(applySequence(SOLVED, ['R'])), 42);
  assert.equal(stickerMatchCount(applySequence(SOLVED, ['R', 'R'])), 42);
});
