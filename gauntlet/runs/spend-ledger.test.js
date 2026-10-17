/**
 * The bundle spend ledger: a bundle-wide dollar cap (`--max-usd-total`) that
 * survives resumes via spend.jsonl, a per-call record of every paid call
 * (kept or unwound), rejected calls charged at their reserved worst case, and
 * refusal to run on top of a ledger it cannot trust.
 *
 * All engine-level; a fake quote-carrying agent (no HTTP) prices every call
 * deterministically.
 *
 * @module
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildSuite } from '../scoring/suite.js';
import { takeOrPass } from '../scoring/fixtures.js';

import { runSuite, readSpendLedger } from './run.js';

/** @import { Game, Agent } from '../core/types.js' */
/** @import { SuiteManifest } from '../scoring/suite.js' */

/** @typedef {{ suite: SuiteManifest, games: Game<*>[] }} Bundle */

/**
 * A one-seat fixture game where every episode takes exactly `calls` agent
 * calls: the agent replies 'go' until the counter runs out.
 *
 * @param {string} id
 * @param {number} calls
 * @param {number} publicSeeds
 * @returns {Game<{ remaining: number }>}
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
      benchmark: false,
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
    outcome(state) {
      return { normalized: [1], raw: [state.remaining], reason: 'done' };
    },
    truncate() {
      return { normalized: [0], raw: null, reason: 'ran out of budget' };
    },
  });
}

/**
 * A fake quote-carrying agent: every act() costs exactly `costUsd` and quotes
 * `quoteUsd` up front. Calls whose 0-based index is in `rejectOn` throw
 * instead, the way a provider timeout or an abort does — the reply never
 * arrives, but the provider may bill the call anyway.
 *
 * @param {{ quoteUsd?: number | null, costUsd?: number | null, rejectOn?: Set<number>, tokens?: { inputTokens: number, outputTokens: number }, text?: string }} [options]
 * @returns {Agent}
 */
function fakeQuoteAgent({ quoteUsd = 0.05, costUsd = 0.05, rejectOn = new Set(), tokens = { inputTokens: 10, outputTokens: 1 }, text = 'go' } = {}) {
  let call = 0;
  return /** @type {Agent} */ ({
    id: 'fake-priced',
    track: 'community',
    ...(quoteUsd !== null ? { quoteWorstCaseUsd: () => quoteUsd } : {}),
    async act() {
      const index = call++;
      if (rejectOn.has(index)) {
        throw new Error(`simulated provider timeout on call ${index}`);
      }
      return {
        text,
        usage: {
          ...tokens,
          ...(costUsd !== null ? { costUsd } : {}),
        },
      };
    },
  });
}

/**
 * Resume-loop driver: reruns the same suite with `--resume` semantics until it
 * finishes, refuses without progress, or hits the iteration bound — the loop
 * pilot.sh would run.
 *
 * @param {Bundle} bundle
 * @param {string} dir
 * @param {{ maxUsdTotal: number, maxUsd?: number, iterations?: number }} cap
 * @returns {Promise<Awaited<ReturnType<typeof runSuite>>>} the last result
 */
async function resumeLoop(bundle, dir, { maxUsdTotal, maxUsd, iterations = 8 }) {
  /** @type {*} */ let last = null;
  for (let i = 0; i < iterations; i++) {
    last = await runSuite({
      suite: bundle.suite,
      games: bundle.games,
      outDir: dir,
      resume: i > 0,
      ...(maxUsd !== undefined ? { maxUsd } : {}),
      maxUsdTotal,
      agentFactory: () => fakeQuoteAgent(),
    });
    if (!last.stopped) break;
    if (last.run.calls === 0) break; // a resume with no progress refuses for good
  }
  return last;
}

async function tempDir(/** @type {string} */ label) {
  return mkdtemp(join(tmpdir(), `gauntlet-spend-${label}-`));
}

const MULTI_4x4 = /** @type {Bundle} */ ({ suite: buildSuite([makeMultiCallGame('multi-a', 4, 4)], { split: 'public' }), games: [makeMultiCallGame('multi-a', 4, 4)] });
// Four episodes x 4 calls x $0.05 = $0.80 to finish.

const TAKE = /** @type {Bundle} */ ({ suite: buildSuite([takeOrPass], { split: 'public' }), games: [takeOrPass] });

test('a run under --max-usd-total finishes and every settled call is in the ledger', async () => {
  const dir = await tempDir('finish');
  try {
    const result = await resumeLoop(MULTI_4x4, dir, { maxUsdTotal: 4 });
    assert.equal(result.stopped, null, 'a generous total cap lets the bundle complete');
    assert.equal(result.run.counts.unplayed, 0);

    const ledger = await readSpendLedger(dir);
    assert.ok(ledger.present, 'spend.jsonl exists');
    assert.deepEqual(ledger.problems, []);
    assert.equal(ledger.summary.invocations, 1);
    assert.equal(ledger.summary.calls, 16, 'four episodes x four calls');
    assert.ok(Math.abs(ledger.summary.totalUsd - 0.8) < 1e-9, 'all 16 calls settled at $0.05');
    assert.equal(ledger.summary.unwoundCalls, 0);
    assert.ok(Math.abs(ledger.summary.keptUsd - 0.8) < 1e-9);
    assert.equal(ledger.summary.unknownCalls, 0);
    assert.equal(ledger.summary.cap, 4, 'the recorded cap is the one that was passed');
    // run.json carries the same block.
    assert.ok(Math.abs(result.run.ledger.totalUsd - 0.8) < 1e-9);
    assert.equal(result.run.limits.maxUsdTotal, 4);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a resume loop under a tight total cap refuses instead of exceeding it', async () => {
  const dir = await tempDir('refuse');
  try {
    // $0.50 admits ten $0.05 calls: two episodes kept, a third unwound
    // mid-episode. The next resume has settled $0.50 of a $0.50 cap and
    // refuses every call — no progress, so the loop must stop.
    const result = await resumeLoop(MULTI_4x4, dir, { maxUsdTotal: 0.5 });
    assert.equal(result.stopped, 'budget');

    const ledger = await readSpendLedger(dir);
    assert.ok(ledger.summary.totalUsd <= 0.5 + 1e-9, 'the ledger never exceeded the cap');
    assert.ok(Math.abs(ledger.summary.totalUsd - 0.5) < 1e-9);
    assert.equal(ledger.summary.unwoundCalls, 2, 'the third episode was unwound mid-flight');
    assert.ok(Math.abs(ledger.summary.unwoundUsd - 0.1) < 1e-9, 'its two calls stay recorded, charged');
    assert.ok(Math.abs(ledger.summary.keptUsd - 0.4) < 1e-9, 'the two finished episodes kept their spend');
    assert.ok(result.run.ledger.unwoundCalls > 0, 'run.json names the spend a stop threw away');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a call that rejects is charged at its reserved worst-case quote', async () => {
  const dir = await tempDir('reject');
  try {
    const suite = buildSuite([makeMultiCallGame('multi-b', 4, 1)], { split: 'public' });
    const game = makeMultiCallGame('multi-b', 4, 1);
    // Call 1 settles at $0.02; call 2 throws like a provider timeout. The
    // quote was $0.50, so the ledger charges the rejection at $0.50 — the
    // provider may bill a call the client abandoned.
    const result = await runSuite({
      suite,
      games: [game],
      outDir: dir,
      maxUsdTotal: 2,
      agentFactory: () => fakeQuoteAgent({ costUsd: 0.02, quoteUsd: 0.5, rejectOn: new Set([1]) }),
    });

    assert.equal(result.stopped, null, 'an episode failure does not stop the run');
    assert.equal(result.run.counts.failed, 1);
    assert.equal(result.run.counts.played, 0);
    assert.ok(Math.abs(result.run.spendUsd - 0.52) < 1e-9, 'settled $0.02 plus the $0.50 reservation charge');

    const ledger = await readSpendLedger(dir);
    assert.deepEqual(ledger.problems, []);
    assert.equal(ledger.summary.calls, 2);
    assert.ok(Math.abs(ledger.summary.totalUsd - 0.52) < 1e-9);
    assert.equal(ledger.summary.keptUsd, 0, 'the episode never produced a trajectory');
    assert.ok(Math.abs(ledger.summary.unwoundUsd - 0.52) < 1e-9);
    const rejected = ledger.lines.map((l) => l.value).find((l) => l.chargedAtReservation);
    assert.ok(rejected, 'the rejection is recorded as charged-at-reservation');
    assert.ok(Math.abs(rejected.costUsd - 0.5) < 1e-9);
    assert.match(String(rejected.rejectReason), /simulated provider timeout/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a resume carries the recorded total cap; passing a new one records the change', async () => {
  const dir = await tempDir('carry');
  try {
    // Invocation 1: $0.25 admits five calls — episode 1 kept, episode 2
    // unwound after one call.
    const first = await runSuite({
      suite: MULTI_4x4.suite,
      games: MULTI_4x4.games,
      outDir: dir,
      maxUsdTotal: 0.25,
      agentFactory: () => fakeQuoteAgent(),
    });
    assert.equal(first.stopped, 'budget');
    assert.equal(first.run.limits.maxUsdTotal, 0.25);

    // Invocation 2: no flag, no prices change — the recorded cap still binds,
    // every call refuses, and the ledger records the invocation anyway.
    const second = await runSuite({
      suite: MULTI_4x4.suite,
      games: MULTI_4x4.games,
      outDir: dir,
      resume: true,
      agentFactory: () => fakeQuoteAgent(),
    });
    assert.equal(second.stopped, 'budget');
    assert.equal(second.run.limits.maxUsdTotal, 0.25, 'the recorded cap is carried without the flag');
    assert.equal(second.run.calls, 0, 'nothing is admitted over the carried cap');

    // Invocation 3: raising the cap is a recorded fact of the ledger.
    const third = await runSuite({
      suite: MULTI_4x4.suite,
      games: MULTI_4x4.games,
      outDir: dir,
      resume: true,
      maxUsdTotal: 0.5,
      agentFactory: () => fakeQuoteAgent(),
    });
    assert.equal(third.stopped, 'budget');
    assert.equal(third.run.limits.maxUsdTotal, 0.5);
    // The replay of episode 2 spends its calls a second time — that is the
    // known replay waste, and the ledger shows it.
    assert.ok(third.run.ledger.unwoundCalls >= 2, 'both unwound attempts are in the ledger');

    const ledger = await readSpendLedger(dir);
    assert.deepEqual(ledger.problems, []);
    const capLines = ledger.lines.map((l) => l.value).filter((l) => l.kind === 'cap');
    assert.equal(capLines.length, 2, 'the original cap and the raise are both recorded');
    assert.ok(Math.abs(capLines[0].maxUsdTotal - 0.25) < 1e-9);
    assert.ok(Math.abs(capLines[1].maxUsdTotal - 0.5) < 1e-9);
    assert.equal(ledger.summary.invocations, 3);
    assert.ok(ledger.summary.totalUsd <= 0.5 + 1e-9, 'still bounded by the new cap');
    assert.ok(Math.abs(ledger.summary.totalUsd - 0.5) < 1e-9);
    assert.ok(Math.abs(ledger.summary.keptUsd - 0.4) < 1e-9, 'episodes 1 and 2 are kept');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a total cap refuses to run over recorded calls with unknown cost', async () => {
  const dir = await tempDir('unknown');
  try {
    // Uncapped run with a price-less agent: usage is recorded, costs are not.
    const first = await runSuite({
      suite: TAKE.suite,
      games: TAKE.games,
      outDir: dir,
      agentFactory: () => fakeQuoteAgent({ quoteUsd: null, costUsd: null, text: 'take' }),
    });
    assert.equal(first.stopped, null);
    assert.equal(first.run.ledger.unknownCalls, 2, 'both calls recorded at unknown cost');

    await assert.rejects(
      runSuite({
        suite: TAKE.suite,
        games: TAKE.games,
        outDir: dir,
        resume: true,
        maxUsdTotal: 1,
        agentFactory: () => fakeQuoteAgent({ quoteUsd: null, costUsd: null, text: 'take' }),
      }),
      /unknown spend/,
      'a total cap cannot be enforced over unknown recorded spend'
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('when both caps are set, both apply — the tighter one binds per invocation, the total binds across resumes', async () => {
  const dir = await tempDir('both');
  try {
    const result = await resumeLoop(MULTI_4x4, dir, { maxUsdTotal: 1, maxUsd: 0.22, iterations: 10 });
    assert.equal(result.stopped, null, 'the bundle completes under both caps');
    assert.equal(result.run.counts.unplayed, 0);

    const ledger = await readSpendLedger(dir);
    assert.ok(ledger.summary.totalUsd <= 1 + 1e-9, 'the total cap held across every resume');
    assert.ok(Math.abs(ledger.summary.totalUsd - 0.8) < 1e-9);
    assert.equal(ledger.summary.invocations, 4, 'each budget-shaped resume iteration is one recorded invocation');
    const capLines = ledger.lines.map((l) => l.value).filter((l) => l.kind === 'cap');
    assert.equal(capLines.length, 1, 're-passing the same cap records nothing new');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a resume refuses a ledger it cannot trust: garbage line, or a naive value edit', async () => {
  const dir = await tempDir('corrupt');
  try {
    const first = await runSuite({
      suite: MULTI_4x4.suite,
      games: MULTI_4x4.games,
      outDir: dir,
      maxUsdTotal: 0.25,
      agentFactory: () => fakeQuoteAgent(),
    });
    assert.equal(first.stopped, 'budget');

    const path = join(dir, 'spend.jsonl');
    const original = await readFile(path, 'utf8');

    // A trailing garbage line.
    await writeFile(path, original + 'not json\n', 'utf8');
    await assert.rejects(
      runSuite({ suite: MULTI_4x4.suite, games: MULTI_4x4.games, outDir: dir, resume: true, maxUsdTotal: 5, agentFactory: () => fakeQuoteAgent() }),
      /spend\.jsonl/
    );

    // A hand-edited cost breaks the hash chain even though the JSON parses.
    const lines = original.split('\n').filter((l) => l.trim().length > 0);
    const doctored = JSON.parse(lines[1]);
    doctored.costUsd = 0.005;
    lines[1] = JSON.stringify(doctored);
    await writeFile(path, lines.join('\n') + '\n', 'utf8');
    await assert.rejects(
      runSuite({ suite: MULTI_4x4.suite, games: MULTI_4x4.games, outDir: dir, resume: true, maxUsdTotal: 5, agentFactory: () => fakeQuoteAgent() }),
      /prev hash mismatch/
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
