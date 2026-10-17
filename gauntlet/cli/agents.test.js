import { BASELINE_FACTORIES, parseAgentSpec } from './agents.js';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { getGame } from '../games/index.js';

// One run is one entry: a resolved baseline agent must carry the spec text as
// its id, never a game packet's tier-resolved id. Chess names its engine per
// tier (engine-paper, engine-wood, ...), so a multi-tier chess run would mix
// agent identities in one bundle and bundle verify's agent-identity rule —
// and the leaderboard's single-entry scoring — would refuse it.

test('baseline:chess:engine resolves every tier under the spec id', async () => {
  const spec = await parseAgentSpec('baseline:chess:engine');
  const game = getGame('chess');
  for (const tier of game.spec.tiers) {
    const agent = await spec.createForEpisode({
      game,
      tier,
      seed: 'chess/public/0',
      agentSeat: 0,
    });
    assert.equal(agent.id, 'baseline:chess:engine', `tier ${tier.id} kept its tier-flavored id`);
  }
});

test('other baseline kinds also resolve under the spec id', async () => {
  for (const text of ['baseline:chess:greedy', 'baseline:minesweeper:greedy', 'baseline:2048:engine']) {
    const spec = await parseAgentSpec(text);
    const gameId = text.split(':')[1];
    const game = getGame(gameId);
    const agent = await spec.createForEpisode({
      game,
      tier: game.spec.tiers[0],
      seed: 'seed',
      agentSeat: 0,
    });
    assert.equal(agent.id, text, `${text} kept a non-spec id`);
  }
});

// Games without an explicit entry in BASELINE_FACTORIES resolve through the
// standard packet shape: games/<id>/baselines.js exporting createGreedyAgent
// and createEngineAgent, each taking ({ episodeSeed }). New game packets
// (wordle, sudoku, go) ship that shape, so registering a game makes its
// baselines CLI-playable with no edit here.

test('games with no explicit entry resolve through the standard baselines.js shape', async () => {
  for (const text of ['baseline:cube:greedy', 'baseline:cube:engine', 'baseline:mastermind:engine', 'baseline:nonogram:greedy']) {
    const spec = await parseAgentSpec(text);
    const game = getGame(text.split(':')[1]);
    const agent = await spec.createForEpisode({
      game,
      tier: game.spec.tiers[0],
      seed: 'seed',
      agentSeat: 0,
    });
    assert.equal(agent.id, text, `${text} kept a non-spec id`);
  }
});

test('games that ship no baselines are refused naming why', async () => {
  await assert.rejects(
    () => parseAgentSpec('baseline:tictactoe:greedy'),
    /ships no baseline agents/
  );
});

test('othello keeps its explicit entry — the engine takes a node budget, not episodeSeed', async () => {
  // Othello is calibrated (#68) but not yet registered, so the factory is
  // exercised directly — no getGame.
  const tier = /** @type {import('../core/types.js').TierSpec} */ ({ id: 'ladder-1' });
  const greedy = await BASELINE_FACTORIES.othello('greedy', { tier, seed: 'othello/public/0', agentSeat: 0 });
  assert.equal(greedy.id, 'greedy');
  // The calibration ceiling (#68): the packet's 32,000-node negamax budget.
  const engine = await BASELINE_FACTORIES.othello('engine', { tier, seed: 'othello/public/0', agentSeat: 0 });
  assert.equal(engine.id, 'engine-n32000');
});

test('chess-endgames keeps its explicit entry — tier/seed/seat positional factories', async () => {
  const game = getGame('chess-endgames');
  const context = { game, tier: game.spec.tiers[0], seed: 'chess-endgames/public/0', agentSeat: 0 };
  const greedy = await BASELINE_FACTORIES['chess-endgames']('greedy', context);
  assert.equal(greedy.id, 'greedy');
  const engine = await BASELINE_FACTORIES['chess-endgames']('engine', context);
  assert.equal(engine.id, 'tablebase-engine');
});

// Reasoning effort: the accepted values widen to xhigh|max for every provider,
// and provider anthropic accepts the setting — the harness (model-agent.js)
// validates it against the model. These tests pin the parsed spec, not the
// wire format.

// claude-opus-4-8: a model whose capability-table row documents all five
// levels (the table refuses effort on claude-opus-4-5, which documents none).
test('reasoning-effort widens to xhigh and max as a spec suffix on anthropic', async () => {
  for (const value of ['low', 'medium', 'high', 'xhigh', 'max']) {
    const text = `model:anthropic/claude-opus-4-8:reasoning-effort=${value}`;
    const spec = await parseAgentSpec(text);
    assert.equal(spec.track, 'official');
    assert.equal(spec.dryRun, false);
    const agent = await spec.createForEpisode({ game: getGame('tictactoe'), tier: getGame('tictactoe').spec.tiers[0], seed: 'seed', agentSeat: 0 });
    assert.equal(agent.id, text, `suffix :reasoning-effort=${value} is part of the agent id`);
  }
});

test('reasoning-effort widens via --reasoning-effort too, and lands in the agent id', async () => {
  const spec = await parseAgentSpec('model:openai/gpt-5.2', { reasoningEffort: /** @type {'xhigh'} */ ('xhigh') });
  const agent = await spec.createForEpisode({ game: getGame('tictactoe'), tier: getGame('tictactoe').spec.tiers[0], seed: 'seed', agentSeat: 0 });
  assert.equal(agent.id, 'model:openai/gpt-5.2:reasoning-effort=xhigh');
});

test('a spec-suffix reasoning-effort conflicts with the flag only when the suffix is real', async () => {
  // xhigh parses as a settings suffix now, so the duplicate-setting guard
  // fires; before the widening it silently stayed part of the model id.
  await assert.rejects(
    () => parseAgentSpec('model:openai/gpt-5.2:reasoning-effort=xhigh', { reasoningEffort: 'high' }),
    /both in the spec suffix/
  );
});

test('reasoning-effort still refuses --dry-run', async () => {
  await assert.rejects(
    () => parseAgentSpec('model:openai/gpt-5.2', { dryRun: true, reasoningEffort: 'high' }),
    /cannot be combined with --dry-run/
  );
});

// Community-assisted specs: the community-track assisted harness
// (community/assisted-agent.js). Every case here is red before the packet:
// the spec form does not exist at the base commit.

// A real replies.json fixture: importScriptFile loads it eagerly at parse
// time, so the dry-run spec tests need an actual file on disk.
const repliesFile = join(mkdtempSync(join(tmpdir(), 'assisted-')), 'replies.json');
writeFileSync(repliesFile, JSON.stringify(['ACTION: up']));

test('community-assisted parses on the community track with the retries suffix in the id', async () => {
  const spec = await parseAgentSpec('community-assisted:openai-chat/stub-model:retries=1', {
    dryRun: true,
    script: repliesFile,
  });
  assert.equal(spec.track, 'community');
  assert.equal(spec.dryRun, true);
  const agent = await spec.createForEpisode({
    game: getGame('tictactoe'),
    tier: getGame('tictactoe').spec.tiers[0],
    seed: 's0',
    agentSeat: 0,
  });
  assert.equal(agent.track, 'community');
  assert.equal(agent.id, 'community-assisted:openai-chat/stub-model:retries=1');
});

test('community-assisted defaults to retries=2 in the agent id', async () => {
  const spec = await parseAgentSpec('community-assisted:openai-chat/stub-model', {
    dryRun: true,
    script: repliesFile,
  });
  const agent = await spec.createForEpisode({
    game: getGame('tictactoe'),
    tier: getGame('tictactoe').spec.tiers[0],
    seed: 's0',
    agentSeat: 0,
  });
  assert.equal(agent.id, 'community-assisted:openai-chat/stub-model:retries=2');
});

test('community-assisted keeps Ollama-style colon tags as part of the model id', async () => {
  const spec = await parseAgentSpec('community-assisted:openai-chat/qwen2.5:7b', {
    dryRun: true,
    script: repliesFile,
  });
  const agent = await spec.createForEpisode({
    game: getGame('tictactoe'),
    tier: getGame('tictactoe').spec.tiers[0],
    seed: 's0',
    agentSeat: 0,
  });
  assert.equal(agent.id, 'community-assisted:openai-chat/qwen2.5:7b:retries=2');
});

test('community-assisted openai-chat requires --base-url when live, like model specs', async () => {
  await assert.rejects(
    () => parseAgentSpec('community-assisted:openai-chat/stub-model'),
    /requires --base-url/
  );
});

test('community-assisted refuses thinking and effort settings', async () => {
  await assert.rejects(
    () =>
      parseAgentSpec('community-assisted:openai-chat/stub-model', {
        dryRun: true,
        script: repliesFile,
        reasoningEffort: 'high',
      }),
    /thinking-budget and reasoning-effort do not apply/
  );
  await assert.rejects(
    () =>
      parseAgentSpec('community-assisted:anthropic/claude-opus-4-5', {
        dryRun: true,
        script: repliesFile,
        thinkingBudget: 1024,
      }),
    /thinking-budget and reasoning-effort do not apply/
  );
});

test('a live community-assisted spec builds a community-track wrapper around a model agent', async () => {
  const spec = await parseAgentSpec('community-assisted:openai-chat/stub-model:retries=3', {
    baseUrl: 'http://127.0.0.1:9',
  });
  assert.equal(spec.track, 'community');
  assert.equal(spec.dryRun, false);
  const agent = await spec.createForEpisode({
    game: getGame('tictactoe'),
    tier: getGame('tictactoe').spec.tiers[0],
    seed: 's0',
    agentSeat: 0,
  });
  assert.equal(agent.track, 'community');
  assert.equal(agent.id, 'community-assisted:openai-chat/stub-model:retries=3');
  assert.equal(agent.provider, 'openai-chat');
  assert.equal(agent.model, 'stub-model');
});

// The human spec seats a person at the terminal: community track (human
// baselines stay out of the official table, and the agent renders the legal
// actions a non-official track provides), id `human` or `human:<name>`, and
// no provider machinery — any model flag is refused at parse time.
test('the human spec resolves a community-track per-episode factory', async () => {
  for (const text of ['human', 'human:sam']) {
    const spec = await parseAgentSpec(text);
    assert.equal(spec.track, 'community', text);
    assert.equal(spec.dryRun, false, text);
    assert.equal(spec.gameId, null, text);
    const agent = await spec.createForEpisode({
      game: getGame('tictactoe'),
      tier: getGame('tictactoe').spec.tiers[0],
      seed: 's0',
      agentSeat: 0,
    });
    assert.equal(agent.id, text === 'human' ? 'human' : 'human:sam', `${text} kept the spec id`);
    assert.equal(agent.track, 'community', text);
    assert.equal(typeof agent.act, 'function', text);
  }
});

test('the human spec refuses provider and rehearsal flags', async () => {
  await assert.rejects(
    () => parseAgentSpec('human', { prices: '/tmp/no-prices.json' }),
    /human" takes no --dry-run/
  );
  await assert.rejects(
    () => parseAgentSpec('human:sam', { thinkingBudget: 1024 }),
    /a human plays from stdin/
  );
  await assert.rejects(
    () => parseAgentSpec('human', { reasoningEffort: 'high' }),
    /a human plays from stdin/
  );
  await assert.rejects(
    () => parseAgentSpec('human', { script: '/tmp/no-script.mjs', dryRun: true }),
    /a human plays from stdin/
  );
});

test('a name with a colon is not a human spec — the grammar refuses it', async () => {
  await assert.rejects(() => parseAgentSpec('human:a:b'), /unknown agent spec "human:a:b"/);
  // and the unknown-spec error names the human form so it is discoverable
  await assert.rejects(() => parseAgentSpec('humanoid'), /"human\[:name\]"/);
});

test('model and community-assisted specs build a FRESH agent per episode', async () => {
  // The inner model agent carries its previous reply across provider calls;
  // a shared instance across episodes would leak one episode's conversation
  // into the next. Both spec kinds therefore expose createForEpisode()
  // factories — this pins that repeated calls return DISTINCT agent objects
  // and that the track/identity stay stable across episodes.
  const ctx = {
    game: getGame('tictactoe'),
    tier: getGame('tictactoe').spec.tiers[0],
    seed: 's0',
    agentSeat: 0,
  };

  const modelSpec = await parseAgentSpec('model:openai-chat/stub-model', {
    dryRun: true,
    script: repliesFile,
  });
  const a = await modelSpec.createForEpisode(ctx);
  const b = await modelSpec.createForEpisode(ctx);
  assert.notEqual(a, b, 'a second episode must get its own scripted model agent');
  assert.equal(a.id, 'model:openai-chat/stub-model');

  const assistedSpec = await parseAgentSpec('community-assisted:openai-chat/stub-model', {
    dryRun: true,
    script: repliesFile,
  });
  const c = await assistedSpec.createForEpisode(ctx);
  const d = await assistedSpec.createForEpisode(ctx);
  assert.notEqual(c, d, 'a second episode must get its own assisted wrapper');
  assert.equal(c.id, 'community-assisted:openai-chat/stub-model:retries=2');
});
