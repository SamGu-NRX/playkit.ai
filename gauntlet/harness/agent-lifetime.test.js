/**
 * Unit: agent lifetime. The run engine builds one agent per episode, and the
 * model agent's per-instance state — the previous-reply carry — must live on
 * the instance: two parses of the same model spec hand out distinct agents,
 * and a fresh agent starts with no previous reply even after a sibling agent
 * has replied. A module-level or shared-closure carry would make episode N+1
 * open with episode N's last words.
 *
 * Local stub server on 127.0.0.1 only; no paid calls.
 *
 * @module
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAgentSpec } from '../cli/agents.js';
import { createModelAgent } from './model-agent.js';
import { NO_PREVIOUS_REPLY, OFFICIAL_SYSTEM_PROMPT } from './official.js';
import { startStubServer, sendJson } from './stub-server.js';

const CTX = /** @type {import('../core/types.js').TurnContext} */ ({
  spec: { rulesText: 'Choose: take, pass.' },
  tier: { id: 'main' },
  seat: 0,
  turn: 0,
  observation: { text: 'Choose: take, pass.', data: {} },
  legalActions: ['pass', 'take'],
  feedback: null,
});

const REPLY = 'REPLY-A';
const STUB_USAGE = { prompt_tokens: 10, completion_tokens: 5 };

test('two createForEpisode calls on one parsed model spec return distinct agents', async () => {
  // A dummy base URL: this spec is only parsed, never called.
  const spec = await parseAgentSpec('model:openai-chat/lifetime-model', {
    baseUrl: 'http://127.0.0.1:1',
  });
  const a = await spec.createForEpisode(
    /** @type {import('../cli/agents.js').AgentSpecContext} */ (/** @type {unknown} */ ({}))
  );
  const b = await spec.createForEpisode(
    /** @type {import('../cli/agents.js').AgentSpecContext} */ (/** @type {unknown} */ ({}))
  );
  assert.notEqual(a, b, 'each episode gets its own agent instance');
  assert.equal(a.id, 'model:openai-chat/lifetime-model');
  assert.equal(b.id, 'model:openai-chat/lifetime-model');
});

test('a fresh model agent starts with no previous reply, even after a sibling replied', async (t) => {
  /** @type {string[]} */
  const bodies = [];
  const stub = await startStubServer(
    /** @param {import('node:http').IncomingMessage} req @param {import('node:http').ServerResponse} res @param {*} body */
    (req, res, body) => {
      bodies.push(JSON.stringify(body));
      sendJson(res, 200, {
        id: 'chatcmpl-stub',
        object: 'chat.completion',
        created: 1,
        model: 'lifetime-model',
        choices: [
          { index: 0, message: { role: 'assistant', content: REPLY }, finish_reason: 'stop' },
        ],
        usage: { ...STUB_USAGE },
      });
    }
  );
  t.after(() => stub.close());

  const makeAgent = () =>
    createModelAgent({
      provider: 'openai-chat',
      model: 'lifetime-model',
      baseUrl: stub.url,
    });

  const agentA = makeAgent();
  const agentB = makeAgent();
  assert.notEqual(agentA, agentB, 'separately created agents are distinct instances');

  await agentA.act(CTX);
  await agentB.act(CTX);
  await agentA.act(CTX);
  assert.equal(bodies.length, 3);

  const userText = (/** @type {number} */ i) => {
    const parsed = JSON.parse(bodies[i]);
    assert.equal(parsed.model, 'lifetime-model');
    assert.equal(parsed.messages[0].content, OFFICIAL_SYSTEM_PROMPT, 'the official system prompt leads every request');
    assert.equal(parsed.messages.length, 2);
    return /** @type {string} */ (parsed.messages[1].content);
  };

  // Agent A, turn 1: no previous reply — the official "(none)" marker.
  assert.ok(userText(0).includes(NO_PREVIOUS_REPLY), 'the official no-previous-reply marker leads agent A\'s first request');
  // Agent B, turn 1: also no previous reply. Agent A's reply must not leak.
  const bFirst = userText(1);
  assert.ok(bFirst.includes(NO_PREVIOUS_REPLY), 'agent B\'s first request also starts from the no-previous-reply marker');
  assert.doesNotMatch(bFirst, new RegExp(REPLY), "agent B's first request does not carry agent A's reply");
  // Agent A, turn 2: carries its own previous reply.
  assert.match(userText(2), new RegExp(REPLY), "agent A's second request carries its own first reply");
});
