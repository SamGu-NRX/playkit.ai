import { test } from 'node:test';
import assert from 'node:assert/strict';

import { referee } from './referee.js';
import { slide, placeTile } from '../games/2048/rules.js';

/** @import { Board } from '../games/2048/rules.js' */

/**
 * @param {number[][]} rows
 * @returns {Board}
 */
function board(rows) {
  return rows.map((row) => row.slice());
}

test('referee accepts a legal slide plus exactly one spawn', () => {
  const prev = board([
    [0, 2, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
  ]);
  const slid = slide(prev, 'left').board;
  const next = placeTile(slid, 3, 3, 2);
  const verdict = referee(prev, 'left', next);
  assert.equal(verdict.ok, true);
  assert.equal(verdict.diverged, false);
  assert.equal(verdict.applied, 'left');
  assert.deepEqual(verdict.spawn, { r: 3, c: 3, value: 2 });
  assert.equal(verdict.reason, null);
});

test('referee accepts a 4 spawning', () => {
  const prev = board([
    [0, 2, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
  ]);
  const slid = slide(prev, 'left').board;
  const next = placeTile(slide(prev, 'left').board, 3, 3, 4);
  const verdict = referee(prev, 'left', next);
  assert.equal(verdict.ok, true);
  assert.deepEqual(verdict.spawn, { r: 3, c: 3, value: 4 });
});

test('referee flags a slide applied without the spawn', () => {
  const prev = board([
    [0, 2, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
  ]);
  const next = slide(prev, 'left').board;
  const verdict = referee(prev, 'left', next);
  assert.equal(verdict.ok, false);
  assert.match(String(verdict.reason), /spawn/);
});

test('referee flags two spawned tiles', () => {
  const prev = board([
    [0, 2, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
  ]);
  let next = slide(prev, 'left').board;
  next = placeTile(next, 3, 3, 2);
  next = placeTile(next, 2, 1, 2);
  const verdict = referee(prev, 'left', next);
  assert.equal(verdict.ok, false);
  assert.match(String(verdict.reason), /spawn/);
});

test('referee flags a spawn with a value the rules never produce', () => {
  const prev = board([
    [0, 2, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
  ]);
  const next = placeTile(slide(prev, 'left').board, 3, 3, 8);
  const verdict = referee(prev, 'left', next);
  assert.equal(verdict.ok, false);
});

test('referee identifies the direction the driver actually applied', () => {
  const prev = board([
    [2, 0, 0, 4],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
  ]);
  // The agent chose "up", which changes nothing on this board; the driver
  // fell through to "left", which moved and spawned.
  const slid = slide(prev, 'left').board;
  const next = placeTile(slid, 3, 3, 2);
  const verdict = referee(prev, 'up', next);
  assert.equal(verdict.ok, true);
  assert.equal(verdict.direction, 'up');
  assert.equal(verdict.applied, 'left');
  assert.equal(verdict.diverged, true);
  assert.deepEqual(verdict.spawn, { r: 3, c: 3, value: 2 });
  assert.match(String(verdict.reason), /applied/);
});

test('referee flags a page that merges a settled tile', () => {
  // A page that double-merges turns [2,2,2,2] right into [0,0,0,8] instead of
  // [0,0,4,4]; no direction plus one spawn explains that board.
  const prev = board([
    [2, 2, 2, 2],
    [2, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
  ]);
  const tampered = board([
    [0, 0, 0, 8],
    [0, 0, 0, 2],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
  ]);
  const next = placeTile(tampered, 1, 0, 2);
  const verdict = referee(prev, 'right', next);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.applied, null);
  assert.equal(verdict.spawn, null);
});

test('referee flags an unchanged board reported as a move', () => {
  const prev = board([
    [2, 0, 0, 2],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
  ]);
  const verdict = referee(prev, 'up', prev);
  assert.equal(verdict.ok, false);
});

test('referee rejects a truncated board instead of comparing shared cells', () => {
  const prev = board([
    [2, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
  ]);
  const slid = slide(prev, 'left').board;
  const truncated = slid.slice(0, 3).map((row) => row.slice());
  truncated[0][3] = 2;
  const verdict = referee(prev, 'left', /** @type {Board} */ (truncated));
  assert.equal(verdict.ok, false);
  assert.match(String(verdict.reason), /4x4/);
});

test('referee rejects sparse rows instead of treating holes as valid tiles', () => {
  const sparse = /** @type {Board} */ ([
    Array(4),
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
  ]);
  const verdict = referee(sparse, 'left', sparse);
  assert.equal(verdict.ok, false);
  assert.match(String(verdict.reason), /4x4/);
});

test('referee rejects non-power-of-two tiles', () => {
  const prev = board([
    [3, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
  ]);
  const next = placeTile(slide(prev, 'right').board, 3, 0, 2);
  const verdict = referee(prev, 'right', next);
  assert.equal(verdict.ok, false);
  assert.match(String(verdict.reason), /4x4/);
});

test('referee rejects extra board and row properties', () => {
  const prev = board([
    [2, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
  ]);
  const next = placeTile(slide(prev, 'left').board, 3, 3, 2);
  /** @type {*} */ (prev).extra = 1;
  /** @type {*} */ (next[0]).extra = 1;
  const verdict = referee(prev, 'left', next);
  assert.equal(verdict.ok, false);
  assert.match(String(verdict.reason), /4x4/);
});

test('referee records a deterministic fallback without counting an agent move', () => {
  const prev = board([
    [0, 2, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
  ]);
  const next = placeTile(slide(prev, 'left').board, 3, 3, 2);
  const verdict = referee(prev, null, next);
  assert.equal(verdict.ok, true);
  assert.equal(verdict.applied, 'left');
  assert.equal(verdict.agentMove, false);
  assert.equal(verdict.diverged, false);
  assert.match(String(verdict.reason), /fallback/);
});


test('referee rejects an invalid chosen direction', () => {
  const prev = board([
    [2, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
  ]);
  const next = placeTile(slide(prev, 'left').board, 3, 3, 2);
  const verdict = referee(prev, /** @type {*} */ ('UP'), next);
  assert.equal(verdict.ok, false);
  assert.match(String(verdict.reason), /invalid direction/);
});
