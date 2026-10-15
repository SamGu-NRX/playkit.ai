/**
 * Wire protocol tests: every test drives the real server over real pipes by
 * spawning `node protocol/server.js` and speaking JSON Lines on stdin/stdout.
 * No in-process shortcuts, no network, no paid APIs.
 *
 * @module
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { nextInt, rngFromSeed } from '../core/rng.js';
import { tictactoe } from '../games/tictactoe/index.js';
import { verifyTrajectory } from '../core/trajectory.js';

const SERVER_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'server.js');
const GAUNTLET_ROOT = path.resolve(path.dirname(SERVER_PATH), '..');

/**
 * A running protocol server. `request` sends one JSON line and resolves to
 * the next response line — the protocol is strictly sequential.
 */
class ServerHandle {
  constructor() {
    /** @type {string[]} */
    this.stderr = [];
    /** @type {Record<string, *>[]} */
    this.responses = [];
    /** @type {((response: Record<string, *>) => void)[]} */
    this.waiters = [];
    this.buffer = '';
    this.proc = /** @type {import('node:child_process').ChildProcessWithoutNullStreams} */ (
      spawn(process.execPath, [SERVER_PATH], {
        cwd: GAUNTLET_ROOT,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    );
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (/** @type {string} */ chunk) => {
      this.buffer += chunk;
      for (;;) {
        const newline = this.buffer.indexOf('\n');
        if (newline < 0) break;
        const line = this.buffer.slice(0, newline).trim();
        this.buffer = this.buffer.slice(newline + 1);
        if (line.length === 0) continue;
        this.deliver(JSON.parse(line));
      }
    });
    this.proc.stderr.setEncoding('utf8');
    this.proc.stderr.on('data', (/** @type {string} */ chunk) => this.stderr.push(chunk));
  }

  /**
   * @param {Record<string, *>} response
   * @returns {void}
   */
  deliver(response) {
    if (this.waiters.length > 0) {
      const waiter = /** @type {(response: Record<string, *>) => void} */ (this.waiters.shift());
      waiter(response);
    } else {
      this.responses.push(response);
    }
  }

  /** @returns {Promise<Record<string, *>>} */
  next() {
    if (this.responses.length > 0) {
      return Promise.resolve(/** @type {Record<string, *>} */ (this.responses.shift()));
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`timed out waiting for a response; stderr: ${this.stderr.join('')}`));
      }, 10_000);
      this.waiters.push((response) => {
        clearTimeout(timer);
        resolve(response);
      });
    });
  }

  /**
   * @param {Record<string, *>} request
   * @returns {void}
   */
  send(request) {
    this.proc.stdin.write(`${JSON.stringify(request)}\n`);
  }

  /**
   * @param {string} line
   * @returns {void}
   */
  sendRaw(line) {
    this.proc.stdin.write(`${line}\n`);
  }

  /**
   * @param {Record<string, *>} request
   * @returns {Promise<Record<string, *>>}
   */
  async request(request) {
    this.send(request);
    return this.next();
  }

  /** @returns {Promise<number>} exit code */
  async stop() {
    if (this.proc.exitCode === null && this.proc.exitCode !== 0) {
      this.proc.stdin.end();
      const [code] = await once(this.proc, 'exit');
      return /** @type {number} */ (code);
    }
    return this.proc.exitCode ?? -1;
  }

  /**
   * Wait for the process to exit on its own, failing after `deadlineMs`.
   *
   * @param {number} deadlineMs
   * @returns {Promise<number>} exit code
   */
  waitForExit(deadlineMs) {
    if (this.proc.exitCode !== null) return Promise.resolve(this.proc.exitCode);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.proc.removeListener('exit', onExit);
        reject(
          new Error(
            `the server did not exit within ${deadlineMs} ms; stdin was left open, ` +
              `stderr: ${this.stderr.join('')}`
          )
        );
      }, deadlineMs);
      const onExit = /** @type {(code: number) => void} */ ((code) => {
        clearTimeout(timer);
        resolve(code);
      });
      this.proc.once('exit', onExit);
    });
  }
}

/**
 * The seed alternates the agent's seat, so exercise both sides across tests.
 * @type {Record<string, string>}
 */
const SEEDS = {
  zero: 'tictactoe/perfect-opponent/public/0',
  one: 'tictactoe/perfect-opponent/public/1',
  two: 'tictactoe/perfect-opponent/public/2',
  three: 'tictactoe/perfect-opponent/public/3',
};

/**
 * Pull the legal actions out of an official-track observation's rules text.
 *
 * @param {string} text
 * @returns {string[]}
 */
function legalFromObservationText(text) {
  const match = /Legal actions \(\d+[^)]*\): (.+)$/.exec(text);
  assert.ok(match, `observation text does not list legal actions:\n${text}`);
  return match[1].split(', ').map((action) => action.trim());
}

/**
 * Play a full episode against the running server.
 *
 * @param {ServerHandle} server
 * @param {Record<string, *>} resetRequest
 * @param {(turn: Record<string, *>, ply: number) => string} choose
 * @returns {Promise<{ done: Record<string, *>, plies: number }>}
 */
async function playEpisode(server, resetRequest, choose) {
  let response = await server.request({ id: 1, op: 'reset', ...resetRequest });
  let ply = 0;
  while (!response.done) {
    assert.ok(response.turn, `expected a turn response, got ${JSON.stringify(response)}`);
    const action = choose(response.turn, ply);
    response = await server.request({ id: 10 + ply, op: 'act', text: action });
    ply++;
    assert.ok(ply < 100, 'the episode did not finish within 100 agent actions');
  }
  return { done: response, plies: ply };
}

test('list advertises registered games over the wire', async () => {
  const server = new ServerHandle();
  try {
    const response = await server.request({ id: 'a', op: 'list' });
    assert.equal(response.id, 'a');
    assert.equal(response.ok, true);
    const game = response.games.find((/** @type {any} */ g) => g.id === 'tictactoe');
    assert.ok(game, 'tictactoe must be listed');
    assert.deepEqual(
      game.tiers.map((/** @type {any} */ t) => t.id),
      ['perfect-opponent']
    );
    assert.equal(game.tiers[0].maxActions, 20);
  } finally {
    await server.stop();
  }
});

test('a full baseline episode over real pipes verifies by replay', async () => {
  const server = new ServerHandle();
  try {
    const { done, plies } = await playEpisode(
      server,
      {
        game: 'tictactoe',
        tier: 'perfect-opponent',
        seed: SEEDS.zero,
        agentId: 'test-baseline',
        track: 'baseline',
      },
      (turn, ply) => {
        const legal = /** @type {string[]} */ (turn.legalActions);
        assert.ok(Array.isArray(legal) && legal.length > 0, 'baseline turns must list legal actions');
        const pick = nextInt(rngFromSeed(`protocol-test/${ply}`), 0, legal.length - 1).value;
        return legal[pick];
      }
    );
    assert.equal(done.ok, true);
    assert.ok(
      ['terminal', 'budget-exhausted', 'forfeit-invalid'].includes(done.end.reason),
      `unexpected end reason ${done.end.reason}`
    );
    assert.ok(done.end.outcome, 'done responses carry the outcome');
    assert.equal(done.end.agentActions, plies);

    const trajectoryResponse = await server.request({ id: 999, op: 'trajectory' });
    assert.equal(trajectoryResponse.ok, true);
    const trajectory = trajectoryResponse.trajectory;
    assert.equal(trajectory.format, 'playkit-gauntlet-trajectory/1');
    assert.equal(trajectory.game.id, 'tictactoe');
    assert.equal(trajectory.tier, 'perfect-opponent');
    assert.equal(trajectory.seed, SEEDS.zero);
    assert.equal(trajectory.end.agentActions, plies);
    const verdict = await verifyTrajectory(tictactoe, trajectory);
    assert.deepEqual(verdict, { ok: true });

    // After done, act is an error until the next reset.
    const lateAct = await server.request({ id: 1000, op: 'act', text: 'a1' });
    assert.equal(lateAct.ok, false);
    assert.match(lateAct.error, /episode is over/);
  } finally {
    await server.stop();
  }
});

test('an official-track reset hides legalActions and still verifies by replay', async () => {
  const server = new ServerHandle();
  try {
    const { done, plies } = await playEpisode(
      server,
      {
        game: 'tictactoe',
        tier: 'perfect-opponent',
        seed: SEEDS.one,
        agentId: 'test-official',
        track: 'official',
      },
      (turn, ply) => {
        assert.equal(turn.legalActions, null, 'official-track turns must hide legalActions');
        assert.equal(turn.feedback, null, 'no feedback before any invalid attempt');
        const legal = legalFromObservationText(turn.observation.text);
        const pick = nextInt(rngFromSeed(`official-test/${ply}`), 0, legal.length - 1).value;
        return legal[pick];
      }
    );
    assert.equal(done.ok, true);
    assert.equal(done.end.agentActions, plies);
    const trajectoryResponse = await server.request({ id: 999, op: 'trajectory' });
    const verdict = await verifyTrajectory(tictactoe, trajectoryResponse.trajectory);
    assert.deepEqual(verdict, { ok: true });
    // The recorded agent must be on the official track.
    assert.equal(trajectoryResponse.trajectory.agent.track, 'official');
  } finally {
    await server.stop();
  }
});

test('invalid attempts come back as feedback and forfeit after three consecutive', async () => {
  const server = new ServerHandle();
  try {
    const reset = await server.request({
      id: 1,
      op: 'reset',
      game: 'tictactoe',
      tier: 'perfect-opponent',
      seed: SEEDS.two,
      agentId: 'test-forfeit',
      track: 'baseline',
    });
    assert.ok(reset.turn, 'expected the first turn from reset');

    const first = await server.request({ id: 2, op: 'act', text: 'zz9' });
    assert.ok(first.turn, 'an invalid attempt re-presents the turn');
    assert.ok(first.turn.feedback, 'the turn carries the invalid-attempt feedback');
    assert.match(first.turn.feedback, /zz9|cannot parse/);

    const second = await server.request({ id: 3, op: 'act', text: 'zz9' });
    assert.ok(second.turn && second.turn.feedback);

    const third = await server.request({ id: 4, op: 'act', text: 'zz9' });
    assert.ok(third.done, 'three consecutive invalid attempts forfeit the episode');
    assert.equal(third.end.reason, 'forfeit-invalid');
    assert.equal(third.end.invalidActions, 3);

    const trajectoryResponse = await server.request({ id: 999, op: 'trajectory' });
    const trajectory = trajectoryResponse.trajectory;
    assert.equal(trajectory.end.reason, 'forfeit-invalid');
    assert.equal(trajectory.end.invalidActions, 3);
    assert.ok(trajectory.steps.every((/** @type {any} */ step) => step.invalid));
    const verdict = await verifyTrajectory(tictactoe, trajectory);
    assert.deepEqual(verdict, { ok: true });
  } finally {
    await server.stop();
  }
});

test('one episode per reset: reset while playing is an error, reset after done starts a new episode', async () => {
  const server = new ServerHandle();
  try {
    await server.request({
      id: 1,
      op: 'reset',
      game: 'tictactoe',
      tier: 'perfect-opponent',
      seed: SEEDS.three,
      agentId: 'test-reset',
      track: 'baseline',
    });
    const midEpisode = await server.request({
      id: 2,
      op: 'reset',
      game: 'tictactoe',
      tier: 'perfect-opponent',
      seed: SEEDS.three,
      agentId: 'test-reset',
      track: 'baseline',
    });
    assert.equal(midEpisode.ok, false);
    assert.match(midEpisode.error, /already in progress/);

    // Forfeit out quickly to reach done.
    let response = await server.request({ id: 3, op: 'act', text: 'nope' });
    for (let i = 0; i < 2 && !response.done; i++) {
      response = await server.request({ id: 4 + i, op: 'act', text: 'nope' });
    }
    assert.ok(response.done, 'the first episode finished');

    const next = await server.request({
      id: 10,
      op: 'reset',
      game: 'tictactoe',
      tier: 'perfect-opponent',
      seed: SEEDS.three,
      agentId: 'test-reset',
      track: 'baseline',
    });
    assert.ok(next.turn, 'the second reset starts a fresh episode');
    const close = await server.request({ id: 11, op: 'close' });
    assert.equal(close.ok, true);
  } finally {
    await server.stop();
  }
});

test('error cases are responses, never crashes', async () => {
  const server = new ServerHandle();
  try {
    // act before reset
    const earlyAct = await server.request({ id: 1, op: 'act', text: 'a1' });
    assert.equal(earlyAct.ok, false);
    assert.match(earlyAct.error, /no episode is active/);

    // trajectory before any episode
    const earlyTrajectory = await server.request({ id: 2, op: 'trajectory' });
    assert.equal(earlyTrajectory.ok, false);
    assert.match(earlyTrajectory.error, /no episode has been played/);

    // unknown game
    const unknownGame = await server.request({ id: 3, op: 'reset', game: 'not-a-game' });
    assert.equal(unknownGame.ok, false);
    assert.match(unknownGame.error, /unknown game/);

    // missing game
    const missingGame = await server.request({ id: 4, op: 'reset' });
    assert.equal(missingGame.ok, false);
    assert.match(missingGame.error, /requires a "game"/);

    // unknown tier
    const unknownTier = await server.request({
      id: 5,
      op: 'reset',
      game: 'tictactoe',
      tier: 'impossible-tier',
    });
    assert.equal(unknownTier.ok, false);
    assert.match(unknownTier.error, /no tier/);

    // bad split and bad track
    const badSplit = await server.request({ id: 6, op: 'reset', game: 'tictactoe', split: 'secret' });
    assert.equal(badSplit.ok, false);
    assert.match(badSplit.error, /split/);
    const badTrack = await server.request({ id: 7, op: 'reset', game: 'tictactoe', track: 'royal' });
    assert.equal(badTrack.ok, false);
    assert.match(badTrack.error, /track/);

    // unknown op and missing op
    const unknownOp = await server.request({ id: 8, op: 'fly' });
    assert.equal(unknownOp.ok, false);
    assert.match(unknownOp.error, /unknown op/);
    const missingOp = await server.request({ id: 9 });
    assert.equal(missingOp.ok, false);
    assert.match(missingOp.error, /"op"/);

    // non-object request
    const arrayRequest = await server.request([1, 2, 3]);
    assert.equal(arrayRequest.ok, false);

    // malformed JSON line: answered with id null, server keeps serving
    server.sendRaw('this is not json {');
    const malformed = await server.next();
    assert.equal(malformed.id, null);
    assert.equal(malformed.ok, false);
    assert.match(malformed.error, /JSON/);

    // act with a missing text field mid-episode
    await server.request({
      id: 20,
      op: 'reset',
      game: 'tictactoe',
      tier: 'perfect-opponent',
      seed: SEEDS.zero,
      agentId: 'test-errors',
      track: 'baseline',
    });
    const badAct = await server.request({ id: 21, op: 'act' });
    assert.equal(badAct.ok, false);
    assert.match(badAct.error, /"text"/);
    // the episode is still playable afterwards
    const goodAct = await server.request({ id: 22, op: 'act', text: 'b2' });
    assert.ok(goodAct.turn || goodAct.done, 'the episode survived the rejected act');
  } finally {
    await server.stop();
  }
});

test('close exits the server cleanly', async () => {
  const server = new ServerHandle();
  const close = await server.request({ id: 1, op: 'close' });
  assert.equal(close.ok, true);
  const code = await server.stop();
  assert.equal(code, 0);
});

test('close exits the process while stdin stays open (README contract)', async () => {
  const server = new ServerHandle();
  try {
    const close = await server.request({ id: 1, op: 'close' });
    assert.equal(close.ok, true);
    // Deliberately leave stdin open: the documented contract is that close
    // ends the server, so the process must exit on its own.
    const code = await server.waitForExit(5_000);
    assert.equal(code, 0);
  } finally {
    server.proc.kill();
  }
});

