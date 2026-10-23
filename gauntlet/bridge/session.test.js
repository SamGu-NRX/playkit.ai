import { test } from 'node:test';
import assert from 'node:assert/strict';

import { playBridgeSession } from './session.js';
import { placeTile, slide } from '../games/2048/rules.js';

const BEFORE = [
  [2, 0, 0, 4],
  [0, 0, 0, 0],
  [0, 0, 0, 0],
  [0, 0, 0, 0],
];
const AFTER = placeTile(slide(BEFORE, 'left').board, 3, 3, 2);

test('playBridgeSession excludes a driver fallback from agent move accounting', async () => {
  let board = BEFORE;
  /** @type {*} */
  const adapter = {
    readBoard() {
      return board;
    },
    getScore() {
      return 0;
    },
    isGameOver() {
      return false;
    },
  };
  /** @type {*} */
  const driver = {
    setSolverEngine(/** @type {*} */ engine) {
      this.engine = engine;
    },
    async step() {
      await this.engine.getMoveOrder(board);
      board = AFTER;
      return true;
    },
  };
  const agent = /** @type {import('../core/types.js').Agent} */ ({
    id: 'fallback-test-agent',
    track: 'baseline',
    async act() {
      return { text: 'up' };
    },
  });

  const result = await playBridgeSession({ adapter, driver, agent }, { maxMoves: 1 });

  assert.equal(result.moves, 1);
  assert.equal(result.agentMoves, 0);
  assert.equal(result.diverged, 0);
  assert.equal(result.log.steps[0].chosen, 'up');
  assert.equal(result.log.steps[0].applied, 'left');
  assert.equal(result.log.steps[0].agentMove, false);
});
