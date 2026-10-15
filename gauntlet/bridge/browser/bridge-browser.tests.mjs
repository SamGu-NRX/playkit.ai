import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { chromium } from 'playwright';

import { ensureBookmarkletBundle, parseBookmarklet, runBrowserSession, latencyStats } from './harness.mjs';
import { startFixtureServer } from './server.mjs';
import { verifyBridgeLog } from '../session-log.js';
import { maxTile } from '../../games/2048/rules.js';

/** Shared fixture state: one server, one browser, per-test pages. */
let server;
let browser;
let port;
let bookmarkletCode;

before(async () => {
  // The repo's own bundler builds dist/2048-hud.min.js from src/runtime/bookmarklet.js.
  await ensureBookmarkletBundle();
  server = await startFixtureServer();
  port = server.port;
  const loaderSource = await readFile(
    resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..', 'src', 'bookmarklet', 'loader.js'),
    'utf8',
  );
  // Fail fast if the loader no longer looks like the bookmarklet this harness pastes.
  bookmarkletCode = parseBookmarklet(loaderSource, port);
  browser = await chromium.launch({ headless: true, chromiumSandbox: false });
});

after(async () => {
  if (browser) await browser.close();
  if (server) await server.close();
});

/**
 * Shared assertions for a clean baseline session: the agent drove the real
 * page through the real adapter and driver, every transition passed the
 * referee, and the whole session log verifies by replay.
 *
 * @param {Awaited<ReturnType<typeof runBrowserSession>>} report
 * @returns {{ summary: object, finalBoard: number[][] }}
 */
function assertCleanSession(report) {
  assert.equal(report.adapterName, 'Play2048Adapter', 'the runtime must attach its Play2048Adapter');
  assert.equal(report.log.format, 'playkit-gauntlet-bridge-log/1');
  assert.ok(report.moves > 0, 'the session must play at least one move');
  assert.equal(report.moves, report.log.steps.length, 'moves and recorded steps agree');
  assert.ok(
    report.endedWhy === 'move-cap' || report.endedWhy === 'game-over',
    `unexpected ending: ${report.endedWhy}`,
  );

  for (const step of report.log.steps) {
    assert.equal(step.verdict.ok, true, `referee rejected move ${step.turn}: ${step.verdict.reason}`);
    assert.notEqual(step.applied, null);
  }
  const verified = verifyBridgeLog(report.log);
  assert.equal(verified.ok, true, verified.ok ? '' : `log replay failed at step ${verified.index}: ${verified.reason}`);
  const last = report.log.steps[report.log.steps.length - 1];
  if (verified.ok) {
    assert.deepEqual(verified.finalBoard, last.boardAfter);
  }

  const lat = latencyStats(report.perMoveMs);
  const summary = {
    agent: report.log.agent.id,
    moves: report.moves,
    endedWhy: report.endedWhy,
    diverged: report.diverged,
    divergedShare: `${((100 * report.diverged) / report.moves).toFixed(1)}%`,
    refereeRejections: report.log.steps.filter((s) => !s.verdict.ok).length,
    finalScore: report.finalScore,
    finalMaxTile: maxTile(last.boardAfter),
    perMoveMs: {
      mean: Number(lat.mean.toFixed(1)),
      p50: Number(lat.p50.toFixed(1)),
      p95: Number(lat.p95.toFixed(1)),
      max: Number(lat.max.toFixed(1)),
    },
    userAgent: report.userAgent,
  };
  return { summary, finalBoard: verified.ok ? verified.finalBoard : last.boardAfter };
}

test('greedy baseline plays the vendored 2048 page in real Chromium through the bookmarklet runtime, refereed move by move', { timeout: 420000 }, async () => {
  const report = await runBrowserSession({ browser, port, agent: 'greedy', maxMoves: 200 });
  const { summary } = assertCleanSession(report);
  console.log('[bridge-browser] session summary:', JSON.stringify(summary));
  assert.ok(summary.moves >= 150, `expected a long session, stopped at ${summary.moves} (${summary.endedWhy})`);
});

test('expectimax engine baseline plays the vendored 2048 page in real Chromium through the bookmarklet runtime, refereed move by move', { timeout: 420000 }, async () => {
  const report = await runBrowserSession({ browser, port, agent: 'engine', maxMoves: 200 });
  const { summary } = assertCleanSession(report);
  console.log('[bridge-browser] session summary:', JSON.stringify(summary));
  assert.ok(summary.moves >= 150, `expected a long session, stopped at ${summary.moves} (${summary.endedWhy})`);
});

test('a session that never reports times out, reaches cleanup, and raises no unhandled rejection', { timeout: 120000 }, async () => {
  // Greptile P2 #4285440537: the timeout used to reject a promise that nothing
  // consumed until the page work finished, so a session whose report never
  // arrived produced an unhandled rejection (skipping cleanup) and the timer
  // outlived successful runs. A tiny timeout against a healthy page forces the
  // timeout path deterministically: the rejection must surface here as the
  // session's own timeout error, the browser context must be closed, and no
  // unhandled rejection may fire.
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(String(reason));
  process.on('unhandledRejection', onUnhandled);
  try {
    await assert.rejects(
      runBrowserSession({ browser, port, agent: 'greedy', maxMoves: 1, timeoutMs: 250 }),
      /timed out/,
      'the timeout must reject the session promise itself',
    );
    assert.equal(browser.contexts().length, 0, 'the session context must be closed after the timeout');
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.deepEqual(unhandled, [], 'the timeout must not surface as an unhandled rejection');
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('a copy of the vendored game that merges a tile twice in one move is flagged on its first offending move and the session stops with that reason', { timeout: 420000 }, async () => {
  // Pinned page RNG: the tampered run is fully reproducible, so "first
  // offending move" is a fixed, observable transition.
  const report = await runBrowserSession({
    browser,
    port,
    agent: 'greedy',
    maxMoves: 200,
    urlPath: '/2048-faulty/',
    seed: 987654321,
  });

  assert.equal(report.adapterName, 'Play2048Adapter');
  assert.match(report.endedWhy, /^referee: /, `session must stop at the referee, got: ${report.endedWhy}`);
  const offending = report.log.steps[report.log.steps.length - 1];
  assert.equal(offending.verdict.ok, false, 'the last recorded move is the first offending one');
  // A double-merge cascade typically produces a board no single slide can
  // explain (verdict.applied === null); a settled-cell violation keeps the
  // slide with diverged === true. Both are rejections — require the reason.
  assert.ok(
    offending.verdict.reason,
    `the offending verdict carries a reason (applied=${offending.verdict.applied}, diverged=${offending.verdict.diverged})`,
  );
  assert.notEqual(offending.boardBefore, null);
  assert.notEqual(offending.boardAfter, null);
  for (const step of report.log.steps.slice(0, -1)) {
    assert.equal(step.verdict.ok, true, 'every move before the offending one must have passed the referee');
  }
  assert.equal(report.moves, report.log.steps.length);

  const verified = verifyBridgeLog(report.log);
  assert.equal(verified.ok, false, 'the tampered log must fail replay verification');
  if (!verified.ok) {
    assert.equal(verified.index, report.log.steps.length - 1, 'replay fails exactly at the offending move');
  }

  const summary = {
    agent: report.log.agent.id,
    endedWhy: report.endedWhy,
    offendingMove: offending.turn,
    chosen: offending.chosen,
    boardBefore: offending.boardBefore,
    boardAfter: offending.boardAfter,
    refereeReason: offending.verdict.reason,
    refereeApplied: offending.verdict.applied,
    refereeDiverged: offending.verdict.diverged,
    replayCheck: verified.ok ? 'passed' : `failed at step ${verified.index}: ${verified.reason}`,
  };
  console.log('[bridge-browser] fault-check summary:', JSON.stringify(summary));
  assert.ok(
    summary.offendingMove <= 150,
    `the tamper should surface within a bounded session, got move ${summary.offendingMove}`,
  );
});
