/**
 * Unit tests for the human terminal agent (agents/human.js): the rendered
 * rules/observation/legal-list flow on the output stream, the input grammar
 * (number, action text, help, quit), re-prompts that never consume an action,
 * the forfeit path on quit and EOF, and the verbatim-forwarding rule that
 * leaves legality to the referee.
 *
 * @module
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { createHumanAgent } from './human.js';

/** @import { TurnContext } from '../core/types.js' */

/**
 * @param {{ turn?: number, legalActions?: string[] | null, feedback?: string | null, text?: string, seat?: number }} [overrides]
 * @returns {TurnContext}
 */
function makeCtx(overrides = {}) {
  return {
    spec: {
      id: 'tictactoe',
      version: '1.2.0',
      title: 'Tic-Tac-Toe',
      seats: 2,
      information: 'perfect',
      stochastic: false,
      tags: [],
      benchmark: false,
      requires: [],
      rulesText: 'Standard 3x3 tic-tac-toe. Action grammar: <column><row>, e.g. a1.',
      tiers: [],
    },
    tier: { id: 'random-opponent', rank: 1, scoring: 'outcome', maxActions: 20, publicSeeds: 16, params: {} },
    seat: overrides.seat ?? 0,
    turn: overrides.turn ?? 0,
    observation: { text: overrides.text ?? 'board', data: null },
    legalActions: overrides.legalActions !== undefined ? overrides.legalActions : ['a1', 'a2', 'a3', 'b1'],
    feedback: overrides.feedback ?? null,
  };
}

/**
 * A fresh agent with piped input and captured output.
 *
 * @returns {{ agent: ReturnType<typeof createHumanAgent>, input: PassThrough, output: PassThrough, out: () => string }}
 */
function makeAgent(options = {}) {
  const input = new PassThrough();
  const output = new PassThrough();
  /** @type {string[]} */
  const chunks = [];
  output.on('data', (chunk) => chunks.push(String(chunk)));
  const agent = createHumanAgent({ input, output, ...options });
  return { agent, input, output, out: () => chunks.join('') };
}

/**
 * Feed lines and end the input stream (EOF after them).
 *
 * @param {PassThrough} input
 * @param {string[]} lines
 * @returns {void}
 */
function script(input, lines) {
  for (const line of lines) input.write(`${line}\n`);
  input.end();
}

test('rules are printed once; the observation every turn', async () => {
  const { agent, input, out } = makeAgent();
  script(input, ['1', '2']);
  await agent.act(makeCtx({ turn: 0 }));
  const afterFirst = out();
  assert.match(afterFirst, /human at the terminal/);
  assert.match(afterFirst, /Standard 3x3 tic-tac-toe/);
  assert.match(afterFirst, /tier random-opponent/);
  await agent.act(makeCtx({ turn: 1 }));
  const afterSecond = out();
  // The rules block appears exactly once, the turn header twice.
  assert.equal(afterSecond.split('human at the terminal').length - 1, 1);
  assert.match(afterSecond, /--- turn 2 \(seat 0\) ---/);
});

test('legal actions are numbered and a number input plays that action', async () => {
  const { agent, input, out } = makeAgent();
  script(input, ['3']);
  const reply = await agent.act(makeCtx({}));
  assert.equal(reply.text, 'a3');
  assert.match(out(), /legal actions \(4\):\n {2}1\) a1\n {2}2\) a2\n {2}3\) a3\n {2}4\) b1/);
});

test('out-of-range and non-listed numbers re-prompt without consuming the turn', async () => {
  const { agent, input, out } = makeAgent();
  script(input, ['9', '0', '2']);
  const reply = await agent.act(makeCtx({}));
  assert.equal(reply.text, 'a2', 'the third buffered line produced the only reply');
  assert.match(out(), /\(no legal action number 9 — pick 1 to 4\)/);
  // Exactly one turn block was rendered: the re-prompts happened inside one
  // runner turn, so the observation is printed once.
  assert.equal(out().split('--- turn 1').length - 1, 1);
});

test('an empty line re-prompts and never reaches the referee', async () => {
  const { agent, input } = makeAgent();
  script(input, ['', '', '1']);
  const reply = await agent.act(makeCtx({}));
  assert.equal(reply.text, 'a1');
});

test('help re-prompts and prints the input grammar', async () => {
  const { agent, input, out } = makeAgent();
  script(input, ['help', '1']);
  const reply = await agent.act(makeCtx({}));
  assert.equal(reply.text, 'a1');
  assert.match(out(), /<number>\s+play the numbered legal action/);
});

test('action text is forwarded verbatim and never pre-validated', async () => {
  const { agent, input } = makeAgent();
  script(input, ['play a2']);
  const reply = await agent.act(makeCtx({}));
  assert.equal(reply.text, 'play a2');
});

test('an action not in the legal list is still forwarded — the referee decides', async () => {
  const { agent, input } = makeAgent();
  script(input, ['zzz']);
  const reply = await agent.act(makeCtx({}));
  assert.equal(reply.text, 'zzz', 'illegal text must take the normal invalid path');
});

test('the previous invalid attempt\u2019s feedback is shown', async () => {
  const { agent, input, out } = makeAgent();
  script(input, ['1']);
  await agent.act(makeCtx({ feedback: 'illegal action "x9"' }));
  assert.match(out(), /Your last action was rejected: illegal action "x9"/);
});

test('quit returns the forfeit reply and stops prompting', async () => {
  const { agent, input, output, out } = makeAgent();
  script(input, ['quit']);
  const first = await agent.act(makeCtx({ turn: 0 }));
  assert.equal(first.text, '');
  assert.deepEqual(first.meta, { human: { quit: true } });
  assert.match(out(), /quitting/);
  const bytesBefore = out().length;
  const second = await agent.act(makeCtx({ turn: 1 }));
  assert.deepEqual(second.meta, { human: { quit: true } });
  assert.equal(out().length, bytesBefore, 'no further prompting after quitting');
  output.end();
  input.end();
});

test('EOF on stdin forfeits', async () => {
  const { agent, input } = makeAgent();
  input.end();
  const reply = await agent.act(makeCtx({}));
  assert.equal(reply.text, '');
  assert.deepEqual(reply.meta, { human: { quit: true } });
});

test('agent id and name: human, human:<name>', async () => {
  const plain = makeAgent();
  assert.equal(plain.agent.id, 'human');
  const named = makeAgent({ name: 'alice' });
  assert.equal(named.agent.id, 'human:alice');
  named.input.end();
});

test('legal lists above maxNumbered are summarized, not numbered; text still works', async () => {
  const many = Array.from({ length: 70 }, (_, i) => `move${i + 1}`);
  const { agent, input, out } = makeAgent({ maxNumbered: 64 });
  script(input, ['move7']);
  const reply = await agent.act(makeCtx({ legalActions: many }));
  assert.equal(reply.text, 'move7');
  assert.match(out(), /legal actions: 70 \(too many to list/);
  assert.doesNotMatch(out(), / 1\) move1/);
});

test('a number input without a listed legal list re-prompts', async () => {
  // An official-track-style context (legalActions null) cannot map numbers;
  // the agent must say so and keep waiting for action text.
  const { agent, input, out } = makeAgent();
  script(input, ['1', 'up']);
  const reply = await agent.act(makeCtx({ legalActions: null }));
  assert.equal(reply.text, 'up');
  assert.match(out(), /\(no legal action number 1\)/);
});
