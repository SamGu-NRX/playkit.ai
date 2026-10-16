import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildFrames, ReplayRefusedError } from './frames.js';
import { getGame } from '../games/index.js';

const here = dirname(fileURLToPath(import.meta.url));

// Fixtures are generated deterministically at the CURRENT game versions by
// replay/fixtures/generate.mjs (a scripted dry-run model agent with
// model-shaped replies — a long ramble, an unparseable guess). Regenerate with
// `node replay/fixtures/generate.mjs`; the script is byte-identical across
// runs, and the tests never depend on studies/ or reports/ recordings, so a
// game-version bump cannot rot them again.
/** @type {Record<string, string>} */
const FIXTURES = {
  // Two-player, terminal: the fixture agent loses to the perfect minimax
  // opponent; every reply parses.
  tictactoe: join(here, 'fixtures/tictactoe-perfect-opponent.json'),
  // Solitaire, forfeit-invalid: three valid guesses, then three consecutive
  // unparseable ones.
  mastermind: join(here, 'fixtures/mastermind-forfeit.json'),
  // Solitaire, mixed: one unparseable guess early, then valid guesses to
  // budget exhaustion.
  mastermindMixed: join(here, 'fixtures/mastermind-mixed.json'),
};

/**
 * @param {string} file
 * @returns {import('../core/types.js').Trajectory}
 */
function loadTrajectory(file) {
  return /** @type {import('../core/types.js').Trajectory} */ (
    JSON.parse(readFileSync(file, 'utf8'))
  );
}

test('replays a committed two-player terminal episode into frames', async () => {
  const file = FIXTURES.tictactoe;
  const trajectory = loadTrajectory(file);
  const payload = await buildFrames(getGame('tictactoe'), trajectory, { path: file });

  assert.equal(payload.format, 'playkit-gauntlet-replay-frames/1');
  assert.equal(payload.frames.length, trajectory.steps.length);
  assert.equal(payload.agentSeat, trajectory.agent.seat);
  assert.deepEqual(payload.end, trajectory.end);

  // Per-seat turn numbering matches the runner's TurnContext.turn: one number
  // per attempt for that seat, invalid attempts included.
  /** @type {Map<number, number>} */
  const seen = new Map();
  for (const frame of payload.frames) {
    const step = trajectory.steps[frame.index];
    assert.equal(frame.turn, seen.get(frame.seat) ?? 0);
    seen.set(frame.seat, frame.turn + 1);
    assert.equal(frame.by, step.by);
    assert.equal(frame.observation.hash, step.observationHash);
    assert.ok(frame.observation.text.length > 0, 'observation text is re-derived');
    assert.equal(frame.reply.text, step.reply.text, 'reply text is as recorded');
    assert.equal(frame.ms, step.ms);
    assert.equal(frame.parse.invalid, step.invalid);
    if (!frame.parse.invalid) {
      assert.equal(frame.parse.canonical, step.action);
      assert.equal(frame.parse.reason, null);
      assert.equal(frame.parse.attempted, frame.parse.canonical);
    }
  }

  // The opponent (X) and the agent (O) alternate: the opponent opened, so
  // three opponent attempts against two agent attempts before the loss.
  assert.deepEqual([...seen.keys()].sort(), [0, 1]);
  assert.equal(seen.get(0), 3);
  assert.equal(seen.get(1), 2);
  assert.equal(payload.frames[0].actorId, 'minimax-perfect');
  const agentFrame = payload.frames.find((f) => f.by === 'agent');
  if (!agentFrame) throw new Error('the episode has agent frames');
  assert.equal(agentFrame.actorId, trajectory.agent.id);

  // Usage and latency ride along where the trajectory recorded them. The
  // fixture agent is a scripted dry-run agent, so its usage is zero.
  assert.deepEqual(agentFrame.usage, {
    inputTokens: 0,
    outputTokens: 0,
    costUsd: null,
  });

  // The final frame carries the real outcome; earlier frames carry the game's
  // own running positional score (truncate()).
  const last = payload.frames[payload.frames.length - 1];
  assert.equal(last.gameOver, true);
  assert.ok(last.score, 'a terminal outcome-tier frame carries a score');
  assert.equal(last.score.kind, 'outcome');
  assert.ok(trajectory.end.outcome, 'the fixture records an outcome');
  assert.equal(
    last.score.value,
    trajectory.end.outcome.normalized[payload.agentSeat]
  );
  assert.equal(last.score.value, 0, 'the agent lost this episode');
  for (const frame of payload.frames.slice(0, -1)) {
    assert.ok(frame.score, 'outcome-tier frames carry the running score');
    assert.equal(frame.score.kind, 'truncate');
    assert.ok(frame.score.value >= 0 && frame.score.value <= 1);
    assert.equal(frame.gameOver, false);
  }
});

test('invalid replies show the referee error and the feedback the model saw next', async () => {
  const file = FIXTURES.mastermind;
  const trajectory = loadTrajectory(file);
  assert.equal(trajectory.end.reason, 'forfeit-invalid');
  const payload = await buildFrames(getGame('mastermind'), trajectory);

  const invalid = payload.frames.filter((f) => f.parse.invalid);
  assert.equal(invalid.length, trajectory.end.invalidActions);
  assert.ok(invalid.length >= 3, 'the fixture ends on consecutive invalid replies');
  for (const frame of invalid) {
    assert.equal(frame.parse.canonical, null);
    assert.ok(frame.parse.reason && frame.parse.reason.length > 0);
    assert.equal(frame.action, frame.parse.attempted, 'the attempted text is recorded');
    assert.equal(frame.gameOver, false, 'a forfeit ends the episode, not a move');
  }
  assert.match(invalid[0].parse.reason ?? '', /cannot parse/i);

  // The referee's error on an invalid attempt is exactly what the next turn
  // saw as feedback (this episode is solitaire, so the next frame is the next
  // agent attempt).
  /** @type {Map<number, typeof invalid[number]>} */
  const byIndex = new Map(payload.frames.map((f) => [f.index, f]));
  for (const frame of invalid) {
    const next = byIndex.get(frame.index + 1);
    if (next) assert.equal(next.feedback, frame.parse.reason);
  }
  // The first three turns parsed fine and saw no feedback; the first invalid
  // turn itself saw no feedback either (its predecessor was valid).
  for (const index of [0, 1, 2, 3]) {
    assert.equal(payload.frames[index].feedback, null);
  }

  // Efficiency tier: no score exists before the game ends, so frames carry none.
  assert.ok(payload.frames.every((f) => f.score === null));
});

test('feedback mirrors the runner exactly on every committed fixture', async () => {
  for (const [name, file] of Object.entries(FIXTURES)) {
    const trajectory = loadTrajectory(file);
    const payload = await buildFrames(getGame(trajectory.game.id), trajectory);
    // The runner keeps ONE feedback slot: set to an invalid agent reply's
    // reason, cleared by any valid step (either seat). Mirror that here.
    let expected = null;
    for (const frame of payload.frames) {
      assert.equal(
        frame.feedback,
        expected,
        `fixture ${name} frame ${frame.index} feedback`
      );
      const step = trajectory.steps[frame.index];
      if (step.invalid) {
        if (step.by === 'agent') expected = frame.parse.reason;
      } else {
        expected = null;
      }
    }
  }
});

test('refuses a tampered action and names the step', async () => {
  const trajectory = loadTrajectory(FIXTURES.tictactoe);
  trajectory.steps[1].action = 'zz9';
  await assert.rejects(
    buildFrames(getGame('tictactoe'), trajectory),
    (/** @type {*} */ err) =>
      err instanceof ReplayRefusedError &&
      err.step === 1 &&
      /step 1/.test(err.message)
  );
});

test('refuses a tampered observation hash at that step', async () => {
  const trajectory = loadTrajectory(FIXTURES.tictactoe);
  trajectory.steps[2].observationHash = '0'.repeat(16);
  await assert.rejects(
    buildFrames(getGame('tictactoe'), trajectory),
    (/** @type {*} */ err) =>
      err instanceof ReplayRefusedError && err.step === 2 && /hash mismatch/.test(err.message)
  );
});

test('refuses an older-version trajectory before replaying', async () => {
  // Doctored in memory rather than read from a stale recording: an episode
  // recorded at 1.0.0 must be refused before any replay, naming the recorded
  // version, the current one, and the pre-replay step (-1).
  const trajectory = loadTrajectory(FIXTURES.tictactoe);
  trajectory.game.version = '1.0.0';
  await assert.rejects(
    buildFrames(getGame('tictactoe'), trajectory),
    (/** @type {*} */ err) =>
      err instanceof ReplayRefusedError &&
      err.step === -1 &&
      /1\.0\.0/.test(err.message) &&
      /1\.2\.0/.test(err.message)
  );
});
