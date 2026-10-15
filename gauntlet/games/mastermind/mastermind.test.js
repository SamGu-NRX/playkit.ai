import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalJson } from '../../core/canonical.js';
import { runConformance } from '../../core/conformance.js';
import { runEpisode } from '../../core/runner.js';
import { publicSeed } from '../../core/seeds.js';
import { verifyTrajectory } from '../../core/trajectory.js';
import game, { default as defaultGame } from './index.js';
import { allCodes, feedbackFor, referenceGuessCount, referenceNextGuess } from './reference.js';
import { createEngineAgent, createGreedyAgent } from './baselines.js';

if (defaultGame !== game) throw new Error('default export mismatch');
void defaultGame;

const classic = game.spec.tiers[0];
const wide = game.spec.tiers[1];
const deep = game.spec.tiers[2];

test('feedback scoring on hand-checked cases, including repeated colors', () => {
  /** @type {[string, string, number, number][]} */
  const cases = [
    // [guess, secret, blacks, whites]
    ['AABB', 'AABB', 4, 0], // exact hit
    ['AAAA', 'BBBB', 0, 0], // disjoint alphabets in play
    ['ABAB', 'AABB', 2, 2], // two exact, two displaced
    ['AABC', 'ABCA', 1, 3], // one exact, three displaced
    ['AAAA', 'AABB', 2, 0], // repeats: extra A's score nothing
    ['AAAA', 'ABBB', 1, 0],
    ['BBAA', 'ABAB', 2, 2], // two exact, two displaced
    ['ABCB', 'ABCB', 4, 0],
    ['ABCB', 'BBBA', 1, 2], // B appears twice in secret, guessed three times
    ['EEDD', 'DDEE', 0, 4],
  ];
  for (const [guess, secret, blacks, whites] of cases) {
    assert.deepEqual(feedbackFor(guess, secret), { blacks, whites }, `${guess} vs ${secret}`);
  }
});

test('code spaces have the right size and lexicographic order', () => {
  assert.equal(allCodes(4, 6).length, 1296);
  assert.equal(allCodes(5, 8).length, 8 ** 5);
  assert.equal(allCodes(6, 9).length, 9 ** 6);
  const codes = allCodes(4, 6);
  assert.deepEqual(codes, [...codes].sort());
  assert.equal(codes[0], 'AAAA');
  assert.equal(codes[codes.length - 1], 'FFFF');
});

test('classic opens with Knuth minimax first guess AABB', () => {
  assert.equal(referenceNextGuess(4, 6, [], 'any-seed'), 'AABB');
});

test("Knuth's strategy solves every classic secret in at most 5 guesses", () => {
  const codes = allCodes(4, 6);
  let max = 0;
  let total = 0;
  for (const secret of codes) {
    const guesses = referenceGuessCount(4, 6, `knuth-sweep/${secret}`, secret);
    max = Math.max(max, guesses);
    total += guesses;
  }
  const mean = total / codes.length;
  assert.ok(max <= 5, `Knuth worst case exceeded 5: ${max}`);
  assert.ok(mean > 4 && mean < 4.6, `mean ${mean.toFixed(4)} outside the expected band`);
  // Knuth's published figures: worst case 5, mean 4.4761 (5801/1296).
  assert.equal(total, 5801);
  console.log(`classic sweep: max ${max} guesses, mean ${mean.toFixed(4)} over ${codes.length} secrets`);
});

test('reference par is deterministic and consistent with the engine replay', () => {
  for (const tier of [classic, wide, deep]) {
    for (let i = 0; i < 3; i++) {
      const seed = publicSeed('mastermind', tier.id, i);
      const state = game.reset(tier, seed);
      const first = referenceGuessCount(tier.params.pegs, tier.params.colors, seed, state.secret);
      const second = referenceGuessCount(tier.params.pegs, tier.params.colors, seed, state.secret);
      assert.equal(first, second);
      assert.ok(first >= 1);
    }
  }
});

test('hidden information: different secrets, identical observations before the first guess', () => {
  const seeds = ['mastermind/classic/public/0', 'mastermind/classic/public/7', 'knuth-sweep/ABCD'];
  /** @type {string[]} */
  const fingerprints = [];
  for (const seed of seeds) {
    const state = game.reset(classic, seed);
    const observation = game.observe(state, 0);
    fingerprints.push(canonicalJson(observation));
    const text = observation.text;
    for (const other of seeds) {
      const otherSecret = game.reset(classic, other).secret;
      assert.ok(!text.includes(otherSecret), `observation leaked a secret (${otherSecret})`);
    }
    assert.ok(!canonicalJson(observation.data).includes('secret'), 'observation data mentions the secret');
    assert.ok(!canonicalJson(state).includes(observation.data.alphabet + '!!!!')); // sanity no-op
  }
  assert.equal(new Set(fingerprints).size, 1, 'observations differ before the first guess');
});

test('observations reveal guesses, feedback, and remaining budget — never the secret', () => {
  let state = game.reset(wide, 'mastermind/wide/public/0');
  const secret = state.secret;
  state = game.step(state, 0, `guess ${'AABBC'.slice(0, 5)}`);
  const observation = game.observe(state, 0);
  assert.match(observation.text, /1\. guess AABBC -> \d+ black, \d+ white/);
  assert.match(observation.text, /Guesses remaining: \d+/);
  assert.ok(!observation.text.includes(secret));
  assert.equal(observation.data.guessesRemaining, wide.maxActions - 1);
  assert.equal(observation.data.status, 'playing');
});

test('parseAction accepts the canonical action and documented alternates', () => {
  const state = game.reset(classic, 's');
  for (const [text, expected] of [
    ['guess ABCD', 'guess ABCD'],
    ['ABCD', 'guess ABCD'],
    ['guess abcd', 'guess ABCD'],
    ['abcd', 'guess ABCD'],
    ['  guess ABCD  ', 'guess ABCD'],
    ['"ABCD"', 'guess ABCD'],
    ['`guess ABCD`', 'guess ABCD'],
    ["'abcd'", 'guess ABCD'],
    ['try ABCD', 'guess ABCD'],
    ['play dcba', 'guess DCBA'],
    ['A B C D', 'guess ABCD'],
    ['guess a b c d', 'guess ABCD'],
  ]) {
    const parsed = game.parseAction(state, 0, text);
    assert.deepEqual(parsed, { ok: true, action: expected }, `input ${JSON.stringify(text)}`);
  }
  for (const bad of ['', 'ABCDE', 'guess ABC', 'guess ABZZ', 'guess AB#D', 'zzz', 'guess']) {
    const parsed = game.parseAction(state, 0, bad);
    assert.equal(parsed.ok, false, `input ${JSON.stringify(bad)} should be rejected`);
    if (!parsed.ok) assert.equal(typeof parsed.error, 'string');
  }
  // Tier alphabets are enforced: H is legal on wide, not on classic.
  const wideState = game.reset(wide, 's');
  assert.deepEqual(game.parseAction(wideState, 0, 'guess AABCH'), { ok: true, action: 'guess AABCH' });
  assert.equal(game.parseAction(classic && wideState, 0, 'guess AABCI').ok, false, 'I is beyond the wide alphabet');
});

test('step is pure, scores feedback, and ends the game won or lost', () => {
  const tier = classic;
  const seed = 'mastermind/classic/public/3';
  const state = game.reset(tier, seed);
  const before = JSON.parse(JSON.stringify(state));
  const next = game.step(state, 0, 'guess AABB');
  assert.deepEqual(state, before, 'step mutated its input');
  assert.notEqual(next, state);
  assert.equal(next.guesses.length, 1);
  assert.deepEqual(next.guesses[0], {
    guess: 'AABB',
    blacks: feedbackFor('AABB', state.secret).blacks,
    whites: feedbackFor('AABB', state.secret).whites,
  });
  assert.equal(game.toAct(next), 0);
  assert.equal(game.outcome(next), null);

  // Solve it.
  let solved = next;
  let guard = 0;
  while (solved.status === 'playing' && guard++ < tier.maxActions) {
    solved = game.step(solved, 0, `guess ${solved.secret}`);
  }
  assert.equal(solved.status, 'won');
  const outcome = game.outcome(solved);
  assert.ok(outcome && outcome.solved === true);
  assert.equal(outcome.par, referenceGuessCount(4, 6, seed, state.secret));
  assert.ok(outcome.normalized[0] > 0 && outcome.normalized[0] <= 1);

  // A lost episode: budget of wrong guesses.
  let lost = game.reset(tier, seed);
  const wrong = lost.secret === 'AAAA' ? 'BBBB' : 'AAAA';
  for (let i = 0; i < tier.maxActions; i++) {
    lost = game.step(lost, 0, `guess ${wrong}`);
  }
  assert.equal(lost.status, 'lost');
  const lostOutcome = game.outcome(lost);
  assert.ok(lostOutcome && lostOutcome.solved === false);
  assert.deepEqual(lostOutcome.normalized, [0]);
  assert.equal(game.toAct(lost), null);
});

test('step throws GauntletRuleError for non-canonical or malformed actions', () => {
  const state = game.reset(classic, 's');
  for (const bad of ['ABCD', 'guess', 'guess ABCDE', 'guess ABZZ', '__nope__', 'guess ABCD extra']) {
    assert.throws(() => game.step(state, 0, bad), (/** @type {Error} */ err) => {
      return err.name === 'GauntletRuleError';
    }, `expected GauntletRuleError for ${JSON.stringify(bad)}`);
  }
});

test('tier budgets cover 5x par and rise with rank', () => {
  assert.equal(classic.maxActions, Math.max(10, 5 * 5)); // Knuth worst case is 5
  assert.ok(wide.maxActions >= 10);
  assert.ok(deep.maxActions >= wide.maxActions);
  for (let i = 0; i < 20; i++) {
    for (const tier of [classic, wide, deep]) {
      const state = game.reset(tier, `${tier.id}/budget-check/${i}`);
      const par = referenceGuessCount(tier.params.pegs, tier.params.colors, `${tier.id}/budget-check/${i}`, state.secret);
      assert.ok(tier.maxActions >= 5 * par, `${tier.id}: budget ${tier.maxActions} < 5x par ${par}`);
    }
  }
});

test('reference-strategy time per guess on deep (reported)', () => {
  const turns = [];
  const seeds = 5;
  for (let i = 0; i < seeds; i++) {
    const seed = `mastermind/deep/public/${i}`;
    const state = game.reset(deep, seed);
    /** @type {import('./index.js').MastermindHistoryEntry[]} */
    const history = [];
    for (;;) {
      const started = performance.now();
      const guess = referenceNextGuess(6, 9, history, seed);
      turns.push(performance.now() - started);
      const fb = feedbackFor(guess, state.secret);
      if (fb.blacks === 6) break;
      history.push({ guess, blacks: fb.blacks, whites: fb.whites });
    }
  }
  const total = turns.reduce((sum, ms) => sum + ms, 0);
  const worst = Math.max(...turns);
  console.log(
    `deep reference: ${turns.length} guesses over ${seeds} seeds, ` +
      `mean ${(total / turns.length).toFixed(1)} ms/guess, worst ${worst.toFixed(1)} ms`
  );
  assert.ok(worst < 30000, `a deep turn took ${worst.toFixed(0)} ms — too slow`);
});

test('engine baseline scores exactly 1.0 on every tier; greedy baseline reported', async () => {
  const SEEDS = 25;
  /** @type {string[]} */
  const report = ['tier | baseline | mean episode score | solved fraction (25 public seeds)'];
  for (const tier of [classic, wide, deep]) {
    /** @type {[string, (options: { episodeSeed: string }) => import('../../core/types.js').Agent][]} */
    const baselines = [
      ['engine', createEngineAgent],
      ['greedy', createGreedyAgent],
    ];
    for (const [id, create] of baselines) {
      let total = 0;
      let solved = 0;
      for (let i = 0; i < SEEDS; i++) {
        const seed = publicSeed('mastermind', tier.id, i);
        const trajectory = await runEpisode({ game, tierId: tier.id, seed, agent: create({ episodeSeed: seed }) });
        if (i === 0 && id === 'engine') {
          // The engine's first trajectory per tier must replay exactly.
          await assert.doesNotReject(() => verifyTrajectory(game, trajectory));
        }
        const outcome = trajectory.end.outcome;
        assert.ok(outcome, 'episode ended without an outcome');
        assert.ok(typeof outcome.par === 'number' || outcome.solved === false);
        assert.ok(trajectory.end.reason === 'terminal' || trajectory.end.reason === 'budget-exhausted');
        const episodeScore = outcome.solved
          ? Math.min(1.15, (/** @type {number} */ (outcome.par) / trajectory.end.agentActions) ** 2)
          : 0;
        assert.ok(episodeScore >= 0 && episodeScore <= 1.15);
        total += episodeScore;
        if (outcome.solved) solved++;
        if (id === 'engine') {
          assert.equal(trajectory.end.reason, 'terminal', 'engine must always solve the secret');
          assert.equal(outcome.solved, true);
          assert.equal(trajectory.end.agentActions, outcome.par, 'engine must use exactly par actions');
          assert.equal(episodeScore, 1.0, 'engine scores exactly 1.0');
        }
      }
      report.push(`${tier.id} | ${id} | ${(total / SEEDS).toFixed(3)} | ${(solved / SEEDS).toFixed(2)}`);
    }
  }
  console.log(`baseline table:\n${report.join('\n')}`);
});

test('runConformance passes every tier', async () => {
  const report = await runConformance(game);
  assert.equal(report.ok, true);
  assert.equal(report.game, 'mastermind');
  assert.ok(report.checks > 0);
});
