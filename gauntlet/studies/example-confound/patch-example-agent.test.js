/**
 * Tests for the example-confound study's patch wrapper. Every test names
 * behavior the preregistration pins: each replacement applied exactly once,
 * nothing else in the prompt changed, a missing target throws an error naming
 * the game and the string, meta records the change, and a full episode played
 * through the wrapper still verifies with the referee and trajectory untouched.
 *
 * The tests are split by what they guard:
 *
 * - The PATCH MECHANISM tests run the wrapper on the mastermind/mini
 *   observation the patch set was preregistered against — reconstructed from
 *   the live game by reversing the preregistered replacement (strings from
 *   patches.js, never retyped) and CERTIFIED against the committed 1.0.0
 *   study trajectory's observation hash (see `mmCtx100`) — or on connect4,
 *   whose prompt text has not moved and still carries its preregistered
 *   targets.
 * - The LIVE-GUARD tests watch the live registered game. #108 (mastermind
 *   1.1.0) shipped the preregistered corrected example sentence: the live
 *   observation carries the patch's `replaceWith` byte for byte and the
 *   1.0.0 `find` target is gone, so the wrapper must refuse the live text
 *   loudly instead of passing an unpatchable prompt through. The study's
 *   mastermind arms are history recorded at 1.0.0 (see REPORT.md); a further
 *   game-text drift re-breaks the certification on purpose, so the guard
 *   stays loud.
 *
 * @module
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { GAMES } from '../../games/index.js';
import { runEpisode, judgeReply } from '../../core/runner.js';
import { verifyTrajectory } from '../../core/trajectory.js';
import { hashObservation } from '../../core/canonical.js';
import { buildOfficialTurnMessage } from '../../harness/official.js';
import { createAssistedAgent } from '../../community/assisted-agent.js';
import { createExamplePatchAgent } from './patch-example-agent.js';
import {
  MASTERMIND_MINI_CORRECTED,
  CONNECT4_LADDER_1_NEUTRAL,
  PATCH_SETS,
} from './patches.js';

/** @import { Agent, TurnContext } from '../../core/types.js' */

const STUDY_DIR = dirname(fileURLToPath(import.meta.url));

// A committed 1.0.0 run of the study's own corrected mastermind arm. Its
// step-0 observation hash is the certification for the reconstructed 1.0.0
// observation text: the trajectory carries the runner's own hash of the
// observation the wrapper actually patched on that run.
const COMMITTED_MM_100 = join(
  STUDY_DIR,
  'runs',
  'qwen2.5-0.5b-instruct-q4_k_m',
  'mastermind-mini-corrected-official',
  'mastermind',
  'mini',
  'mastermind',
  'mini',
  'public',
  '0.json'
);

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
 * The live mastermind/mini observation plus the initial game state and seat.
 * @returns {{ state: *, seat: number, observation: { text: string, data: * } }}
 */
function liveMiniObservation() {
  const state = mastermind.reset(miniTier, 'mastermind/mini/public/0');
  const seat =
    typeof mastermind.agentSeat === 'function'
      ? mastermind.agentSeat(miniTier, 'mastermind/mini/public/0')
      : 0;
  return { state, seat, observation: mastermind.observe(state, seat) };
}

/**
 * A real mastermind/mini turn context whose observation is the 1.0.0 text the
 * patch set was preregistered against: the live observation with the
 * preregistered replacement reversed (replaceWith back to find — both strings
 * come from patches.js, which a byte-for-byte test pins to the
 * preregistration document), certified against the committed 1.0.0 study
 * trajectory's step-0 observation hash. When that certification fails, the
 * game's prompt text has drifted again: the study's mastermind arms are
 * history at 1.0.0, and the certification must be re-grounded before these
 * mechanism tests mean anything.
 *
 * @param {string | null} [feedback]
 * @returns {TurnContext}
 */
function mmCtx100(feedback = null) {
  const { state, seat, observation } = liveMiniObservation();
  const obsPatch = MASTERMIND_MINI_CORRECTED.patches[0];
  const text100 = observation.text.split(obsPatch.replaceWith).join(obsPatch.find);
  const committed = JSON.parse(readFileSync(COMMITTED_MM_100, 'utf8'));
  assert.equal(
    committed.game.version,
    '1.0.0',
    'the certifying trajectory must be a committed 1.0.0 study run'
  );
  assert.equal(
    committed.steps[0].observationHash,
    hashObservation({ ...observation, text: text100 }),
    'the reconstructed 1.0.0 mastermind/mini observation no longer hashes to the committed study trajectory\u2019s step-0 observationHash \u2014 the live game\u2019s prompt text has drifted from the preregistered patch targets; the study\u2019s mastermind arms are history at 1.0.0 (see studies/example-confound/REPORT.md) and this certification must be re-grounded'
  );
  return {
    spec: mastermind.spec,
    tier: miniTier,
    seat,
    turn: 0,
    observation: { ...observation, text: text100 },
    legalActions: null,
    feedback,
  };
}

/**
 * A real mastermind/mini turn context against the LIVE game text.
 * @param {string | null} [feedback]
 * @returns {TurnContext}
 */
function mmCtx(feedback = null) {
  const { state, seat, observation } = liveMiniObservation();
  return {
    spec: mastermind.spec,
    tier: miniTier,
    seat,
    turn: 0,
    observation,
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
  const ctx = mmCtx100(MM_FEEDBACK);
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
  await agent.act(mmCtx100(MM_FEEDBACK));
  const message = buildOfficialTurnMessage(inner.calls[0], '(none)');
  assert.ok(message.includes('e.g. "guess ABA"'));
  assert.ok(!message.includes('guess ABAB'));
  assert.ok(!message.includes('guess ABCB'));
  // And the unpatched official message would have carried the wrong examples.
  const raw = buildOfficialTurnMessage(mmCtx100(MM_FEEDBACK), '(none)');
  assert.ok(raw.includes('guess ABAB'));
  assert.ok(raw.includes('guess ABCB'));
});

test('meta records every applied change with field, find and replaceWith', async () => {
  const inner = stubInner(['guess ABA']);
  const agent = createExamplePatchAgent({ inner, patchSet: MASTERMIND_MINI_CORRECTED });
  const reply = await agent.act(mmCtx100(MM_FEEDBACK));
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
  // The duplicate-target guard is game-agnostic wrapper behavior; connect4 is
  // a live game whose rules text still carries its preregistered target
  // unchanged, so the guard runs against a game as it ships today. (The
  // mastermind targets are 1.0.0 history — see REPORT.md.)
  const inner = stubInner(['4']);
  const agent = createExamplePatchAgent({ inner, patchSet: CONNECT4_LADDER_1_NEUTRAL });
  const ctx = c4Ctx();
  ctx.spec = /** @type {*} */ ({
    ...ctx.spec,
    rulesText: ctx.spec.rulesText + CONNECT4_LADDER_1_NEUTRAL.patches[0].find,
  });
  await assert.rejects(
    agent.act(ctx),
    (/** @type {Error} */ err) =>
      err.message.includes('exactly once') && err.message.includes('2 times')
  );
  assert.equal(inner.calls.length, 0, 'the inner agent never sees an ambiguous prompt');
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
  // Run on connect4, whose prompt text is unchanged: the wrapper's mastermind
  // targets are 1.0.0 history (REPORT.md) and runEpisode feeds the wrapper the
  // LIVE game's own observations, which no longer carry the preregistered
  // mastermind targets. The episode-level guarantees — replay verification,
  // untouched referee hashes, per-step meta provenance — are game-agnostic.
  // The inner always drops into the first non-full column (read from the
  // observation data the game itself handed it), so every action is valid and
  // the feedback patch (whose target only occurs in parse-error feedback,
  // covered in the unit test above) is never applicable.
  const inner = stubInner([]);
  inner.act = async (/** @type {TurnContext} */ ctx) => {
    inner.calls.push(ctx);
    const heights = /** @type {*} */ (ctx.observation.data).heights;
    const col = heights.findIndex((/** @type {number} */ h) => h < 6) + 1;
    assert.ok(col >= 1, 'connect4 observation offers a non-full column');
    return { text: String(col), usage: { inputTokens: 1, outputTokens: 2, costUsd: null } };
  };
  const agent = createExamplePatchAgent({ inner, patchSet: CONNECT4_LADDER_1_NEUTRAL });
  const trajectory = await runEpisode({
    game: connect4,
    tierId: 'ladder-1',
    seed: 'connect4/ladder-1/public/0',
    split: 'public',
    agent,
  });
  const verdict = await verifyTrajectory(connect4, trajectory);
  assert.equal(verdict.ok, true, JSON.stringify(verdict));
  // The model saw patched rules text on every turn it was called, and — the
  // connect4 patch set touching no observation field — the observation text
  // it read was the referee's own, byte for byte.
  assert.ok(inner.calls.length >= 2);
  for (const call of inner.calls) {
    assert.ok(!call.spec.rulesText.includes('e.g. "4" drops into column 4'));
    assert.ok(call.spec.rulesText.includes('the column number alone, 1 to 7.'));
  }
  // Every AGENT step's meta records the patch set. (Mastermind is solitaire, so
  // the original pin read every step; ladder-1 interleaves opponent steps,
  // which never pass through the wrapper — the referee's hashes on those are
  // covered by verifyTrajectory like every other step.) Steps carry the
  // runner's own observation HASH (never the wrapper's derived text), and
  // verifyTrajectory re-derived the identical hashes from (game, tier, seed) —
  // so the recorded trajectory is the referee's, untouched by the patching.
  // Valid plays draw no referee feedback, so each agent step applies exactly
  // the rules patch.
  const agentSteps = trajectory.steps.filter((s) => s.by === 'agent');
  assert.equal(agentSteps.length, inner.calls.length, 'every agent turn went through the wrapper');
  const stepsWithMeta = agentSteps.filter(
    (s) => s.reply && s.reply.meta && s.reply.meta.examplePatch
  );
  assert.equal(stepsWithMeta.length, agentSteps.length);
  for (const step of stepsWithMeta) {
    assert.ok(step.reply.meta);
    assert.equal(step.reply.meta.examplePatch.patchSet, 'connect4-ladder-1-neutral');
    assert.deepEqual(
      step.reply.meta.examplePatch.applied.map((/** @type {*} */ a) => a.field),
      ['rules']
    );
  }
});

test('the mastermind patch set carries no feedback patch: the runner\u2019s own empty-reply feedback passes through unpatched', async () => {
  // The empty-reply feedback is the runner's, not the game's — take it from
  // judgeReply on the live game so the pin never rests on a retyped string.
  const { state, seat } = liveMiniObservation();
  const judged = judgeReply(
    mastermind,
    state,
    seat,
    mastermind.legalActions(state, seat),
    '   \n  '
  );
  assert.equal(judged.reason, 'no action found in reply');
  const inner = stubInner(['guess ABA']);
  const agent = createExamplePatchAgent({ inner, patchSet: MASTERMIND_MINI_CORRECTED });
  const reply = await agent.act(mmCtx100(judged.reason ?? null));
  // The feedback reached the model byte for byte: this is the pin behind
  // retiring the preregistration's original third mastermind patch — the
  // reachable empty-reply feedback is example-free, so patching it would be
  // a no-op and a mastermind feedback patch could only misfire.
  assert.equal(inner.calls[0].feedback, judged.reason);
  assert.deepEqual(
    reply.meta.examplePatch.applied.map((/** @type {*} */ a) => a.field),
    ['observation', 'rules']
  );
});

test('the live 1.1.0 game ships the preregistered sentence, and the wrapper refuses the live text loudly', async () => {
  // The drift guard, watched against the LIVE registered game. #108 fixed the
  // quoted mastermind examples: the observation now carries the preregistered
  // replacement byte for byte, the 1.0.0 target is gone, and the rules target
  // survives — so the wrapper must refuse with an error naming the game, the
  // tier, the missing string and the seated version, never silently seat an
  // agent on a prompt it cannot patch.
  const obsPatch = MASTERMIND_MINI_CORRECTED.patches[0];
  const rulesPatch = MASTERMIND_MINI_CORRECTED.patches[1];
  const { observation } = liveMiniObservation();
  assert.ok(
    observation.text.includes(obsPatch.replaceWith),
    '#108 shipped the preregistered corrected sentence: the live observation carries the patch\u2019s replaceWith byte for byte'
  );
  assert.equal(
    countOccurrences(observation.text, obsPatch.find),
    0,
    'the 1.0.0 observation target is gone from the live game'
  );
  assert.equal(
    countOccurrences(mastermind.spec.rulesText, rulesPatch.find),
    1,
    'the rules target still occurs exactly once in the live rules text'
  );

  const inner = stubInner(['guess ABA']);
  const agent = createExamplePatchAgent({ inner, patchSet: MASTERMIND_MINI_CORRECTED });
  await assert.rejects(
    agent.act(mmCtx()),
    (/** @type {Error} */ err) =>
      err.message.includes('mastermind') &&
      err.message.includes('mini') &&
      err.message.includes(JSON.stringify(obsPatch.find)) &&
      err.message.includes('not found') &&
      err.message.includes(`version ${String(mastermind.spec.version)}`)
  );
  assert.equal(inner.calls.length, 0, 'the inner agent never sees an unpatched prompt');
});

test('the assisted nesting: patch outside assisted, both metas survive, the model reads patched text', async () => {
  const model = stubInner(['I will guess ABA.\nACTION: guess ABA']);
  const assisted = createAssistedAgent({ inner: model, retries: 2 });
  const agent = createExamplePatchAgent({ inner: assisted, patchSet: MASTERMIND_MINI_CORRECTED });
  const { state } = liveMiniObservation();
  const ctx = mmCtx100(null);
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
