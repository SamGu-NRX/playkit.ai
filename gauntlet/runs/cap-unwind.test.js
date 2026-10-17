/**
 * Unit: what a bundle-wide cap stop keeps and what it unwinds — the rule
 * `journeys/pilot/pilot.sh` prints before the first paid call and
 * `journeys/pilot/PILOT.md` documents. Deterministic scenarios against a
 * local loopback stub (no paid calls), at concurrency 1 and 3:
 *
 * - Prices make every call's worst-case quote equal its settled cost
 *   (`maxOutputTokens: 10`, `outputPerMTok: 5000`): $0.05 per call.
 * - The stub always answers "take" — legal for take-or-pass (one-shot,
 *   one call), invalid for countdown (each episode ends forfeit-invalid
 *   after exactly three priced calls, trajectory written).
 *
 * The rule the scenarios pin:
 *
 * 1. The first admission that would not fit sets stopped="budget" and
 *    throws BEFORE the call starts — a refused call is never charged.
 * 2. Every episode still in flight unwinds: no trajectory, its settled
 *    calls flushed with kept:false — paid spend that stays on the books
 *    (keptUsd + unwoundUsd = totalUsd) and is replayed on resume. At
 *    concurrency C that is up to C unwound episodes; at concurrency 1 all
 *    unwound calls belong to the one in-flight episode.
 * 3. A finished episode's spend is always kept:true — the attempt's flag
 *    is the trajectory-write result — never counted as unwound, even when
 *    the same job's earlier attempt unwound and its replay finished.
 * 4. Because every admitted call reserved its worst-case quote at
 *    admission, settled + reserved stays <= the cap, so the ledger total
 *    never passes it — it can land exactly on it.
 * 5. A resume under the same cap can refuse every call (nothing new is
 *    paid, nothing counted twice); a resume under a raised cap replays the
 *    unwound episode as a new attempt whose spend is new ledger lines.
 *
 * Worst case paid-but-discarded at one cap stop: the committed spend of the
 * in-flight episodes, bounded by min(concurrency x per-episode spend, cap).
 *
 * @module
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildSuite } from '../scoring/suite.js';
import { takeOrPass, countdown } from '../scoring/fixtures.js';
import { createModelAgent } from '../harness/model-agent.js';
import { startStubServer, sendJson } from '../harness/stub-server.js';
import { runSuite, SPEND_LEDGER_FILENAME } from './run.js';

/** A two-game public suite: 2 one-shot episodes first, then 8 countdown episodes. */
const SUITE = buildSuite([takeOrPass, countdown], { split: 'public' });
const GAMES = [takeOrPass, countdown];
/** A countdown-only suite: every episode is a three-call forfeit. */
const COUNTDOWN_SUITE = buildSuite([countdown], { split: 'public' });
const COUNTDOWN_GAMES = [countdown];

const PRICES = {
  'openai-chat/cap-model': { inputPerMTok: 0, outputPerMTok: 5000, source: 'stub', checked: '2026-10-16' },
};

/**
 * A stub chat-completions server that answers every request with "take"
 * after a short hold, so concurrent workers genuinely overlap.
 */
async function startCapStub() {
  let inFlight = 0;
  let maxInFlight = 0;
  const stub = await startStubServer(
    /** @param {import('node:http').IncomingMessage} _req @param {import('node:http').ServerResponse} res */
    (_req, res) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      setTimeout(() => {
        inFlight -= 1;
        sendJson(res, 200, {
          id: 'chatcmpl-cap-unwind',
          object: 'chat.completion',
          created: 1,
          model: 'cap-model',
          choices: [
            { index: 0, message: { role: 'assistant', content: 'take' }, finish_reason: 'stop' },
          ],
          usage: { prompt_tokens: 100, completion_tokens: 10 },
        });
      }, 25);
    }
  );
  return { url: stub.url, close: stub.close, maxInFlight: () => maxInFlight };
}

/** Reads the bundle's spend ledger and returns its `kind: "call"` lines. */
async function readCallLines(dir) {
  const text = await readFile(join(dir, SPEND_LEDGER_FILENAME), 'utf8');
  return text
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
    .filter((line) => line.kind === 'call');
}

function agentFactoryStub(pricesPath, stubUrl) {
  return () =>
    createModelAgent({
      provider: 'openai-chat',
      model: 'cap-model',
      baseUrl: stubUrl,
      prices: PRICES,
      // The quote's input term is zero (inputPerMTok: 0) and the output
      // term matches the stub's settled output tokens exactly, so quote
      // equals settled cost: the reservation arithmetic is exact.
      maxOutputTokens: 10,
      sleep: async () => {},
    });
}

/** @param {string} dir */
async function writePrices(dir) {
  const pricesPath = join(dir, 'prices.json');
  await writeFile(pricesPath, JSON.stringify(PRICES, null, 2));
  return pricesPath;
}

test('cap stop at concurrency 1: one in-flight episode holds every unwound call, finished episodes stay kept', { timeout: 60 * 1000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'gauntlet-unwind-c1-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const stub = await startCapStub();
  t.after(() => stub.close());
  const pricesPath = await writePrices(dir);

  // Cap arithmetic at concurrency 1: the two one-shot episodes settle $0.10
  // and finish (kept); the first countdown episode admits two more calls
  // ($0.20 committed) and its third admission ($0.25 projected) refuses.
  const result = await runSuite({
    suite: SUITE,
    games: GAMES,
    outDir: dir,
    pricesPath,
    concurrency: 1,
    maxUsdTotal: 0.22,
    agentFactory: agentFactoryStub(pricesPath, stub.url),
  });

  assert.equal(result.stopped, 'budget', 'the run stops on the bundle-wide cap');
  assert.equal(result.run.calls, 4, 'four calls admitted: 2 kept one-shots + 2 unwound countdown calls');
  assert.ok(Math.abs(result.run.spendUsd - 0.2) < 1e-9, `settled spend is 4 x $0.05, got ${result.run.spendUsd}`);
  assert.equal(result.run.counts.played, 2, 'the two one-shot episodes finished');
  assert.equal(result.run.counts.unplayed, 8, 'the countdown episodes stayed unplayed');
  assert.equal(result.run.counts.failed, 0, 'an unwound episode is not a failure');

  const ledger = result.run.ledger;
  assert.ok(Math.abs(ledger.totalUsd - 0.2) < 1e-9, `ledger total is $0.20, got ${ledger.totalUsd}`);
  assert.ok(Math.abs(ledger.keptUsd - 0.1) < 1e-9, `keptUsd is the 2 finished episodes' $0.10, got ${ledger.keptUsd}`);
  assert.ok(Math.abs(ledger.unwoundUsd - 0.1) < 1e-9, `unwoundUsd is the in-flight episode's $0.10, got ${ledger.unwoundUsd}`);
  assert.equal(ledger.unwoundCalls, 2, 'two unwound calls');
  assert.equal(ledger.cap, 0.22, 'the cap is recorded');
  assert.ok(ledger.totalUsd <= 0.22 + 1e-9, 'the ledger total never passes the cap');

  // The unwound calls all belong to the ONE episode in flight, and the
  // finished episodes' calls are kept:true — never counted as unwound.
  const lines = await readCallLines(dir);
  const kept = lines.filter((l) => l.kept === true);
  const unwound = lines.filter((l) => l.kept === false);
  assert.equal(kept.length, 2, 'two kept call lines');
  assert.ok(kept.every((l) => l.job.startsWith('take-or-pass/')), 'the kept calls are the finished one-shots');
  assert.equal(unwound.length, 2, 'two unwound call lines');
  assert.equal(new Set(unwound.map((l) => l.job)).size, 1, 'every unwound call belongs to one in-flight episode');
  assert.ok(unwound.every((l) => l.job.startsWith('countdown/')), 'the unwound episode is the first countdown job');
  assert.equal(new Set(unwound.map((l) => l.invocation)).size, 1, 'the unwound calls are one attempt');
});

test('resume under the same cap pays nothing and counts nothing twice', { timeout: 60 * 1000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'gauntlet-unwind-resume-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const stub = await startCapStub();
  t.after(() => stub.close());
  const pricesPath = await writePrices(dir);

  const first = await runSuite({
    suite: SUITE,
    games: GAMES,
    outDir: dir,
    pricesPath,
    concurrency: 1,
    maxUsdTotal: 0.22,
    agentFactory: agentFactoryStub(pricesPath, stub.url),
  });
  assert.equal(first.stopped, 'budget');

  const resumed = await runSuite({
    suite: SUITE,
    games: GAMES,
    outDir: dir,
    pricesPath,
    concurrency: 1,
    maxUsdTotal: 0.22,
    resume: true,
    agentFactory: agentFactoryStub(pricesPath, stub.url),
  });

  assert.equal(resumed.stopped, 'budget', 'the resume stops on the same cap');
  assert.equal(resumed.run.calls, 0, 'the resume admits no call: nothing new is paid');
  assert.equal(resumed.run.counts.played, 0, 'nothing new is written');
  assert.equal(resumed.run.counts.unplayed, 8, 'the unplayed work is still reported');
  const linesBefore = await readCallLines(dir);
  assert.equal(linesBefore.filter((l) => l.kind === 'call').length, 4, 'the ledger gained no call line');
  assert.ok(Math.abs(resumed.run.ledger.totalUsd - 0.2) < 1e-9, 'the ledger total is unchanged');
  assert.equal(resumed.run.ledger.unwoundCalls, 2, 'the earlier unwind is still counted exactly once');
});

test('resume under a raised cap: the replay is a new attempt; a finished attempt is kept, the unwound one stays unwound', { timeout: 60 * 1000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'gauntlet-unwind-raise-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const stub = await startCapStub();
  t.after(() => stub.close());
  const pricesPath = await writePrices(dir);

  const first = await runSuite({
    suite: SUITE,
    games: GAMES,
    outDir: dir,
    pricesPath,
    concurrency: 1,
    maxUsdTotal: 0.22,
    agentFactory: agentFactoryStub(pricesPath, stub.url),
  });
  assert.equal(first.stopped, 'budget');

  // Raised cap: the unwound countdown episode replays (3 calls, forfeit,
  // written), the next countdown episode plays (3 calls) and lands the
  // ledger exactly on the cap; the third countdown episode's first
  // admission refuses with nothing charged.
  const resumed = await runSuite({
    suite: SUITE,
    games: GAMES,
    outDir: dir,
    pricesPath,
    concurrency: 1,
    maxUsdTotal: 0.5,
    resume: true,
    agentFactory: agentFactoryStub(pricesPath, stub.url),
  });

  assert.equal(resumed.stopped, 'budget', 'the raised cap binds again at $0.50');
  assert.ok(Math.abs(resumed.run.spendUsd - 0.3) < 1e-9, `this invocation paid for 6 new calls, got ${resumed.run.spendUsd}`);
  assert.equal(resumed.run.counts.played, 2, 'the replayed episode and the next one finished');

  const ledger = resumed.run.ledger;
  assert.ok(Math.abs(ledger.totalUsd - 0.5) < 1e-9, `the ledger lands exactly on the cap, got ${ledger.totalUsd}`);
  assert.ok(ledger.totalUsd <= 0.5 + 1e-9, 'the ledger total never passes the cap');
  assert.ok(Math.abs(ledger.keptUsd - 0.4) < 1e-9, `keptUsd is $0.10 (one-shots) + 2 x $0.15 (kept replays), got ${ledger.keptUsd}`);
  assert.ok(Math.abs(ledger.unwoundUsd - 0.1) < 1e-9, `unwoundUsd is still only the first attempt's $0.10, got ${ledger.unwoundUsd}`);
  assert.equal(ledger.unwoundCalls, 2, 'the unwound calls are still counted exactly once');

  // The decisive attribution: the replayed episode appears twice in the
  // ledger — its unwound attempt kept:false, its finished attempt kept:true.
  const lines = await readCallLines(dir);
  /** @type {Map<string, { kept: boolean }[]>} */
  const countdownJobs = new Map();
  for (const line of lines) {
    if (!line.job.startsWith('countdown/')) continue;
    const key = `${line.job}#${line.invocation}`;
    if (!countdownJobs.has(key)) countdownJobs.set(key, []);
    countdownJobs.get(key).push(line);
  }
  const attempts = [...countdownJobs.entries()];
  assert.equal(attempts.length, 3, 'two kept replay attempts + one unwound attempt');
  for (const [key, attemptLines] of attempts) {
    const flags = new Set(attemptLines.map((l) => l.kept));
    assert.equal(flags.size, 1, `attempt ${key} has a single kept flag`);
  }
  const unwoundAttempts = attempts.filter(([, ls]) => ls[0].kept === false);
  const keptAttempts = attempts.filter(([, ls]) => ls[0].kept === true);
  assert.equal(unwoundAttempts.length, 1, 'exactly one unwound attempt');
  assert.equal(unwoundAttempts[0][1].length, 2, 'the unwound attempt holds its two settled calls');
  assert.equal(keptAttempts.length, 2, 'two kept attempts');
  assert.ok(keptAttempts.every(([, ls]) => ls.length === 3), 'a kept attempt holds its three calls');
  const [unwoundKey] = unwoundAttempts[0];
  const keptKeys = keptAttempts.map(([k]) => k.split('#')[0]);
  assert.ok(keptKeys.includes(unwoundKey.split('#')[0]), 'the unwound job is the one that was replayed and finished');
});

test('cap stop at concurrency 3: up to three episodes unwind together, still inside the cap', { timeout: 60 * 1000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'gauntlet-unwind-c3-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const stub = await startCapStub();
  t.after(() => stub.close());
  const pricesPath = await writePrices(dir);

  // Cap arithmetic at concurrency 3 over countdown-only episodes: the three
  // workers' first calls are all admitted (committed $0.15 <= $0.16) and
  // settle; the next admission ($0.20 projected) refuses. Each in-flight
  // episode unwinds with exactly one settled call: the worst case
  // min(concurrency x per-episode spend, cap) = min(3 x $0.15, $0.16) here
  // binds at the cap, not at the per-episode bound.
  const result = await runSuite({
    suite: COUNTDOWN_SUITE,
    games: COUNTDOWN_GAMES,
    outDir: dir,
    pricesPath,
    concurrency: 3,
    maxUsdTotal: 0.16,
    agentFactory: agentFactoryStub(pricesPath, stub.url),
  });

  assert.equal(result.stopped, 'budget', 'the run stops on the bundle-wide cap');
  assert.ok(stub.maxInFlight() >= 2, `the workers genuinely overlapped (max in flight: ${stub.maxInFlight()})`);
  assert.equal(result.run.calls, 3, 'exactly three calls admitted, one per in-flight episode');
  assert.ok(Math.abs(result.run.spendUsd - 0.15) < 1e-9, `settled spend is 3 x $0.05, got ${result.run.spendUsd}`);
  assert.equal(result.run.counts.played, 0, 'nothing finished: all three in-flight episodes unwound');

  const ledger = result.run.ledger;
  assert.ok(Math.abs(ledger.totalUsd - 0.15) < 1e-9, `ledger total is $0.15, got ${ledger.totalUsd}`);
  assert.ok(ledger.totalUsd <= 0.16 + 1e-9, 'the ledger total never passes the cap');
  assert.ok(Math.abs(ledger.keptUsd - 0) < 1e-9, 'nothing is kept');
  assert.ok(Math.abs(ledger.unwoundUsd - 0.15) < 1e-9, `all $0.15 is unwound, got ${ledger.unwoundUsd}`);
  assert.equal(ledger.unwoundCalls, 3, 'three unwound calls');

  const lines = await readCallLines(dir);
  assert.equal(new Set(lines.map((l) => l.job)).size, 3, 'three distinct episodes unwound');
  assert.ok(lines.every((l) => l.kept === false), 'no finished episode exists to be counted as unwound');
});
