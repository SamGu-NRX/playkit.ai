import { test } from 'node:test';
import assert from 'node:assert/strict';

import { referee } from './referee.js';
import { createBridgeLog, recordStep, endBridgeLog, verifyBridgeLog } from './session-log.js';
import { placeTile, slide } from '../games/2048/rules.js';

/** @import { Board } from '../games/2048/rules.js' */

const INITIAL = /** @type {Board} */ ([
  [0, 2, 0, 0],
  [0, 0, 0, 0],
  [0, 0, 0, 0],
  [0, 0, 0, 0],
]);

/**
 * A two-step log built from real referee verdicts, like a clean session.
 * @returns {ReturnType<typeof createBridgeLog>}
 */
function cleanLog() {
  const log = createBridgeLog({
    game: { id: '2048', version: '1.0.0' },
    agent: { id: '2048-greedy', track: 'baseline' },
    initialBoard: INITIAL,
    startedAt: '2026-10-15T00:00:00.000Z',
  });
  let board = INITIAL;
  for (const dir of /** @type {const} */ (['left', 'down'])) {
    const slid = slide(board, dir).board;
    const spawnCell = dir === 'left' ? [3, 3] : [0, 3];
    const after = placeTile(slid, spawnCell[0], spawnCell[1], 2);
    const verdict = referee(board, dir, after);
    assert.equal(verdict.ok, true);
    recordStep(log, { turn: log.steps.length, boardBefore: board, boardAfter: after, verdict });
    board = after;
  }
  endBridgeLog(log, { reason: 'move-cap', turn: 2, finishedAt: '2026-10-15T00:01:00.000Z' });
  return log;
}

test('a clean session log carries the format, records and ending', () => {
  const log = cleanLog();
  assert.equal(log.format, 'playkit-gauntlet-bridge-log/1');
  assert.equal(log.steps.length, 2);
  assert.equal(log.ended?.reason, 'move-cap');
  assert.equal(log.steps[0].chosen, 'left');
  assert.equal(log.steps[0].applied, 'left');
  assert.equal(log.steps[0].diverged, false);
});

test('verifyBridgeLog replays a clean log exactly', () => {
  const log = cleanLog();
  const result = verifyBridgeLog(log);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(result.finalBoard, log.steps[log.steps.length - 1].boardAfter);
  }
});

test('verifyBridgeLog rejects a tampered recorded board', () => {
  const log = cleanLog();
  log.steps[1].boardAfter[0][0] = 1024;
  const result = verifyBridgeLog(log);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.index, 1);
    assert.match(result.reason, /does not reproduce/);
  }
});

test('verifyBridgeLog rejects a step whose spawn was dropped', () => {
  const log = cleanLog();
  log.steps[0].spawn = null;
  const result = verifyBridgeLog(log);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.index, 0);
  }
});

test('verifyBridgeLog rejects a step the referee did not pass', () => {
  const log = cleanLog();
  log.steps[0].verdict = {
    ok: false,
    direction: 'left',
    applied: null,
    spawn: null,
    diverged: true,
    reason: 'tampered',
  };
  const result = verifyBridgeLog(log);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.index, 0);
    assert.match(result.reason, /referee/);
  }
});

test('verifyBridgeLog rejects an unknown format', () => {
  const log = cleanLog();
  log.format = /** @type {*} */ ('something-else/9');
  const result = verifyBridgeLog(log);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.index, -1);
  }
});

test('verifyBridgeLog accepts an empty log', () => {
  const log = createBridgeLog({
    game: { id: '2048', version: '1.0.0' },
    agent: { id: '2048-greedy', track: 'baseline' },
    initialBoard: INITIAL,
  });
  const result = verifyBridgeLog(log);
  assert.equal(result.ok, true);
});
