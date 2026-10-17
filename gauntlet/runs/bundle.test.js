/**
 * Bundle verification tests: run a real fixture suite into a temp directory,
 * then verify the bundle as a third party would — happy path, tampered
 * trajectory, manifest-hash mismatch, missing episode, a stray
 * trajectory-format file, and page sessions (`gauntlet page` output), both
 * beside trajectories and as a standalone bundle. Page-session cases replay a
 * recorded real bridge-log fixture, so they stay offline.
 *
 * @module
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildSuite } from '../scoring/suite.js';
import { takeOrPass } from '../scoring/fixtures.js';
import { TRAJECTORY_FORMAT } from '../core/trajectory.js';

import { runSuite } from './run.js';
import { planJobs } from './plan.js';
import { trajectoryPath } from './fsutil.js';
import { verifyBundle } from './bundle.js';

/** @import { Agent, Game } from '../core/types.js' */

const SUITE = buildSuite([takeOrPass], { split: 'public' });

/** A deterministic one-call agent that always takes.
 *
 * @returns {(job: *) => Agent}
 */
function takeFactory() {
  return () => /** @type {Agent} */ ({
    id: 'bundler',
    track: 'community',
    async act() {
      return { text: 'take', usage: { inputTokens: 10, outputTokens: 1, costUsd: 0.001 } };
    },
  });
}

/** @param {string} label */
async function tempDir(label) {
  return mkdtemp(path.join(tmpdir(), `gauntlet-bundle-${label}-`));
}

test('a complete run verifies as a bundle and re-scores ranked', async () => {
  const outDir = await tempDir('happy');
  try {
    const result = await runSuite({ suite: SUITE, games: [takeOrPass], agentFactory: takeFactory(), outDir });
    assert.equal(result.stopped, null);

    const bundle = await verifyBundle(outDir, [takeOrPass]);
    assert.equal(bundle.ok, true);
    assert.equal(bundle.manifestHash.ok, true);
    assert.equal(bundle.manifestHash.recorded, bundle.manifestHash.actual);
    assert.deepEqual(bundle.stray, []);
    assert.equal(bundle.scoreError, null);
    assert.ok(bundle.score, 'scoring should not refuse a complete bundle');
    assert.equal(bundle.score.ranked, true);
    assert.equal(bundle.score.unrankedReason, null);
    assert.equal(bundle.score.episodes, 2);
    // Take-or-pass is a benchmark game and 'take' scores its top normalized
    // value, so the benchmark score is exactly 1.
    assert.equal(bundle.score.benchmarkScore.value, 1);
    assert.equal(bundle.score.games['take-or-pass'].score.value, 1);
    // Cost comes from the trajectory usage records, not from run.json alone.
    assert.ok(Math.abs(bundle.score.costUsd - 0.002) < 1e-9);
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});

test('a tampered trajectory fails verification and the recomputed score refuses', async () => {
  const outDir = await tempDir('tamper');
  try {
    await runSuite({ suite: SUITE, games: [takeOrPass], agentFactory: takeFactory(), outDir });
    const jobs = planJobs(SUITE);
    const victim = trajectoryPath(outDir, jobs[0]);
    const trajectory = JSON.parse(await readFile(victim, 'utf8'));
    trajectory.steps[0].action = 'zzz';
    await writeFile(victim, JSON.stringify(trajectory, null, 2));

    const bundle = await verifyBundle(outDir, [takeOrPass]);
    assert.equal(bundle.ok, false);
    const verdict = bundle.trajectories.find((v) => v.key === jobs[0].key);
    if (!verdict) assert.fail('the tampered episode has a verdict');
    assert.equal(verdict.ok, false);
    assert.ok(verdict.reason && verdict.reason.length > 0);
    // Scoring refuses on the failed verification rather than scoring a lie.
    assert.equal(bundle.score, null);
    assert.match(String(bundle.scoreError), /fails verifyTrajectory/);
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});

test('a manifest-hash mismatch fails the bundle without touching trajectory verdicts', async () => {
  const outDir = await tempDir('hash');
  try {
    await runSuite({ suite: SUITE, games: [takeOrPass], agentFactory: takeFactory(), outDir });
    const runPath = path.join(outDir, 'run.json');
    const run = JSON.parse(await readFile(runPath, 'utf8'));
    run.suite.manifestSha256 = '0'.repeat(64);
    await writeFile(runPath, JSON.stringify(run, null, 2));

    const bundle = await verifyBundle(outDir, [takeOrPass]);
    assert.equal(bundle.manifestHash.ok, false);
    assert.equal(bundle.ok, false);
    // The trajectories themselves still verify — the hash is the problem.
    assert.equal(bundle.scoreError, null);
    assert.ok(bundle.score);
    assert.equal(bundle.score.ranked, true);
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});

test('a missing episode file is unranked, not refused', async () => {
  const outDir = await tempDir('missing');
  try {
    await runSuite({ suite: SUITE, games: [takeOrPass], agentFactory: takeFactory(), outDir });
    const jobs = planJobs(SUITE);
    await rm(trajectoryPath(outDir, jobs[1]));

    const bundle = await verifyBundle(outDir, [takeOrPass]);
    assert.equal(bundle.ok, false);
    const verdict = bundle.trajectories.find((v) => v.key === jobs[1].key);
    if (!verdict) assert.fail('the missing episode has a verdict');
    assert.equal(verdict.ok, false);
    assert.match(String(verdict.reason), /missing/);
    assert.ok(bundle.score);
    assert.equal(bundle.score.ranked, false);
    assert.match(String(bundle.score.unrankedReason), /missing episodes/);
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});

test('a stray trajectory-format file that no job owns fails the bundle', async () => {
  const outDir = await tempDir('stray');
  try {
    await runSuite({ suite: SUITE, games: [takeOrPass], agentFactory: takeFactory(), outDir });
    const strayPath = path.join(outDir, 'take-or-pass', 'main', 'zzz.json');
    await writeFile(
      strayPath,
      JSON.stringify({ format: TRAJECTORY_FORMAT, note: 'not a planned episode' })
    );

    const bundle = await verifyBundle(outDir, [takeOrPass]);
    assert.deepEqual(bundle.stray, ['take-or-pass/main/zzz.json']);
    assert.equal(bundle.ok, false);
    // Planned episodes still verify and score.
    assert.ok(bundle.score);
    assert.equal(bundle.score.ranked, true);
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});

test('verifyBundle refuses a directory with no suite.json', async () => {
  const outDir = await tempDir('empty');
  try {
    await assert.rejects(verifyBundle(outDir, [takeOrPass]), /no readable suite\.json/);
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});

// Page sessions (`gauntlet page` output) — verified from the recorded
// model-session fixture, a real bridge log, so these cases stay offline.

const FIXTURE_LOG = fileURLToPath(new URL('../bridge/browser/fixtures/model-session-2048.json', import.meta.url));

/** @param {string} label */
async function tempPageDir(label) {
  return mkdtemp(path.join(tmpdir(), `gauntlet-bundle-page-${label}-`));
}

/** Writes page/<seed>.json plus page/run.json (the `gauntlet page`
 * provenance record, which is not itself a session log).
 *
 * @param {string} outDir
 * @param {((log: any) => void) | undefined} [tamper] Receives the parsed log
 *   before it is written.
 */
async function writePageSession(outDir, tamper) {
  await mkdir(path.join(outDir, 'page'), { recursive: true });
  const log = JSON.parse(await readFile(FIXTURE_LOG, 'utf8'));
  if (tamper) tamper(log);
  await writeFile(path.join(outDir, 'page', '11111.json'), JSON.stringify(log, null, 2) + '\n');
  await writeFile(
    path.join(outDir, 'page', 'run.json'),
    JSON.stringify({
      format: 'playkit-gauntlet-page-run/1',
      agent: { spec: 'model:openai-chat/stub', id: log.agent.id, track: log.agent.track },
      seed: 11111,
      logFile: 'page/11111.json',
      verify: { ok: true },
    }) + '\n'
  );
}

test('page sessions in a run bundle verify alongside trajectories without affecting scoring', async () => {
  const outDir = await tempPageDir('mixed');
  try {
    await runSuite({ suite: SUITE, games: [takeOrPass], agentFactory: takeFactory(), outDir });
    await writePageSession(outDir);

    const bundle = await verifyBundle(outDir, [takeOrPass]);
    assert.equal(bundle.pageOnly, false);
    assert.equal(bundle.pageSessions.length, 1, 'page/run.json is provenance, not a session log');
    assert.equal(bundle.pageSessions[0].file, 'page/11111.json');
    assert.equal(bundle.pageSessions[0].ok, true);
    assert.equal(bundle.pageSessions[0].steps, 150);
    assert.equal(bundle.ok, true);
    // Scoring is trajectory business: page sessions ride along, un-scored.
    assert.ok(bundle.score);
    assert.equal(bundle.score.ranked, true);
    assert.equal(bundle.score.episodes, 2);
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});

test('a standalone page-session bundle verifies with no suite manifest at all', async () => {
  const outDir = await tempPageDir('standalone');
  try {
    await writePageSession(outDir);

    const bundle = await verifyBundle(outDir, [takeOrPass]);
    assert.equal(bundle.pageOnly, true);
    assert.equal(bundle.pageSessions.length, 1);
    assert.equal(bundle.pageSessions[0].ok, true);
    assert.equal(bundle.ok, true);
    assert.equal(bundle.run, null);
    assert.deepEqual(bundle.stray, []);
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});

test('a tampered page session fails verification at the offending step', async () => {
  const outDir = await tempPageDir('tamper');
  try {
    await writePageSession(outDir, (log) => {
      // Flip one boardBefore cell of the first step: the replay starts from
      // the log's own start board and must refuse the mismatch at step 0.
      log.steps[0].boardBefore[0][0] = log.steps[0].boardBefore[0][0] === 0 ? 2 : 0;
    });

    const bundle = await verifyBundle(outDir, [takeOrPass]);
    assert.equal(bundle.ok, false);
    assert.equal(bundle.pageSessions.length, 1);
    const verdict = bundle.pageSessions[0];
    assert.equal(verdict.ok, false);
    assert.match(String(verdict.reason), /verifyBridgeLog \(step 0\)/);
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});

// Spend ledger (`spend.jsonl`) — bundle verify checks the recorded spend
// against the trajectories: well-formed and chain-intact, and every kept call
// matches a trajectory step. A one-call priced agent builds the bundles.

/** A deterministic one-call agent that always takes, at $0.05 per call. */
function takeAtFiveCentsFactory({ text = 'take' } = {}) {
  return () => /** @type {Agent} */ ({
    id: 'bundler-priced',
    track: 'community',
    async act() {
      return { text, usage: { inputTokens: 10, outputTokens: 1, costUsd: 0.05 } };
    },
  });
}

/**
 * A one-seat fixture game where every episode takes exactly `calls` agent
 * calls (the agent always says 'go').
 *
 * @param {string} id
 * @param {number} calls
 * @param {number} publicSeeds
 */
function makeMultiCallGame(id, calls, publicSeeds) {
  return /** @type {Game<{ remaining: number }>} */ ({
    spec: {
      id,
      version: '1.0.0',
      title: id,
      seats: 1,
      information: 'perfect',
      stochastic: false,
      tags: [],
      benchmark: true,
      requires: [],
      rulesText: 'Say "go" until the counter reaches zero.',
      tiers: [
        { id: 'main', rank: 1, scoring: 'outcome', maxActions: 64, publicSeeds, params: {} },
      ],
    },
    reset() {
      return { remaining: calls };
    },
    toAct(state) {
      return state.remaining <= 0 ? null : 0;
    },
    observe(state) {
      return { text: `remaining ${state.remaining}`, data: { remaining: state.remaining } };
    },
    legalActions() {
      return ['go'];
    },
    parseAction(_state, _seat, text) {
      return text.trim().toLowerCase() === 'go'
        ? { ok: true, action: 'go' }
        : { ok: false, error: 'the only action is "go"' };
    },
    step(state) {
      return { remaining: state.remaining - 1 };
    },
    outcome() {
      return { normalized: [1], raw: [0], reason: 'done' };
    },
    truncate() {
      return { normalized: [0], raw: null, reason: 'ran out of budget' };
    },
  });
}

/**
 * Rewrites the bundle's ledger through `transform` (an array of line objects
 * in, an array out), re-chaining every prev hash the way a tamperer must.
 *
 * @param {string} outDir
 * @param {(lines: any[]) => any[]} transform
 */
async function rewriteLedgerReChained(outDir, transform) {
  const ledgerFile = path.join(outDir, 'spend.jsonl');
  const text = await readFile(ledgerFile, 'utf8');
  const values = text.split('\n').filter((l) => l.trim().length > 0).map((l) => JSON.parse(l));
  const out = transform(values);
  /** @type {string | null} */
  let prev = null;
  const retext = out.map((value) => {
    const line = JSON.stringify({ ...value, prev });
    prev = createHash('sha256').update(line).digest('hex');
    return line;
  });
  await writeFile(ledgerFile, retext.join('\n') + '\n', 'utf8');
}

test('a capped run verifies as a bundle and the ledger matches the trajectories', async () => {
  const outDir = await tempDir('ledger-happy');
  try {
    // $0.10 is the whole suite (2 episodes x 1 call x $0.05): the cap does
    // not bind, so every episode is kept and the ledger must match the
    // trajectories exactly.
    await runSuite({
      suite: SUITE,
      games: [takeOrPass],
      agentFactory: takeAtFiveCentsFactory(),
      outDir,
      maxUsdTotal: 0.2,
    });

    const bundle = await verifyBundle(outDir, [takeOrPass]);
    assert.equal(bundle.ok, true);
    assert.ok(bundle.ledger && bundle.ledger.present, 'the bundle carries a spend ledger');
    assert.deepEqual(bundle.ledger.problems, []);
    assert.ok(Math.abs(bundle.ledger.totalUsd - 0.1) < 1e-9);
    assert.ok(Math.abs(bundle.ledger.trajectoryUsd - 0.1) < 1e-9);
    assert.equal(bundle.ledger.unwoundUsd, 0);
    assert.equal(bundle.ledger.invocations, 1);
    assert.equal(bundle.ledger.cap, 0.2);
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});

test('a mixed ledger (kept and unwound calls) still verifies', async () => {
  const multi = makeMultiCallGame('bundle-multi', 4, 2);
  const suite = buildSuite([multi], { split: 'public' });
  const outDir = await tempDir('ledger-mixed');
  try {
    // $0.25 admits five $0.05 calls. With concurrency pinned to 1, episode 1
    // finishes kept (4 calls) before episode 2 unwinds after one call — a
    // serial split, deterministic regardless of machine parallelism.
    const first = await runSuite({
      suite,
      games: [multi],
      agentFactory: takeAtFiveCentsFactory({ text: 'go' }),
      outDir,
      maxUsdTotal: 0.25,
      concurrency: 1,
    });
    assert.equal(first.stopped, 'budget');
    // The unwound episode re-runs on a raised-cap resume: its fresh calls are
    // kept and its trajectory verifies, while the discarded attempt's calls
    // stay in the ledger as unwound spend.
    const second = await runSuite({
      suite,
      games: [multi],
      agentFactory: takeAtFiveCentsFactory({ text: 'go' }),
      outDir,
      maxUsdTotal: 0.5,
      concurrency: 1,
      resume: true,
    });
    assert.equal(second.stopped, null);

    const bundle = await verifyBundle(outDir, [multi]);
    assert.equal(bundle.ok, true);
    assert.ok(bundle.ledger);
    assert.ok(Math.abs(bundle.ledger.totalUsd - 0.45) < 1e-9, 'eight kept calls plus the unwound one are recorded');
    assert.ok(Math.abs(bundle.ledger.keptUsd - 0.4) < 1e-9, 'every kept call matches a trajectory step');
    assert.ok(Math.abs(bundle.ledger.unwoundUsd - 0.05) < 1e-9, 'the unwound call is recorded and excluded');
    assert.ok(Math.abs(bundle.ledger.trajectoryUsd - 0.4) < 1e-9);
    assert.ok(bundle.ledger.totalUsd + 1e-9 >= bundle.ledger.trajectoryUsd, 'recorded spend covers the trajectories');
    assert.deepEqual(bundle.ledger.problems, []);
    assert.equal(bundle.ledger.cap, 0.5, 'the current cap after the raise');
    assert.equal(bundle.ledger.invocations, 2);
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});

test('dropping a ledger line fails the bundle on the hash chain', async () => {
  const multi = makeMultiCallGame('bundle-multi-drop', 4, 2);
  const suite = buildSuite([multi], { split: 'public' });
  const outDir = await tempDir('ledger-drop');
  try {
    await runSuite({ suite, games: [multi], agentFactory: takeAtFiveCentsFactory({ text: 'go' }), outDir, maxUsdTotal: 0.25 });
    // A naive tamperer drops a line without re-chaining what follows it.
    const ledgerFile = path.join(outDir, 'spend.jsonl');
    const lines = (await readFile(ledgerFile, 'utf8')).split('\n').filter((l) => l.trim().length > 0);
    await writeFile(ledgerFile, lines.filter((l, i) => i !== 1).join('\n') + '\n', 'utf8');

    const bundle = await verifyBundle(outDir, [multi]);
    assert.equal(bundle.ok, false);
    assert.ok(bundle.ledger, 'the bundle reports its ledger');
    assert.ok(
      bundle.ledger.problems.some((p) => /prev hash mismatch/.test(p)),
      'the naive tamper is caught by the chain even when a line is dropped'
    );
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});

test('dropping a kept call and re-chaining fails the bundle on trajectory coverage', async () => {
  const multi = makeMultiCallGame('bundle-multi-cover', 4, 2);
  const suite = buildSuite([multi], { split: 'public' });
  const outDir = await tempDir('ledger-cover');
  try {
    await runSuite({ suite, games: [multi], agentFactory: takeAtFiveCentsFactory({ text: 'go' }), outDir, maxUsdTotal: 0.25, concurrency: 1 });
    // A tamperer who re-chains escapes the hash check — but the kept episode
    // then has a trajectory step no ledger line accounts for.
    await rewriteLedgerReChained(outDir, (lines) => lines.filter((l) => !(l.kind === 'call' && l.kept && l.job.includes('public/0') && l.call === 0)));

    const bundle = await verifyBundle(outDir, [multi]);
    assert.equal(bundle.ok, false);
    assert.ok(bundle.ledger, 'the bundle reports its ledger');
    assert.ok(
      bundle.ledger.problems.some((p) => /not covered by a kept ledger line/.test(p)),
      'every trajectory usage step must be accounted for by a kept ledger line'
    );
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});

test('re-costing a kept call and re-chaining fails the bundle on cost mismatch', async () => {
  const multi = makeMultiCallGame('bundle-multi-cost', 4, 2);
  const suite = buildSuite([multi], { split: 'public' });
  const outDir = await tempDir('ledger-cost');
  try {
    await runSuite({ suite, games: [multi], agentFactory: takeAtFiveCentsFactory({ text: 'go' }), outDir, maxUsdTotal: 0.25, concurrency: 1 });
    await rewriteLedgerReChained(outDir, (lines) => lines.map((l) => (l.kind === 'call' && l.kept ? { ...l, costUsd: 0.01 } : l)));

    const bundle = await verifyBundle(outDir, [multi]);
    assert.equal(bundle.ok, false);
    assert.ok(bundle.ledger, 'the bundle reports its ledger');
    assert.ok(
      bundle.ledger.problems.some((p) => /not covered by a kept ledger line/.test(p)),
      'a re-costed ledger cannot account for the trajectory spend'
    );
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});
test('a kept usage line the runner discarded (episode time limit) still verifies', async () => {
  // When an episode time limit ends an episode mid-call, the runner discards
  // the late reply but the provider billed the call: the kept episode's ledger
  // carries one more kept usage line than the trajectory has usage steps.
  const multi = makeMultiCallGame('bundle-multi-overflow', 4, 1);
  const suite = buildSuite([multi], { split: 'public' });
  const outDir = await tempDir('ledger-overflow');
  try {
    await runSuite({ suite, games: [multi], agentFactory: takeAtFiveCentsFactory({ text: 'go' }), outDir, maxUsdTotal: 0.5 });
    // Append the discarded call as an extra trailing kept usage line.
    await rewriteLedgerReChained(outDir, (lines) => [
      ...lines,
      { kind: 'call', invocation: 0, job: lines.find((l) => l.kind === 'call')?.job ?? '', call: 4, costUsd: 0.03, inputTokens: 10, outputTokens: 1, usage: true, kept: true, chargedAtReservation: false },
    ]);

    const bundle = await verifyBundle(outDir, [multi]);
    assert.equal(bundle.ok, true, 'a discarded late reply is recorded spend, not a verification problem');
    assert.ok(bundle.ledger);
    assert.deepEqual(bundle.ledger.problems, []);
    assert.ok(
      bundle.ledger.totalUsd + 1e-9 >= bundle.ledger.trajectoryUsd + 0.03 - 1e-9,
      'the recorded total covers the trajectories plus the discarded call'
    );
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});



test('an unparseable ledger line fails the bundle', async () => {
  const outDir = await tempDir('ledger-garbage');
  try {
    await runSuite({ suite: SUITE, games: [takeOrPass], agentFactory: takeAtFiveCentsFactory(), outDir, maxUsdTotal: 0.002 });
    await writeFile(path.join(outDir, 'spend.jsonl'), 'not json\n', { flag: 'a' });

    const bundle = await verifyBundle(outDir, [takeOrPass]);
    assert.equal(bundle.ok, false);
    assert.ok(bundle.ledger, 'the bundle reports its ledger');
    assert.ok(bundle.ledger.problems.some((p) => /not json/i.test(p)));
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});

test('a bundle from before the ledger still verifies without one', async () => {
  const outDir = await tempDir('ledger-absent');
  try {
    await runSuite({ suite: SUITE, games: [takeOrPass], agentFactory: takeFactory(), outDir });
    await rm(path.join(outDir, 'spend.jsonl'));

    const bundle = await verifyBundle(outDir, [takeOrPass]);
    assert.equal(bundle.ok, true, 'the ledger is additive: old bundles stay verifiable');
    assert.ok(bundle.ledger);
    assert.equal(bundle.ledger.present, false);
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});
