import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractAction, runEpisode, findTier } from './runner.js';
import { verifyTrajectory, TRAJECTORY_FORMAT } from './trajectory.js';
import { getGame } from '../games/index.js';
import { createRandomAgent } from '../agents/random.js';

const game = getGame('tictactoe');

test('extractAction reads the last non-empty line and strips wrappers', () => {
  assert.equal(extractAction('I will play b2'), 'I will play b2');
  assert.equal(extractAction('thinking...\n\nb2'), 'b2');
  assert.equal(extractAction('`a1`'), 'a1');
  assert.equal(extractAction('"c3"'), 'c3');
  assert.equal(extractAction("'a2'"), 'a2');
  assert.equal(extractAction('Action: b1'), 'b1');
  assert.equal(extractAction('ACTION:  c2'), 'c2');
  assert.equal(extractAction('action: `a3`'), 'a3');
  assert.equal(extractAction('   \n   '), null);
  assert.equal(extractAction(''), null);
});

test('findTier resolves tiers and rejects unknown ones', () => {
  assert.equal(findTier(game, 'perfect-opponent').rank, 3);
  assert.throws(() => findTier(game, 'nope'), /has no tier "nope"/);
});

test('a random agent draws or loses to the minimax opponent, and never wins', async () => {
  for (let i = 0; i < 8; i++) {
    const seed = `tictactoe/perfect-opponent/public/${i}`;
    const trajectory = await runEpisode({
      game,
      tierId: 'perfect-opponent',
      seed,
      agent: createRandomAgent({ episodeSeed: seed }),
    });
    assert.equal(trajectory.end.reason, 'terminal', `seed ${seed}`);
    const seat = trajectory.agent.seat;
    const myScore = /** @type {import('./types.js').Outcome} */ (trajectory.end.outcome).normalized[seat];
    assert.ok(myScore <= 0.5, `agent scored ${myScore} against perfect play on ${seed}`);
    // The opponent never plays an invalid move.
    assert.equal(trajectory.end.invalidActions, 0);
    for (const step of trajectory.steps) {
      if (step.by === 'opponent') {
        assert.equal(step.invalid, false, 'opponent produced an invalid step');
      }
    }
  }
});

test('episodes are reproducible: the same seed produces identical trajectories', async () => {
  const seed = 'repro-check-seed';
  const run = () =>
    runEpisode({
      game,
      tierId: 'perfect-opponent',
      seed,
      agent: createRandomAgent({ episodeSeed: seed }),
    });
  const [a, b] = await Promise.all([run(), run()]);
  // Timings and wall-clock stamps vary; everything else must match.
  const scrub = (/** @type {*} */ t) => {
    const copy = JSON.parse(JSON.stringify(t));
    copy.startedAt = copy.finishedAt = null;
    for (const step of copy.steps) step.ms = 0;
    return copy;
  };
  assert.deepEqual(scrub(a), scrub(b));
});

test('invalid attempts feed back, count against the budget, and forfeit after three', async () => {
  const attempts = [];
  const agent = {
    id: 'stubborn-invalid',
    track: /** @type {'official'} */ ('official'),
    async act() {
      attempts.push(attempts.length);
      // Attempt 1 invalid; attempt 2 (with feedback) legal; then repeat.
      if (attempts.length === 1) {
        return { text: 'z9' };
      }
      if (attempts.length % 2 === 0) {
        return { text: 'b2' };
      }
      return { text: 'not a cell' };
    },
  };
  const trajectory = await runEpisode({
    game,
    tierId: 'perfect-opponent',
    seed: 'feedback-seed',
    agent,
    maxConsecutiveInvalid: 2,
  });
  assert.equal(trajectory.end.reason, 'forfeit-invalid');
  assert.equal(trajectory.end.invalidActions >= 2, true);
  const forfeitedSeat = trajectory.agent.seat;
  const forfeitOutcomeRecord = /** @type {import('./types.js').Outcome} */ (trajectory.end.outcome);
  assert.deepEqual(forfeitOutcomeRecord.normalized[forfeitedSeat], 0);
  assert.equal(forfeitOutcomeRecord.normalized[1 - forfeitedSeat], 1);
  assert.ok((await verifyTrajectory(game, trajectory)).ok);
});

test('exhausting the action budget ends the episode via truncate()', async () => {
  let turn = 0;
  const agent = {
    id: 'slow-invalid',
    track: /** @type {'baseline'} */ ('baseline'),
    async act() {
      turn++;
      // Always invalid: budget drains without ending the game.
      return { text: `attempt-${turn}` };
    },
  };
  const trajectory = await runEpisode({
    game,
    tierId: 'perfect-opponent',
    seed: 'budget-seed',
    agent,
    maxConsecutiveInvalid: 99,
  });
  assert.equal(trajectory.end.reason, 'budget-exhausted');
  assert.equal(trajectory.end.agentActions, game.spec.tiers[0].maxActions);
  assert.equal(/** @type {import('./types.js').Outcome} */ (trajectory.end.outcome).raw, null, 'truncate() assessments carry raw: null');
  assert.ok((await verifyTrajectory(game, trajectory)).ok);
});

test('official-track agents receive no legalActions list', async () => {
  let seen = /** @type {string[] | null | Symbol} */ (Symbol('unset'));
  const agent = {
    id: 'official-probe',
    track: /** @type {'official'} */ ('official'),
    async act(/** @type {import('./types.js').TurnContext} */ ctx) {
      seen = ctx.legalActions;
      return { text: 'b2' };
    },
  };
  await runEpisode({ game, tierId: 'perfect-opponent', seed: 'official-seed', agent });
  assert.equal(seen, null);
});

test('baseline agents receive the legalActions list', async () => {
  let seen = /** @type {string[] | null | Symbol} */ (Symbol('unset'));
  const agent = {
    id: 'baseline-probe',
    track: /** @type {'baseline'} */ ('baseline'),
    async act(/** @type {import('./types.js').TurnContext} */ ctx) {
      seen = ctx.legalActions;
      return { text: (ctx.legalActions ?? [])[0] };
    },
  };
  await runEpisode({ game, tierId: 'perfect-opponent', seed: 'baseline-seed', agent });
  assert.ok(Array.isArray(seen), 'baseline ctx exposes legalActions');
  assert.ok(seen.length > 0, 'legalActions is non-empty on a live turn');
});

test('a recorded episode satisfies the trajectory format and verifies', async () => {
  const seed = 'tictactoe/perfect-opponent/public/0';
  const trajectory = await runEpisode({
    game,
    tierId: 'perfect-opponent',
    seed,
    agent: createRandomAgent({ episodeSeed: seed }),
  });
  assert.equal(trajectory.format, TRAJECTORY_FORMAT);
  assert.equal(trajectory.game.id, 'tictactoe');
  assert.equal(trajectory.tier, 'perfect-opponent');
  assert.equal(trajectory.split, 'public');
  assert.ok(trajectory.steps.length >= 5, 'a tictactoe episode has at least five plies');
  for (const step of trajectory.steps) {
    assert.match(step.observationHash, /^[0-9a-f]{16}$/);
    assert.equal(typeof step.reply.text, 'string');
    assert.equal(typeof step.ms, 'number');
  }
  const result = await verifyTrajectory(game, trajectory);
  assert.deepEqual(result, { ok: true });
});
