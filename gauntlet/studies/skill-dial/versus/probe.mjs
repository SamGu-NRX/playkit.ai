/**
 * Timing probe: one episode per representative (game, tier, p) cell, printed
 * with wall-clock ms and the end reason. Sizing input for REPORT.md's CPU
 * budget, not a study artifact.
 *
 * @module
 */

import { GAMES } from '../../../games/index.js';
import { runEpisode } from '../../../core/runner.js';
import { createSkillDialAgent } from './dial.js';
import { engineExpertFor } from './experts.mjs';

const PROBE_CELLS = [
  ['tictactoe', 'perfect-opponent', 0.5],
  ['connect4', 'ladder-1', 1],
  ['connect4', 'ladder-2', 0],
  ['connect4', 'ladder-3', 0],
  ['connect4', 'ladder-4', 0],
  ['connect4', 'forced-win', 0],
  ['holdem', 'station', 1],
  ['holdem', 'equity', 0],
  ['chess', 'paper', 1],
  ['chess', 'paper', 0],
  ['chess', 'granite', 1],
  ['chess', 'granite', 0],
  ['chess-endgames', 'kqk', 1],
  ['chess-endgames', 'kbnk', 0],
  ['chess-puzzles', 'r0400', 0],
  ['chess-puzzles', 'r2600', 0],
];

for (const [gameId, tierId, p] of PROBE_CELLS) {
  const game = GAMES[gameId];
  const tier = game.spec.tiers.find((t) => t.id === tierId);
  const seed = `${gameId}/${tierId}/public/0`;
  const seat = typeof game.agentSeat === 'function' ? game.agentSeat(tier, seed) : 0;
  const expert = engineExpertFor(gameId, { game, tier, seed, seat });
  const agent = createSkillDialAgent({ expert, p, episodeSeed: seed });
  const started = Date.now();
  try {
    const trajectory = await runEpisode({ game, tierId, seed, agent });
    const ms = Date.now() - started;
    const score = trajectory.end.outcome?.normalized?.[trajectory.agent.seat];
    console.log(
      `${gameId}/${tierId} p=${p}: ${ms} ms, agentActions=${trajectory.end.agentActions}, end=${trajectory.end.reason}, e=${score}`
    );
  } catch (err) {
    console.log(`${gameId}/${tierId} p=${p}: FAILED after ${Date.now() - started} ms: ${err.message}`);
  }
}
