import { test } from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { canonicalJson } from '../../core/canonical.js';
import { runConformance } from '../../core/conformance.js';
import { runEpisode } from '../../core/runner.js';
import { publicSeed } from '../../core/seeds.js';
import { verifyTrajectory } from '../../core/trajectory.js';
import { createRandomAgent } from '../../agents/random.js';
import game, { wordle as namedWordle } from './index.js';
import {
  answersFor,
  feedbackFor,
  guessesFor,
  hardModeViolation,
  nextGuess,
  referenceGuessCount,
} from './reference.js';
import { createEngineAgent, createGreedyAgent } from './baselines.js';

if (namedWordle !== game) throw new Error('named export mismatch');
void namedWordle;

const four = game.spec.tiers[0];
const classic = game.spec.tiers[1];
const hard = game.spec.tiers[2];

/**
 * A hard-mode episode whose opening guess revealed at least one hint (a G or
 * Y in the latest feedback), so the hard-mode constraint is in force.
 *
 * @returns {{ seed: string, state: import('./index.js').WordleState }}
 */
function hardModeFixture() {
  const openers = ['RAISE', 'SLATE', 'CRANE', 'STARE', 'ADIEU'];
  for (let i = 0; i < hard.publicSeeds; i++) {
    const seed = publicSeed('wordle', 'hard-mode', i);
    const probe = game.reset(hard, seed);
    for (const opener of openers) {
      const next = game.step(probe, 0, `guess ${opener}`);
      const pattern = next.guesses[0].pattern;
      if (pattern.includes('G') || pattern.includes('Y')) {
        return { seed, state: next };
      }
    }
  }
  throw new Error('no hard-mode fixture with revealed hints found');
}

test('feedback scoring on hand-checked cases, including duplicate letters', () => {
  /** @type {[string, string, string][]} */
  const cases = [
    // [guess, answer, expected pattern]
    ['SPEED', 'ABIDE', '..Y.Y'], // E at index 2 matches ABIDE's E, index 3 does not (only one E); D matches
    ['ERASE', 'SPEED', 'Y..YY'], // E and S both present elsewhere; E appears twice in SPEED
    ['CRANE', 'CRANE', 'GGGGG'], // exact
    ['PUPPY', 'PASTY', 'G...G'], // greens first; the surplus P's match nothing
    ['BOBBY', 'ROBIN', '.GG..'], // the answer's single B is consumed by the green B
    ['SPEED', 'ERASE', 'Y.YY.'], // two E yellows, S yellow, no greens
    ['ERASE', 'ABIDE', '..Y.G'], // the answer's E is the green at index 4, so index 0 E scores nothing
    ['EERIE', 'ERASE', 'G.Y.G'], // greens at 0/4; the interior R yellow-matches, the second E and I score nothing
  ];
  for (const [guess, answer, expected] of cases) {
    assert.equal(feedbackFor(guess, answer), expected, `${guess} vs ${answer}`);
  }
});

test('word lists: sizes, order, uniqueness, and the answer subset', () => {
  // Pins the committed data against the counts recorded in WORDS-LICENSE.md.
  assert.equal(guessesFor(4).length, 3903);
  assert.equal(answersFor(4).length, 2154);
  assert.equal(guessesFor(5).length, 8636);
  assert.equal(answersFor(5).length, 3251);
  for (const wordLength of [4, 5]) {
    const guesses = guessesFor(wordLength);
    const answers = answersFor(wordLength);
    assert.deepEqual(guesses, [...guesses].sort(), `${wordLength}-letter guesses must be sorted`);
    assert.equal(new Set(guesses).size, guesses.length, `${wordLength}-letter guesses must be unique`);
    for (const word of answers) {
      assert.ok(guesses.includes(word), `answer ${word} is not a legal guess`);
      assert.equal(word.length, wordLength);
      assert.match(word, /^[A-Z]+$/);
    }
  }
});

test('the engine opens with the entropy-optimal classic opener RAISE', () => {
  assert.equal(nextGuess(5, false, []), 'RAISE');
  // Hard mode shares the opening turn: no hints are in force yet.
  assert.equal(nextGuess(5, true, []), 'RAISE');
});

test('reference par is deterministic and consistent across replays', () => {
  for (const tier of [four, classic, hard]) {
    for (let i = 0; i < 3; i++) {
      const seed = publicSeed('wordle', tier.id, i);
      const state = game.reset(tier, seed);
      const first = referenceGuessCount(tier.params.wordLength, tier.params.hardMode, state.answer);
      const second = referenceGuessCount(tier.params.wordLength, tier.params.hardMode, state.answer);
      assert.equal(first, second);
      assert.ok(first >= 1);
    }
  }
});

test('the reference solves every public seed within the guess budget (75-seed sweep)', () => {
  /** @type {string[]} */
  const report = ['tier | seeds | mean par | max par | misses over budget'];
  for (const tier of [four, classic, hard]) {
    const maxGuesses = /** @type {number} */ (tier.params.maxGuesses);
    /** @type {number[]} */
    const pars = [];
    /** @type {string[]} */
    const misses = [];
    const started = performance.now();
    for (let i = 0; i < tier.publicSeeds; i++) {
      const seed = publicSeed('wordle', tier.id, i);
      const state = game.reset(tier, seed);
      const par = referenceGuessCount(tier.params.wordLength, tier.params.hardMode, state.answer);
      pars.push(par);
      if (par > maxGuesses) misses.push(`${seed}:${state.answer}:${par}`);
    }
    const mean = pars.reduce((sum, p) => sum + p, 0) / pars.length;
    assert.equal(misses.length, 0, `reference exceeded the budget: ${misses.join(', ')}`);
    assert.ok(mean > 2 && mean < 6, `${tier.id} mean par ${mean.toFixed(3)} outside the plausible band`);
    report.push(
      `${tier.id} | ${tier.publicSeeds} | ${mean.toFixed(3)} | ${Math.max(...pars)} | 0 (${(performance.now() - started).toFixed(0)} ms)`
    );
  }
  console.log(`reference sweep:\n${report.join('\n')}`);
});

test('hidden information: identical observations before the first guess, no answer leak', () => {
  const seeds = [
    publicSeed('wordle', 'classic', 0),
    publicSeed('wordle', 'classic', 7),
    publicSeed('wordle', 'classic', 13),
    'wordle/probe/hidden-info',
  ];
  /** @type {string[]} */
  const fingerprints = [];
  for (const seed of seeds) {
    const state = game.reset(classic, seed);
    const observation = game.observe(state, 0);
    fingerprints.push(canonicalJson(observation));
    // The intro uses CRANE as the parse example; strip it before leak-checking.
    const sanitized = observation.text.split('CRANE').join('');
    if (state.answer !== 'CRANE') {
      assert.ok(!sanitized.includes(state.answer), `observation leaked the answer (${state.answer})`);
    }
    assert.ok(!canonicalJson(observation.data).includes(state.answer) || state.answer === 'CRANE');
    assert.deepEqual(Object.keys(observation.data).sort(), [
      'guesses',
      'guessesRemaining',
      'hardMode',
      'status',
      'wordLength',
    ]);
  }
  assert.equal(new Set(fingerprints).size, 1, 'pre-guess observations differ across seeds');
});

test('observations reveal guesses, feedback, and remaining budget — never the answer', () => {
  const tier = classic;
  let state = game.reset(tier, publicSeed('wordle', 'classic', 0));
  const answer = state.answer;
  state = game.step(state, 0, 'guess RAISE');
  const observation = game.observe(state, 0);
  assert.match(observation.text, /1\. guess RAISE -> [GY.]{5}/);
  assert.match(observation.text, /Guesses remaining: \d+/);
  if (answer !== 'RAISE' && answer !== 'CRANE') {
    assert.ok(!observation.text.includes(answer));
  }
  assert.equal(observation.data.guessesRemaining, /** @type {number} */ (tier.params.maxGuesses) - 1);
  assert.equal(observation.data.status, 'playing');
  assert.equal(observation.data.guesses.length, 1);
});

test('hard mode: revealed greens pin positions and revealed letters must be reused', () => {
  // Synthetic histories are fine here: hardModeViolation only reads patterns.
  const eHistory = [{ guess: 'SPEED', pattern: '..Y.Y' }];
  assert.equal(hardModeViolation('SPADE', eHistory), null, 'reuses E and D');
  assert.ok(
    typeof hardModeViolation('SLATE', eHistory) === 'string',
    'missing D must be a violation'
  );
  const cHistory = [{ guess: 'CRANE', pattern: 'G.Y..' }]; // C green at 1st, A yellow at 3rd
  assert.equal(hardModeViolation('CRABS', cHistory), null, 'C pinned, A reused');
  assert.ok(typeof hardModeViolation('BRACE', cHistory) === 'string', 'C must stay at position 1');
  assert.equal(hardModeViolation('CABLE', cHistory), null, 'C pinned at 1st, A reused');
  assert.ok(typeof hardModeViolation('COBLE', cHistory) === 'string', 'A revealed, must be reused');
  const lHistory = [{ guess: 'LEVEL', pattern: 'G..GY' }];
  assert.equal(hardModeViolation('LABEL', lHistory), null);
  assert.ok(typeof hardModeViolation('LBLLE', lHistory) === 'string', 'E revealed once, must be reused');
  assert.equal(hardModeViolation('RAISE', []), null, 'no hints in force before the first guess');

  // legalActions on the hard-mode tier never narrows: legality is
  // word-list membership on every tier, and hint-binding is scored at the
  // outcome instead of enforced by rejection.
  const { seed: fixtureSeed, state: after } = hardModeFixture();
  const all = game.legalActions(game.reset(hard, fixtureSeed), 0);
  assert.equal(all.length, 8636, 'first turn: the whole 5-letter list is legal');
  const legal = game.legalActions(after, 0);
  assert.equal(legal.length, all.length, 'hints must not narrow the legal set');
  assert.deepEqual(legal, all, 'the legal list is byte-identical once hints are in force');
  assert.ok(legal.includes(`guess ${after.guesses[0].guess}`), 'the opener is still legal');
});

test('parseAction accepts the canonical action and documented alternates', () => {
  const state = game.reset(classic, 's');
  for (const [text, expected] of [
    ['guess CRANE', 'guess CRANE'],
    ['CRANE', 'guess CRANE'],
    ['guess crane', 'guess CRANE'],
    ['crane', 'guess CRANE'],
    ['  guess CRANE  ', 'guess CRANE'],
    ['"CRANE"', 'guess CRANE'],
    ['`guess CRANE`', 'guess CRANE'],
    ["'crane'", 'guess CRANE'],
    ['try CRANE', 'guess CRANE'],
    ['play slate', 'guess SLATE'],
    ['C R A N E', 'guess CRANE'],
    ['guess c r a n e', 'guess CRANE'],
  ]) {
    const parsed = game.parseAction(state, 0, text);
    assert.deepEqual(parsed, { ok: true, action: expected }, `input ${JSON.stringify(text)}`);
  }
  // The verb/word collision resolves to the word: GUESS is a real word, so
  // "guess" (and "guess guess") parse as the word GUESS.
  const guessWord = game.parseAction(state, 0, 'guess');
  assert.deepEqual(guessWord, { ok: true, action: 'guess GUESS' });
  for (const bad of ['', 'CRANES', 'guess CRAN', 'guess ZZZZZ', 'guess CR#NE', 'zzz']) {
    const parsed = game.parseAction(state, 0, bad);
    assert.equal(parsed.ok, false, `input ${JSON.stringify(bad)} should be rejected`);
    if (!parsed.ok) {
      assert.equal(typeof parsed.error, 'string');
      assert.ok(parsed.error.length > 10, 'rejections must be helpful');
    }
  }
  const unlisted = game.parseAction(state, 0, 'guess ZZZZZ');
  assert.ok(!unlisted.ok && /word list/.test(unlisted.error), 'unlisted words name the word list');
  const wrongLength = game.parseAction(state, 0, 'guess TALE');
  assert.ok(!wrongLength.ok && /5-letter/.test(wrongLength.error), 'wrong length names the length');
  // Hard-mode-violating words are legal guesses: binding is scored at the
  // outcome, not enforced by rejection.
  const { state: hardAfter } = hardModeFixture();
  const violating = guessesFor(5).find(
    (w) => hardModeViolation(w, hardAfter.guesses) !== null
  );
  assert.ok(violating, 'the fixture must admit a hard-mode-breaking word');
  const violation = game.parseAction(hardAfter, 0, `guess ${violating}`);
  assert.deepEqual(violation, { ok: true, action: `guess ${violating}` });
});

test('step is pure, scores feedback, and ends the game won or lost', () => {
  const tier = classic;
  const seed = publicSeed('wordle', 'classic', 3);
  const state = game.reset(tier, seed);
  const before = JSON.parse(JSON.stringify(state));
  const next = game.step(state, 0, 'guess RAISE');
  assert.deepEqual(state, before, 'step mutated its input');
  assert.notEqual(next, state);
  assert.equal(next.guesses.length, 1);
  assert.deepEqual(next.guesses[0], { guess: 'RAISE', pattern: feedbackFor('RAISE', state.answer) });
  assert.equal(game.toAct(next), 0);
  assert.equal(game.outcome(next), null);

  // Solve it.
  let solved = next;
  let guard = 0;
  while (solved.status === 'playing' && guard++ < tier.maxActions) {
    solved = game.step(solved, 0, `guess ${solved.answer}`);
  }
  assert.equal(solved.status, 'won');
  const outcome = game.outcome(solved);
  assert.ok(outcome && outcome.solved === true);
  assert.equal(outcome.par, referenceGuessCount(5, false, state.answer));
  assert.ok(outcome.normalized[0] > 0 && outcome.normalized[0] <= 1);

  // A lost episode: the full budget of wrong (but legal) guesses.
  let lost = game.reset(tier, seed);
  const wrong = lost.answer === 'CRANE' ? 'SLATE' : 'CRANE';
  for (let i = 0; i < /** @type {number} */ (tier.params.maxGuesses); i++) {
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
  for (const bad of ['CRANE', 'guess', 'guess CRANES', 'guess ZZZZZ', '__nope__', 'guess CRANE extra']) {
    assert.throws(() => game.step(state, 0, bad), (/** @type {Error} */ err) => {
      return err.name === 'GauntletRuleError';
    }, `expected GauntletRuleError for ${JSON.stringify(bad)}`);
  }
});

test('action budgets: 4x the guess limit, invalid attempts have headroom', () => {
  for (const tier of [four, classic, hard]) {
    const maxGuesses = /** @type {number} */ (tier.params.maxGuesses);
    assert.equal(tier.maxActions, 4 * maxGuesses);
    assert.ok(tier.maxActions >= 2 * maxGuesses, 'documented headroom rule');
  }
});

test('engine baseline solves every public seed in exactly par; greedy and random complete', async () => {
  const SEEDS = 25;
  /** @type {string[]} */
  const report = ['tier | baseline | mean episode score | solved fraction'];
  for (const tier of [four, classic, hard]) {
    /** @type {[string, (options: { episodeSeed: string }) => import('../../core/types.js').Agent][]} */
    const baselines = [
      ['engine', createEngineAgent],
      ['greedy', createGreedyAgent],
    ];
    for (const [id, create] of baselines) {
      let total = 0;
      let solved = 0;
      for (let i = 0; i < SEEDS; i++) {
        const seed = publicSeed('wordle', tier.id, i);
        const trajectory = await runEpisode({ game, tierId: tier.id, seed, agent: create({ episodeSeed: seed }) });
        if (i === 0 && id === 'engine') {
          await assert.doesNotReject(() => verifyTrajectory(game, trajectory));
        }
        const outcome = trajectory.end.outcome;
        assert.ok(outcome, 'episode ended without an outcome');
        assert.ok(trajectory.end.reason === 'terminal' || trajectory.end.reason === 'budget-exhausted');
        const episodeScore = outcome.solved
          ? Math.min(1.15, (/** @type {number} */ (outcome.par) / trajectory.end.agentActions) ** 2)
          : 0;
        total += episodeScore;
        if (outcome.solved) solved++;
        if (id === 'engine') {
          assert.equal(trajectory.end.reason, 'terminal', 'engine must always solve the answer');
          assert.equal(outcome.solved, true);
          assert.equal(trajectory.end.agentActions, outcome.par, 'engine must use exactly par actions');
          assert.equal(episodeScore, 1.0, 'engine scores exactly 1.0');
        }
      }
      report.push(`${tier.id} | ${id} | ${(total / SEEDS).toFixed(3)} | ${(solved / SEEDS).toFixed(2)}`);
    }
    // The random agent must also complete legally on the tier (hard mode
    // included: it plays from legalActions).
    const seed = publicSeed('wordle', tier.id, 0);
    const trajectory = await runEpisode({ game, tierId: tier.id, seed, agent: createRandomAgent({ episodeSeed: seed }) });
    await assert.doesNotReject(() => verifyTrajectory(game, trajectory));
    assert.ok(trajectory.end.outcome, 'random episode ended without an outcome');
  }
  console.log(`baseline table:\n${report.join('\n')}`);
});

test('runConformance passes every tier', async () => {
  const report = await runConformance(game);
  assert.equal(report.ok, true);
  assert.equal(report.game, 'wordle');
  assert.ok(report.checks > 0);
});

test('hard mode is scored, not blocked: a broken-hint solve counts as unsolved', () => {
  const { state: after } = hardModeFixture();
  const violating = guessesFor(5).find(
    (w) => hardModeViolation(w, after.guesses) !== null
  );
  assert.ok(violating, 'the fixture must admit a hard-mode-breaking word');

  // The breaking guess is applied and scored as normal feedback.
  const stepped = game.step(after, 0, `guess ${violating}`);
  assert.equal(stepped.guesses.length, after.guesses.length + 1, 'the breaking guess was applied');
  assert.equal(stepped.bindingBroken, true, 'the break is recorded on the state');
  assert.equal(stepped.guesses[stepped.guesses.length - 1].pattern.length, 5, 'normal per-letter feedback');
  assert.equal(game.toAct(stepped), 0, 'the episode continues');

  // Solving after a break still counts as unsolved.
  const solved = game.step(stepped, 0, `guess ${stepped.answer}`);
  assert.equal(solved.status, 'won');
  assert.equal(solved.bindingBroken, true);
  const brokenOutcome = game.outcome(solved);
  assert.ok(brokenOutcome && brokenOutcome.solved === false, 'a broken-hint solve is unsolved');
  assert.deepEqual(brokenOutcome.normalized, [0]);
  assert.match(brokenOutcome.reason, /hard mode was broken/);

  // A history with no break solves normally on the same tier.
  const fresh = game.reset(hard, 'wordle/binding-clean');
  const clean = game.step(fresh, 0, `guess ${fresh.answer}`);
  assert.equal(clean.status, 'won');
  assert.equal(clean.bindingBroken, false);
  const cleanOutcome = game.outcome(clean);
  assert.ok(cleanOutcome && cleanOutcome.solved === true);
  assert.equal(cleanOutcome.par, referenceGuessCount(5, true, fresh.answer));
});

test('random on hard-mode floors near zero: uniform play breaks binding long before it solves', { timeout: 120_000 }, async () => {
  let total = 0;
  let solvedClean = 0;
  for (let i = 0; i < 25; i++) {
    const seed = publicSeed('wordle', 'hard-mode', i);
    const trajectory = await runEpisode({ game, tierId: 'hard-mode', seed, agent: createRandomAgent({ episodeSeed: seed }) });
    const outcome = trajectory.end.outcome;
    assert.ok(outcome, 'episode ended without an outcome');
    await assert.doesNotReject(() => verifyTrajectory(game, trajectory));
    const episodeScore = outcome.solved
      ? Math.min(1.15, (/** @type {number} */ (outcome.par) / trajectory.end.agentActions) ** 2)
      : 0;
    total += episodeScore;
    if (outcome.solved) solvedClean++;
  }
  // Before the scored-binding change, uniform play drew from the
  // hard-mode-consistent list and scored 0.218 mean with a 32% solve rate.
  // Now the whole list is legal, so uniform play almost always breaks binding
  // before it can solve: the floor stays near zero. One clean uniform solve
  // scores at most 1.15; two over 25 seeds are astronomically unlikely.
  assert.ok(total <= 1.2, `random hard-mode total ${total.toFixed(3)} too high (${solvedClean} clean solves)`);
});
