import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildFrames, ReplayRefusedError } from './frames.js';
import { getGame } from '../games/index.js';

const here = dirname(fileURLToPath(import.meta.url));

/** @type {Record<string, string>} */
const FIXTURES = {
  // Two-player, terminal: Qwen2.5-1.5B loses to the perfect minimax opponent.
  tictactoe: join(
    here,
    '../studies/model-separation/runs/qwen2.5-1.5b/tictactoe/perfect-opponent/tictactoe/perfect-opponent/public/0.json'
  ),
  // Solitaire, forfeit-invalid: Qwen2.5-1.5B guesses "ABEI" three times in a row.
  mastermind: join(
    here,
    '../studies/model-separation/runs/qwen2.5-1.5b/mastermind/classic/mastermind/classic/public/0.json'
  ),
  // Solitaire, forfeit-invalid on the first three attempts (Qwen2.5-0.5B).
  mastermind05: join(
    here,
    '../studies/model-separation/runs/qwen2.5-0.5b/mastermind/classic/mastermind/classic/public/0.json'
  ),
  // Two-player against the deterministic wood engine, forfeit-invalid mid-game.
  chess: join(
    here,
    '../reports/first-model-run/run-qwen/chess/wood/chess/wood/public/0.json'
  ),
  // A real refusal case: committed before tictactoe moved to v1.1.0, so the
  // version guard must refuse it before any replay.
  staleTictactoe: join(
    here,
    '../reports/first-model-run/run-qwen/tictactoe/perfect-opponent/tictactoe/perfect-opponent/public/0.json'
  ),
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

  // Both seats acted three times each: the agent and minimax-perfect alternate.
  assert.deepEqual([...seen.keys()].sort(), [0, 1]);
  assert.equal(seen.get(0), 3);
  assert.equal(seen.get(1), 3);
  assert.equal(payload.frames[0].actorId, trajectory.agent.id);
  const opponentFrame = payload.frames.find((f) => f.by === 'opponent');
  if (!opponentFrame) throw new Error('the episode has opponent frames');
  assert.equal(opponentFrame.actorId, 'minimax-perfect');

  // Usage and latency ride along where the trajectory recorded them.
  assert.deepEqual(payload.frames[0].usage, {
    inputTokens: 326,
    outputTokens: 3,
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
    if (name === 'staleTictactoe') continue; // refused before any frame exists
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
  const trajectory = loadTrajectory(FIXTURES.chess);
  trajectory.steps[1].action = 'zz9';
  await assert.rejects(
    buildFrames(getGame('chess'), trajectory),
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

test('refuses the stale committed v1.0.0 episode before replaying', async () => {
  // reports/first-model-run recorded tictactoe at v1.0.0; the game is v1.1.0.
  // The refusal names the pre-replay step (-1) and the version mismatch.
  const trajectory = loadTrajectory(FIXTURES.staleTictactoe);
  await assert.rejects(
    buildFrames(getGame('tictactoe'), trajectory),
    (/** @type {*} */ err) =>
      err instanceof ReplayRefusedError &&
      err.step === -1 &&
      /1\.0\.0/.test(err.message) &&
      /1\.1\.0/.test(err.message)
  );
});
