import { BASELINE_FACTORIES, parseAgentSpec } from './agents.js';
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

test('reasoning-effort widens to xhigh and max as a spec suffix on anthropic', async () => {
  for (const value of ['low', 'medium', 'high', 'xhigh', 'max']) {
    const text = `model:anthropic/claude-opus-4-5:reasoning-effort=${value}`;
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
