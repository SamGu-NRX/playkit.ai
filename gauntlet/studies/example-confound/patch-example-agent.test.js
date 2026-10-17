/**
 * Tests for the example-confound study's patch wrapper. Every test names
 * behavior the preregistration pins: each replacement applied exactly once,
 * nothing else in the prompt changed, a missing target throws an error naming
 * the game and the string, meta records the change, and a full episode played
 * through the wrapper still verifies with the referee and trajectory untouched.
 *
 * The contexts are built from the REAL registered games (spec.rulesText and
 * observe() output), so the tests fail if the game's prompt text drifts from
 * the preregistered patch targets.
 *
 * @module
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { GAMES } from '../../games/index.js';
import { runEpisode } from '../../core/runner.js';
import { verifyTrajectory } from '../../core/trajectory.js';
import { buildOfficialTurnMessage } from '../../harness/official.js';
import { createAssistedAgent } from '../../community/assisted-agent.js';
import { createExamplePatchAgent } from './patch-example-agent.js';
import {
  MASTERMIND_MINI_CORRECTED,
  CONNECT4_LADDER_1_NEUTRAL,
  PATCH_SETS,
} from './patches.js';

/** @import { Agent, TurnContext } from '../../core/types.js' */

/**
 * Count non-overlapping occurrences of `needle` in `haystack`.
 * @param {string} haystack
 * @param {string} needle
 * @returns {number}
 */
function countOccurrences(haystack, needle) {
  return haystack.split(needle).length - 1;
}

/**
 * A stub inner agent: records the contexts it was called with and replays a
 * fixed list of replies.
 * @param {Array<string | { text: string, usage?: *, meta?: * }>} replies
 * @returns {Agent & { calls: TurnContext[] }}
 */
function stubInner(replies) {
  /** @type {Agent & { calls: TurnContext[] }} */
  const agent = /** @type {*} */ ({
    id: 'model:openai-chat/stub-model',
    track: 'official',
    model: 'stub-model',
    provider: 'openai-chat',
    calls: /** @type {TurnContext[]} */ ([]),
    /** @param {TurnContext} ctx */
    async act(ctx) {
      agent.calls.push(ctx);
      const out = replies[agent.calls.length - 1];
      if (out === undefined) throw new Error('stub inner ran out of replies');
      return typeof out === 'string'
        ? { text: out, usage: { inputTokens: 1, outputTokens: 2, costUsd: null } }
        : /** @type {*} */ (out);
    },
  });
  return agent;
}

const mastermind = GAMES['mastermind'];
const connect4 = GAMES['connect4'];
const miniTier = /** @type {*} */ (
  mastermind.spec.tiers.find((t) => t.id === 'mini')
);
const ladder1Tier = /** @type {*} */ (
  connect4.spec.tiers.find((t) => t.id === 'ladder-1')
);

const MM_OBS_FIND = MASTERMIND_MINI_CORRECTED.patches[0].find;
const MM_RULES_FIND = MASTERMIND_MINI_CORRECTED.patches[1].find;
// A feedback string the runner can actually produce on mastermind/mini: the
// game's unparseable-guess parse error, whose example is already correct-length
// on mini (the game echoes ABCD.slice(0, pegs) = ABC). The empty-action error
// (games/mastermind/index.js:291) is UNREACHABLE through the runner — the
// runner's extractAction returns null for a reply with no non-empty line and
// judgeReply reports 'no action found in reply' without calling the game — so
// the patch set carries no mastermind feedback patch.
const MM_FEEDBACK =
  'cannot parse "ZZ" as a 3-peg code over ABCD; use "guess" followed by the code letters, e.g. "guess ABC"';

/**
 * A real mastermind/mini turn context.
 * @param {string | null} [feedback]
 * @returns {TurnContext}
 */
function mmCtx(feedback = null) {
  const state = mastermind.reset(miniTier, 'mastermind/mini/public/0');
  const seat =
    typeof mastermind.agentSeat === 'function'
      ? mastermind.agentSeat(miniTier, 'mastermind/mini/public/0')
      : 0;
  return {
    spec: mastermind.spec,
    tier: miniTier,
    seat,
    turn: 0,
    observation: mastermind.observe(state, seat),
    legalActions: null,
    feedback,
  };
}

/**
 * A real connect4/ladder-1 turn context.
 * @param {string | null} [feedback]
 * @returns {TurnContext}
 */
function c4Ctx(feedback = null) {
  const state = connect4.reset(ladder1Tier, 'connect4/ladder-1/public/0');
  const seat =
    typeof connect4.agentSeat === 'function'
      ? connect4.agentSeat(ladder1Tier, 'connect4/ladder-1/public/0')
      : 0;
  return {
    spec: connect4.spec,
    tier: ladder1Tier,
    seat,
    turn: 0,
    observation: connect4.observe(state, seat),
    legalActions: null,
    feedback,
  };
}

test('every preregistered mastermind replacement is applied exactly once and nothing else changes', async () => {
  const inner = stubInner(['thinking...\nguess ABA']);
  const agent = createExamplePatchAgent({ inner, patchSet: MASTERMIND_MINI_CORRECTED });
  const ctx = mmCtx(MM_FEEDBACK);
  await agent.act(ctx);
  assert.equal(inner.calls.length, 1);
  const derived = inner.calls[0];

  // Rules: the 4-peg example is gone, the 3-peg example appears exactly once.
  assert.equal(countOccurrences(derived.spec.rulesText, MM_RULES_FIND), 0);
  assert.equal(
    countOccurrences(derived.spec.rulesText, 'e.g. "guess ABA" for a 3-peg tier'),
    1
  );
  assert.ok(!derived.spec.rulesText.includes('guess ABCB'));
  // Observation: the packet-named example, corrected.
  assert.equal(countOccurrences(derived.observation.text, MM_OBS_FIND), 0);
  assert.equal(
    countOccurrences(derived.observation.text, 'followed by 3 code letters, e.g. "guess ABA"'),
    1
  );
  assert.ok(!derived.observation.text.includes('guess ABAB'));
  // Feedback carries no mastermind patch: the reachable feedback strings are
  // either example-free (empty reply) or already correct-length (unparseable),
  // so the feedback passes through byte-for-byte.
  assert.equal(derived.feedback, ctx.feedback);
  // Nothing else moved: spec identity, tier, seat, turn, observation data,
  // and the parts of the texts around the examples.
  assert.equal(derived.spec.id, 'mastermind');
  assert.equal(derived.spec.version, ctx.spec.version);
  assert.deepEqual(derived.tier, ctx.tier);
  assert.equal(derived.seat, ctx.seat);
  assert.equal(derived.turn, ctx.turn);
  assert.deepEqual(derived.observation.data, ctx.observation.data);
  assert.deepEqual(derived.legalActions, null);
  assert.equal(
    derived.spec.rulesText.length,
    ctx.spec.rulesText.length - (MM_RULES_FIND.length - MASTERMIND_MINI_CORRECTED.patches[1].replaceWith.length)
  );
  assert.equal(derived.observation.text.length, ctx.observation.text.length - (MM_OBS_FIND.length - MASTERMIND_MINI_CORRECTED.patches[0].replaceWith.length));
  // The runner's originals are untouched.
  assert.ok(ctx.spec.rulesText.includes('guess ABCB'));
  assert.ok(ctx.observation.text.includes('guess ABAB'));
  assert.ok(typeof ctx.feedback === 'string' && ctx.feedback.includes('e.g. "guess ABC"'));
});

test('the official prompt built from the derived context carries only corrected examples', async () => {
  const inner = stubInner(['guess ABA']);
  const agent = createExamplePatchAgent({ inner, patchSet: MASTERMIND_MINI_CORRECTED });
  await agent.act(mmCtx(MM_FEEDBACK));
  const message = buildOfficialTurnMessage(inner.calls[0], '(none)');
  assert.ok(message.includes('e.g. "guess ABA"'));
  assert.ok(!message.includes('guess ABAB'));
  assert.ok(!message.includes('guess ABCB'));
  // And the unpatched official message would have carried the wrong examples.
  const raw = buildOfficialTurnMessage(mmCtx(MM_FEEDBACK), '(none)');
  assert.ok(raw.includes('guess ABAB'));
  assert.ok(raw.includes('guess ABCB'));
});

test('meta records every applied change with field, find and replaceWith', async () => {
  const inner = stubInner(['guess ABA']);
  const agent = createExamplePatchAgent({ inner, patchSet: MASTERMIND_MINI_CORRECTED });
  const reply = await agent.act(mmCtx(MM_FEEDBACK));
  assert.equal(reply.text, 'guess ABA');
  assert.equal(reply.meta.examplePatch.patchSet, 'mastermind-mini-corrected');
  assert.deepEqual(
    reply.meta.examplePatch.applied.map((/** @type {*} */ a) => a.field),
    ['observation', 'rules']
  );
  for (const applied of reply.meta.examplePatch.applied) {
    assert.equal(applied.occurrences, 1);
    const prereg = MASTERMIND_MINI_CORRECTED.patches.find(
      (p) => p.field === applied.field
    );
    assert.ok(prereg, `no preregistered patch for field ${applied.field}`);
    assert.equal(applied.find, prereg.find);
    assert.equal(applied.replaceWith, prereg.replaceWith);
  }
  assert.deepEqual(reply.usage, { inputTokens: 1, outputTokens: 2, costUsd: null });
});

test('a missing target string throws an error naming the game and the string, never a silent pass-through', async () => {
  const inner = stubInner(['guess ABA']);
  const agent = createExamplePatchAgent({ inner, patchSet: MASTERMIND_MINI_CORRECTED });
  const ctx = mmCtx();
  ctx.observation = { ...ctx.observation, text: 'An observation without the example.' };
  await assert.rejects(
    agent.act(ctx),
    (/** @type {Error} */ err) =>
      err.message.includes('mastermind') &&
      err.message.includes(JSON.stringify(MM_OBS_FIND)) &&
      err.message.includes('not found')
  );
  assert.equal(inner.calls.length, 0, 'the inner agent never sees an unpatched prompt');
});

test('a target occurring twice throws instead of replacing ambiguously', async () => {
  const inner = stubInner(['guess ABA']);
  const agent = createExamplePatchAgent({ inner, patchSet: MASTERMIND_MINI_CORRECTED });
  const ctx = mmCtx();
  ctx.spec = /** @type {*} */ ({
    ...ctx.spec,
    rulesText: ctx.spec.rulesText + MM_RULES_FIND,
  });
  await assert.rejects(
    agent.act(ctx),
    (/** @type {Error} */ err) =>
      err.message.includes('exactly once') && err.message.includes('2 times')
  );
});

test('connect4: the rules patch applies every turn; the feedback patch applies only when the referee spoke', async () => {
  const inner = stubInner(['4', '4']);
  const agent = createExamplePatchAgent({ inner, patchSet: CONNECT4_LADDER_1_NEUTRAL });

  // No feedback: the feedback patch is skipped without error.
  await agent.act(c4Ctx(null));
  let derived = inner.calls[0];
  assert.ok(derived.spec.rulesText.includes('the column number alone, 1 to 7.'));
  assert.ok(!derived.spec.rulesText.includes('e.g. "4" drops into column 4'));
  assert.ok(!derived.spec.rulesText.includes('"column 4", "col 4", "play 4"'));
  // The sentence tail the patch does not cover is intact.
  assert.ok(
    derived.spec.rulesText.includes(
      'uppercase letters, surrounding quotes or backticks, and surrounding whitespace are all accepted.'
    )
  );
  assert.equal(derived.feedback, null);

  // Referee feedback carrying the worked example: patched.
  const parseFeedback =
    'cannot parse "nine" as a column; use the column number 1-7, e.g. "4" or "column 4"';
  await agent.act(c4Ctx(parseFeedback));
  derived = inner.calls[1];
  assert.ok(typeof derived.feedback === 'string');
  assert.ok(derived.feedback.includes('use the column number 1-7'));
  assert.ok(!derived.feedback.includes('e.g. "4"'));
  assert.equal(inner.calls[1].spec.rulesText, inner.calls[0].spec.rulesText);
});

test('the wrapper refuses to be seated on the wrong game or tier', async () => {
  const inner = stubInner(['4']);
  const agent = createExamplePatchAgent({ inner, patchSet: MASTERMIND_MINI_CORRECTED });
  await assert.rejects(
    agent.act(c4Ctx()),
    (/** @type {Error} */ err) =>
      err.message.includes('connect4') && err.message.includes('mastermind')
  );
  const tiered = createExamplePatchAgent({ inner, patchSet: MASTERMIND_MINI_CORRECTED });
  const wide = mmCtx();
  wide.tier = /** @type {*} */ (mastermind.spec.tiers.find((t) => t.id === 'wide'));
  await assert.rejects(
    tiered.act(wide),
    (/** @type {Error} */ err) => err.message.includes('wide') && err.message.includes('mini')
  );
});

test('an episode played through the wrapper verifies, keeps the referee untouched, and records the patch in step meta', async () => {
  // The scripted inner answers empty once (drawing the empty-action feedback,
  // which the wrapper must patch) and then guesses ABA forever.
  const inner = stubInner([]);
  inner.act = async (ctx) => {
    inner.calls.push(ctx);
    const text = inner.calls.length === 1 ? '' : 'guess ABA';
    return { text, usage: { inputTokens: 1, outputTokens: 2, costUsd: null } };
  };
  const agent = createExamplePatchAgent({ inner, patchSet: MASTERMIND_MINI_CORRECTED });
  const trajectory = await runEpisode({
    game: mastermind,
    tierId: 'mini',
    seed: 'mastermind/mini/public/0',
    split: 'public',
    agent,
  });
  const verdict = await verifyTrajectory(mastermind, trajectory);
  assert.equal(verdict.ok, true, JSON.stringify(verdict));
  // The model saw patched text on every turn it was called.
  assert.ok(inner.calls.length >= 2);
  for (const call of inner.calls) {
    assert.ok(!call.observation.text.includes('guess ABAB'));
    assert.ok(!call.spec.rulesText.includes('guess ABCB'));
  }
  // The empty first reply drew the runner's own example-free feedback (the
  // game's empty-action error is unreachable through the runner), passed
  // through unpatched: this is the pin behind retiring the preregistration's
  // original third mastermind patch.
  assert.equal(inner.calls[1].feedback, 'no action found in reply');
  const withFeedback = inner.calls.filter((c) => typeof c.feedback === 'string');
  assert.ok(withFeedback.length >= 1);
  for (const call of withFeedback) {
    assert.ok(typeof call.feedback === 'string');
    assert.ok(!call.feedback.includes('guess ABAB'));
    assert.ok(!call.feedback.includes('guess ABCB'));
  }
  // Every step's meta records the patch set. Steps carry the runner's own
  // observation HASH (never the wrapper's derived text), and verifyTrajectory
  // re-derived the identical hashes from (game, tier, seed) — so the recorded
  // trajectory is the referee's, untouched by the patching.
  const stepsWithMeta = trajectory.steps.filter(
    (s) => s.reply && s.reply.meta && s.reply.meta.examplePatch
  );
  assert.equal(stepsWithMeta.length, trajectory.steps.length);
  for (const step of stepsWithMeta) {
    assert.ok(step.reply.meta);
    assert.equal(step.reply.meta.examplePatch.patchSet, 'mastermind-mini-corrected');
    assert.deepEqual(
      step.reply.meta.examplePatch.applied.map((/** @type {*} */ a) => a.field),
      ['observation', 'rules']
    );
  }
});

test('the assisted nesting: patch outside assisted, both metas survive, the model reads patched text', async () => {
  const model = stubInner(['I will guess ABA.\nACTION: guess ABA']);
  const assisted = createAssistedAgent({ inner: model, retries: 2 });
  const agent = createExamplePatchAgent({ inner: assisted, patchSet: MASTERMIND_MINI_CORRECTED });
  const state = mastermind.reset(miniTier, 'mastermind/mini/public/0');
  const ctx = mmCtx(null);
  ctx.legalActions = mastermind.legalActions(state, ctx.seat);
  assert.ok(Array.isArray(ctx.legalActions) && ctx.legalActions.length > 0);
  const reply = await agent.act(ctx);
  assert.ok(reply.text.includes('guess ABA'));
  assert.equal(reply.meta.examplePatch.patchSet, 'mastermind-mini-corrected');
  assert.ok(reply.meta.assisted);
  assert.equal(reply.meta.assisted.attempts, 1);
  // The model stub (innermost) received the corrected observation and rules,
  // the official wire shape (legalActions null), and the assisted augmentation.
  const seen = model.calls[0];
  assert.ok(!seen.observation.text.includes('guess ABAB'));
  assert.ok(!seen.spec.rulesText.includes('guess ABCB'));
  assert.ok(seen.observation.text.includes('Legal actions ('));
  assert.equal(seen.legalActions, null);
});

test('the patch sets match the preregistered strings byte for byte', () => {
  // Guard against drift between PREREGISTRATION.md and patches.js: the five
  // preregistered replacements, verbatim from the preregistration document.
  assert.equal(Object.keys(PATCH_SETS).length, 2);
  assert.equal(MASTERMIND_MINI_CORRECTED.patches.length, 2);
  assert.equal(CONNECT4_LADDER_1_NEUTRAL.patches.length, 2);
  const mm = MASTERMIND_MINI_CORRECTED;
  assert.equal(mm.patches[0].find, 'Action format: "guess" followed by the code letters, e.g. "guess ABAB".');
  assert.equal(mm.patches[0].replaceWith, 'Action format: "guess" followed by 3 code letters, e.g. "guess ABA".');
  assert.equal(mm.patches[1].find, 'Action grammar: "guess" followed by the code in color letters, e.g. "guess ABCB" for a 4-peg tier.');
  assert.equal(mm.patches[1].replaceWith, 'Action grammar: "guess" followed by the code in color letters, e.g. "guess ABA" for a 3-peg tier.');
  const c4 = CONNECT4_LADDER_1_NEUTRAL;
  assert.equal(
    c4.patches[0].find,
    'the column number alone, e.g. "4" drops into column 4. Documented alternates: "column 4", "col 4", "play 4", "drop 4", "place 4", "move 4", uppercase'
  );
  assert.equal(
    c4.patches[0].replaceWith,
    'the column number alone, 1 to 7. Documented alternates: "column N", "col N", "play N", "drop N", "place N", "move N" for a column number N, uppercase'
  );
  assert.equal(c4.patches[1].find, 'use the column number 1-7, e.g. "4" or "column 4"');
  assert.equal(c4.patches[1].replaceWith, 'use the column number 1-7');
});
