import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import { loadOverlayModules } from './overlay-loader.js';
import { playBridgeSession } from './session.js';
import { verifyBridgeLog } from './session-log.js';
import { greedy, engine } from '../games/2048/baselines.js';

/**
 * A fixture page with its own small, independent 2048 implementation in an
 * inline script, using exactly the DOM the overlay's Play2048Adapter reads:
 * `.game-container`, `.tile-container`, `.tile` elements with
 * `tile-<value>` and `tile-position-<col>-<row>` classes, a `.score-container`
 * and a `.game-over` element when the board locks. Spawns come from a Lehmer
 * LCG so the page is deterministic; the implementation is the page's own, not
 * Gauntlet's rules.
 */
const CLEAN_PAGE = `<!doctype html>
<html><body>
<div class="game-container">
  <div class="score-container"><div class="score">0</div></div>
  <div class="tile-container"></div>
</div>
<script>
(function () {
  var board = [[0,0,0,0],[0,0,0,0],[0,0,0,0],[0,0,0,0]];
  var seed = 987654321;
  function rnd() { seed = (seed * 48271) % 2147483647; return seed / 2147483647; }
  function spawn() {
    var cells = [];
    for (var r = 0; r < 4; r++) for (var c = 0; c < 4; c++) if (board[r][c] === 0) cells.push([r, c]);
    if (cells.length === 0) return;
    var cell = cells[Math.floor(rnd() * cells.length)];
    board[cell[0]][cell[1]] = rnd() < 0.9 ? 2 : 4;
  }
  function mergeOnce(vals) {
    var out = [];
    for (var i = 0; i < vals.length; i++) {
      if (i + 1 < vals.length && vals[i] === vals[i + 1]) { out.push(vals[i] * 2); i++; }
      else out.push(vals[i]);
    }
    return out;
  }
  function slideLine(line) {
    var vals = line.filter(function (v) { return v !== 0; });
    vals = mergeOnce(vals);
    while (vals.length < 4) vals.push(0);
    return vals;
  }
  function move(dir) {
    var before = JSON.stringify(board);
    if (dir === 'left' || dir === 'right') {
      board = board.map(function (row) {
        var s = slideLine(dir === 'left' ? row : row.slice().reverse());
        return dir === 'left' ? s : s.reverse();
      });
    } else {
      for (var c = 0; c < 4; c++) {
        var col = [board[0][c], board[1][c], board[2][c], board[3][c]];
        var s = slideLine(dir === 'up' ? col : col.slice().reverse());
        if (dir === 'down') s.reverse();
        for (var r = 0; r < 4; r++) board[r][c] = s[r];
      }
    }
    if (JSON.stringify(board) !== before) spawn();
    updateGameOver();
    render();
  }
  function canMove() {
    for (var r = 0; r < 4; r++) for (var c = 0; c < 4; c++) {
      if (board[r][c] === 0) return true;
      if (c < 3 && board[r][c + 1] === board[r][c] && board[r][c] !== 0) return true;
      if (r < 3 && board[r + 1][c] === board[r][c] && board[r][c] !== 0) return true;
    }
    return false;
  }
  function updateGameOver() {
    var existing = document.querySelector('.game-over');
    if (!canMove()) {
      if (!existing) {
        var el = document.createElement('div');
        el.className = 'game-over';
        document.querySelector('.game-container').appendChild(el);
      }
    } else if (existing) {
      existing.remove();
    }
  }
  function render() {
    var container = document.querySelector('.tile-container');
    container.innerHTML = '';
    for (var r = 0; r < 4; r++) for (var c = 0; c < 4; c++) {
      if (board[r][c] === 0) continue;
      var tile = document.createElement('div');
      tile.className = 'tile tile-' + board[r][c] + ' tile-position-' + (c + 1) + '-' + (r + 1);
      tile.textContent = String(board[r][c]);
      container.appendChild(tile);
    }
  }
  document.addEventListener('keydown', function (e) {
    var map = { ArrowUp: 'up', ArrowRight: 'right', ArrowDown: 'down', ArrowLeft: 'left' };
    if (map[e.key]) move(map[e.key]);
  });
  spawn(); spawn(); render();
})();
</script>
</body></html>`;

/**
 * The tampered page: the same implementation, but its slide runs the merge
 * pass twice, so a line of four 2s becomes an 8 where the rules produce two
 * 4s. It starts on a board whose strongest move merges four 2s, so the
 * referee must flag the divergence on the first move.
 */
const TAMPERED_PAGE = `<!doctype html>
<html><body>
<div class="game-container">
  <div class="score-container"><div class="score">0</div></div>
  <div class="tile-container"></div>
</div>
<script>
(function () {
  var board = [[2,2,2,2],[2,0,0,0],[0,0,0,0],[0,0,0,0]];
  function mergeOnce(vals) {
    var out = [];
    for (var i = 0; i < vals.length; i++) {
      if (i + 1 < vals.length && vals[i] === vals[i + 1]) { out.push(vals[i] * 2); i++; }
      else out.push(vals[i]);
    }
    return out;
  }
  function slideLine(line) {
    var vals = line.filter(function (v) { return v !== 0; });
    vals = mergeOnce(vals);
    vals = mergeOnce(vals); /* the tamper: a tile merges twice in one move */
    while (vals.length < 4) vals.push(0);
    return vals;
  }
  function move(dir) {
    if (dir === 'left' || dir === 'right') {
      board = board.map(function (row) {
        var s = slideLine(dir === 'left' ? row : row.slice().reverse());
        return dir === 'left' ? s : s.reverse();
      });
    } else {
      for (var c = 0; c < 4; c++) {
        var col = [board[0][c], board[1][c], board[2][c], board[3][c]];
        var s = slideLine(dir === 'up' ? col : col.slice().reverse());
        if (dir === 'down') s.reverse();
        for (var r = 0; r < 4; r++) board[r][c] = s[r];
      }
    }
    render();
  }
  function render() {
    var container = document.querySelector('.tile-container');
    container.innerHTML = '';
    for (var r = 0; r < 4; r++) for (var c = 0; c < 4; c++) {
      if (board[r][c] === 0) continue;
      var tile = document.createElement('div');
      tile.className = 'tile tile-' + board[r][c] + ' tile-position-' + (c + 1) + '-' + (r + 1);
      tile.textContent = String(board[r][c]);
      container.appendChild(tile);
    }
  }
  document.addEventListener('keydown', function (e) {
    var map = { ArrowUp: 'up', ArrowRight: 'right', ArrowDown: 'down', ArrowLeft: 'left' };
    if (map[e.key]) move(map[e.key]);
  });
  render();
})();
</script>
</body></html>`;

/**
 * Mount a fixture page, expose the pieces the overlay touches as Node
 * globals, and build the real adapter and driver from `src/`.
 *
 * @param {string} html
 * @returns {Promise<{ dom: JSDOM, adapter: *, driver: * }>}
 */
async function mountFixture(html) {
  const dom = new JSDOM(html, { runScripts: 'dangerously', url: 'https://play2048.test/' });
  /** @type {any} */ (globalThis).document = dom.window.document;
  /** @type {any} */ (globalThis).KeyboardEvent = dom.window.KeyboardEvent;
  const overlay = await loadOverlayModules();
  const adapter = new overlay.Play2048Adapter();
  assert.equal(adapter.canAttach(), true, 'the fixture page must be detectable by the real adapter');
  const driver = new overlay.Driver({
    throttleMs: 5,
    domChangeTimeoutMs: 10,
    pauseWhenHidden: false,
  });
  driver.setAdapter(adapter);
  return { dom, adapter, driver };
}

test('a Gauntlet baseline drives a live fixture page through the real adapter and driver, and every move passes the referee', async () => {
  const { dom, adapter, driver } = await mountFixture(CLEAN_PAGE);
  try {
    const result = await playBridgeSession({ adapter, driver, agent: greedy() }, { maxMoves: 200 });
    assert.ok(result.moves > 0, 'the session should play at least one move');
    assert.ok(
      result.endedWhy === 'game-over' || result.endedWhy === 'move-cap',
      `unexpected ending: ${result.endedWhy}`,
    );
    for (const step of result.log.steps) {
      assert.equal(step.verdict.ok, true, `referee rejected move ${step.turn}: ${step.verdict.reason}`);
      assert.notEqual(step.applied, null);
    }
    const verified = verifyBridgeLog(result.log);
    assert.equal(verified.ok, true);
    if (verified.ok) {
      assert.deepEqual(verified.finalBoard, result.log.steps[result.log.steps.length - 1].boardAfter);
    }
  } finally {
    dom.window.close();
    delete (/** @type {any} */ (globalThis)).document;
    delete (/** @type {any} */ (globalThis)).KeyboardEvent;
  }
});

test('the expectimax engine baseline plays a live fixture page end to end', async () => {
  const { dom, adapter, driver } = await mountFixture(CLEAN_PAGE);
  try {
    const result = await playBridgeSession({ adapter, driver, agent: engine({ depth: 2 }) }, { maxMoves: 200 });
    assert.ok(result.moves > 0);
    assert.ok(
      result.endedWhy === 'game-over' || result.endedWhy === 'move-cap',
      `unexpected ending: ${result.endedWhy}`,
    );
    for (const step of result.log.steps) {
      assert.equal(step.verdict.ok, true, `referee rejected move ${step.turn}: ${step.verdict.reason}`);
    }
    assert.equal(verifyBridgeLog(result.log).ok, true);
  } finally {
    dom.window.close();
    delete (/** @type {any} */ (globalThis)).document;
    delete (/** @type {any} */ (globalThis)).KeyboardEvent;
  }
});

test('a tampered page that merges a tile twice is flagged by the referee and the session stops with that reason', async () => {
  const { dom, adapter, driver } = await mountFixture(TAMPERED_PAGE);
  try {
    const result = await playBridgeSession({ adapter, driver, agent: greedy() }, { maxMoves: 200 });
    assert.equal(result.moves, 1, 'the session must stop at the first tampered move');
    assert.match(result.endedWhy, /^referee: /);
    const last = result.log.steps[0];
    assert.equal(last.chosen, 'right', 'greedy should choose the four-2s merge');
    assert.equal(last.verdict.ok, false);
    assert.equal(last.verdict.applied, null);
    assert.equal(last.verdict.spawn, null);
    assert.match(String(result.log.ended?.reason), /referee: /);
    const verified = verifyBridgeLog(result.log);
    assert.equal(verified.ok, false);
    if (!verified.ok) {
      assert.equal(verified.index, 0);
    }
  } finally {
    dom.window.close();
    delete (/** @type {any} */ (globalThis)).document;
    delete (/** @type {any} */ (globalThis)).KeyboardEvent;
  }
});
