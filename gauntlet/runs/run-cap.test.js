/**
 * Unit: the dollar cap under concurrency, with a real model agent.
 *
 * The engine reserves each call's worst case before the call starts — the
 * request text's byte length times the input price plus the output-token
 * limit times the output price — and refuses a call whose reservation would
 * push committed spend (settled spend plus the reservations of the calls in
 * flight) past `maxUsd`. Every admitted call settles at or below its
 * reservation, so realized spend can never exceed the cap, whatever the
 * workers interleave.
 *
 * Two deterministic scenarios against a local stub, each with an exact call
 * count and an exact spend:
 *
 * - The repeat scenario (20 runs): prices make the worst-case quote equal
 *   the settled cost — `maxOutputTokens: 10` with `outputPerMTok: 5000`
 *   quotes 10 x 5000 / 1e6 = $0.05 per call, and the stub's usage (100 in /
 *   10 out, `inputPerMTok: 0`) settles at exactly 10 x 5000 / 1e6 = $0.05. A
 *   $0.22 cap therefore admits exactly four calls (4 x $0.05 = $0.20 <=
 *   $0.22 < 5 x $0.05) at --concurrency 4, and spend lands at exactly $0.20
 *   every single time.
 *
 * - The one-call-dwarfs-the-cap scenario: at the default 4096-token output
 *   cap one call's worst case is $20.48 — over 400x what it settles for. A
 *   $20.75 cap admits exactly six calls ($0.30) and then refuses: under the
 *   pre-reservation engine this was the overshoot window.
 *
 * Local stub server on 127.0.0.1 only; no paid calls.
 *
 * @module
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildSuite } from '../scoring/suite.js';
import { takeOrPass, countdown } from '../scoring/fixtures.js';
import { createModelAgent } from '../harness/model-agent.js';
import { startStubServer, sendJson } from '../harness/stub-server.js';
import { runSuite } from './run.js';

/** A two-game public suite: 2 one-shot episodes first, then 8 engine episodes. */
const SUITE = buildSuite([takeOrPass, countdown], { split: 'public' });
const GAMES = [takeOrPass, countdown];

const PRICES = {
  'openai-chat/cap-model': { inputPerMTok: 0, outputPerMTok: 5000, source: 'stub', checked: '2026-10-16' },
};

/**
 * A stub chat-completions server that answers `take` with fixed usage after a
 * short hold, and tracks how many calls were in flight at once.
 *
 * @returns {Promise<{ url: string, close: () => Promise<void>, maxInFlight: () => number }>}
 */
async function startCapStub() {
  let inFlight = 0;
  let maxInFlight = 0;
  const stub = await startStubServer(
    /** @param {import('node:http').IncomingMessage} _req @param {import('node:http').ServerResponse} res */
    (_req, res) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      // A short hold so the workers genuinely overlap.
      setTimeout(() => {
        inFlight -= 1;
        sendJson(res, 200, {
          id: 'chatcmpl-cap',
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

for (let i = 1; i <= 20; i++) {
  test(`cap holds at concurrency 4 (repeat ${i}/20): exactly 4 admitted calls, exactly $0.20`, { timeout: 60 * 1000 }, async (t) => {
    const dir = await mkdtemp(join(tmpdir(), 'gauntlet-cap-'));
    t.after(() => rm(dir, { recursive: true, force: true }));

    const stub = await startCapStub();
    t.after(() => stub.close());

    const pricesPath = join(dir, 'prices.json');
    await writeFile(pricesPath, JSON.stringify(PRICES, null, 2));

    const result = await runSuite({
      suite: SUITE,
      games: GAMES,
      outDir: dir,
      pricesPath,
      concurrency: 4,
      maxUsd: 0.22,
      agentFactory: () =>
        createModelAgent({
          provider: 'openai-chat',
          model: 'cap-model',
          baseUrl: stub.url,
          prices: PRICES,
          // The quote's input term is zero (inputPerMTok: 0) and the output
          // term matches the stub's settled output tokens exactly.
          maxOutputTokens: 10,
          sleep: async () => {},
        }),
    });

    assert.equal(result.stopped, 'budget', 'the run stops on the budget cap');
    assert.equal(result.run.calls, 4, 'exactly four calls are admitted');
    assert.ok(
      Math.abs(result.run.spendUsd - 0.2) < 1e-9,
      `spend is exactly 4 x $0.05, got ${result.run.spendUsd}`
    );
    assert.ok(result.run.spendUsd <= 0.22 + 1e-9, 'realized spend never exceeds the cap');
    assert.equal(result.run.counts.played, 2, 'the two one-shot episodes completed');
    assert.equal(result.run.counts.unplayed, 8, 'the engine episodes stayed unplayed');
    assert.equal(result.run.counts.failed, 0, 'no episode failed');
    const maxInFlight = stub.maxInFlight();
    assert.ok(maxInFlight >= 2, `calls actually overlapped (max in flight: ${maxInFlight})`);
    assert.ok(maxInFlight <= 4, 'concurrency stays bounded by the worker count');
  });
}

test('one call whose worst case nearly exhausts the cap still cannot overshoot', { timeout: 60 * 1000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'gauntlet-cap-wide-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const stub = await startCapStub();
  t.after(() => stub.close());

  const pricesPath = join(dir, 'prices.json');
  await writeFile(pricesPath, JSON.stringify(PRICES, null, 2));

  const result = await runSuite({
    suite: SUITE,
    games: GAMES,
    outDir: dir,
    pricesPath,
    // Reservation arithmetic is per-call, so a single worker exercises it
    // exactly: one call's $20.48 quote nearly fills the $20.75 cap, it
    // settles at $0.05, and the released reservation admits the next call
    // until settled + quote exceeds the cap.
    concurrency: 1,
    // One call's worst case at the default 4096-token output cap is
    // 4096 x 5000 / 1e6 = $20.48; $0.27 of headroom admits exactly six
    // $0.05 calls and refuses the seventh.
    maxUsd: 20.75,
    agentFactory: () =>
      createModelAgent({
        provider: 'openai-chat',
        model: 'cap-model',
        baseUrl: stub.url,
        prices: PRICES,
        sleep: async () => {},
      }),
  });

  assert.equal(result.stopped, 'budget', 'the run stops on the budget cap');
  assert.equal(result.run.calls, 6, 'exactly six calls are admitted');
  assert.ok(
    Math.abs(result.run.spendUsd - 0.3) < 1e-9,
    `spend is exactly 6 x $0.05, got ${result.run.spendUsd}`
  );
  assert.ok(result.run.spendUsd <= 20.75 + 1e-9, 'realized spend never exceeds the cap');
  assert.equal(stub.maxInFlight(), 1, 'a cap that one worst-case quote nearly fills never runs two calls at once');
});
