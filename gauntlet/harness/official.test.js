/**
 * Tests for the official-track prompt and turn message layout. Offline.
 *
 * @module
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  OFFICIAL_SYSTEM_PROMPT,
  NO_PREVIOUS_REPLY,
  buildOfficialTurnMessage,
} from './official.js';

/** @import { TurnContext } from '../core/types.js' */

const VERBATIM_SYSTEM_PROMPT =
  'You are playing a game. Your goal is to win. Reply with the exact action ' +
  'you want to take. The final action in your reply will be executed next ' +
  'turn. Your entire reply will be carried to the next turn.';

const RULES = 'RULES TEXT: place marks on a grid.';

/**
 * @param {{ observationText?: string, feedback?: string | null, turn?: number }} overrides
 * @returns {TurnContext}
 */
function fakeCtx(overrides = {}) {
  return /** @type {TurnContext} */ ({
    spec: { rulesText: RULES },
    tier: { id: 'tier-1' },
    seat: 0,
    turn: overrides.turn ?? 0,
    observation: { text: overrides.observationText ?? 'OBSERVATION BOARD', data: {} },
    legalActions: null,
    feedback: overrides.feedback !== undefined ? overrides.feedback : null,
  });
}

test('OFFICIAL_SYSTEM_PROMPT is the ARC-AGI-3 official prompt, verbatim', () => {
  assert.equal(OFFICIAL_SYSTEM_PROMPT, VERBATIM_SYSTEM_PROMPT);
});

test('first turn: rules text, "(none)" previous reply, current state — nothing else', () => {
  const message = buildOfficialTurnMessage(fakeCtx(), null);
  assert.equal(
    message,
    [
      RULES,
      `Your previous reply:\n${NO_PREVIOUS_REPLY}`,
      `Current state:\nOBSERVATION BOARD`,
    ].join('\n\n')
  );
});

test('undefined previous reply is treated like null', () => {
  const message = buildOfficialTurnMessage(fakeCtx(), undefined);
  assert.ok(message.includes(`Your previous reply:\n${NO_PREVIOUS_REPLY}`));
});

test('the previous reply is carried in full, verbatim, including whitespace and newlines', () => {
  const previous = 'I will place my mark in the center.\n\naction: b2';
  const message = buildOfficialTurnMessage(fakeCtx({ turn: 1 }), previous);
  assert.ok(message.includes(`Your previous reply:\n${previous}`));
  assert.ok(message.startsWith(RULES));
  assert.ok(message.endsWith('Current state:\nOBSERVATION BOARD'));
});

test('invalid-attempt feedback appears between the previous reply and the state', () => {
  const message = buildOfficialTurnMessage(
    fakeCtx({ feedback: 'cell a1 is occupied', turn: 2 }),
    'a1'
  );
  const previousIndex = message.indexOf('Your previous reply:');
  const feedbackIndex = message.indexOf('Feedback on your previous reply: cell a1 is occupied');
  const stateIndex = message.indexOf('Current state:');
  assert.ok(previousIndex >= 0);
  assert.ok(feedbackIndex > previousIndex);
  assert.ok(stateIndex > feedbackIndex);
});

test('a winning reply (feedback cleared) sends no feedback section', () => {
  const message = buildOfficialTurnMessage(fakeCtx({ turn: 3 }), 'c3');
  assert.ok(!message.includes('Feedback'));
});

test('an empty previous reply counts as no previous reply', () => {
  const message = buildOfficialTurnMessage(fakeCtx(), '   ');
  assert.ok(message.includes(`Your previous reply:\n${NO_PREVIOUS_REPLY}`));
});

test('malformed turn contexts fail loudly', () => {
  assert.throws(() =>
    buildOfficialTurnMessage(
      /** @type {*} */ ({ spec: {}, observation: { text: 'x' }, feedback: null }),
      null
    )
  );
  assert.throws(() =>
    buildOfficialTurnMessage(
      /** @type {*} */ ({ spec: { rulesText: RULES }, observation: {}, feedback: null }),
      null
    )
  );
});
