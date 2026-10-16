/**
 * Game-level tests for chess-endgames: the conformance kit on every tier,
 * seed determinism and DTM bands, and the baselines' behavior — the
 * tablebase engine must score 1.0 on every checked public seed, with its
 * trajectories replay-verified, and the greedy baseline must run legally and
 * score at most the engine.
 *
 * @module
 */

import test from 'node:test';
import { publicSeed } from '../../core/seeds.js';
import { runConformance } from '../../core/conformance.js';
import { runEpisode } from '../../core/runner.js';
import { verifyTrajectory } from '../../core/trajectory.js';
import { getTablebase } from './tablebase.js';
import chessEndgames from './index.js';
import { engineFor, greedyFor } from './baselines.js';

test('chess-endgames passes the full conformance kit on every tier', async () => {
  await runConformance(chessEndgames, { seedsPerTier: 3 });
});

test('reset is deterministic and lands in the tier DTM band on all public seeds', () => {
  for (const tier of chessEndgames.spec.tiers) {
    const params = /** @type {{ kind: string, bandMin: number, bandMax: number }} */ (tier.params);
    const table = getTablebase(params.kind);
    for (let i = 0; i < tier.publicSeeds; i++) {
      const seed = publicSeed(chessEndgames.spec.id, tier.id, i);
      const a = chessEndgames.reset(tier, seed);
      const b = chessEndgames.reset(tier, seed);
      if (JSON.stringify(a) !== JSON.stringify(b)) {
        throw new Error(`tier ${tier.id} seed ${seed}: reset is not deterministic`);
      }
      if (a.side !== 0) {
        throw new Error(`tier ${tier.id} seed ${seed}: the agent must be White to move at the start`);
      }
      const placement = a.fen.split(' ')[0];
      const pos = positionOfPlacement(params.kind, placement);
      const dtm = table.dtm(pos);
      if (dtm === null || dtm < params.bandMin || dtm > params.bandMax) {
        throw new Error(
          `tier ${tier.id} seed ${seed}: start DTM ${dtm} outside band [${params.bandMin}, ${params.bandMax}]`
        );
      }
      if (a.par !== dtm) {
        throw new Error(`tier ${tier.id} seed ${seed}: par ${a.par} != table DTM ${dtm}`);
      }
    }
  }
});

/**
 * Parse a placement field back into an EndgamePosition: walk ranks 8..1 and
 * map piece letters back to slot indices through the kind's piece letters.
 *
 * @param {string} kind
 * @param {string} placement
 * @returns {{ wk: number, bk: number, pieces: number[], side: 0 | 1 }}
 */
function positionOfPlacement(kind, placement) {
  const letters =
    kind === 'kqk' ? ['Q'] : kind === 'krk' ? ['R'] : kind === 'kbbk' ? ['B', 'B'] : ['B', 'N'];
  /** @type {(number | undefined)[]} */
  const slots = new Array(letters.length);
  let wk = -1;
  let bk = -1;
  let rank = 7;
  let file = 0;
  for (const ch of placement) {
    if (ch === '/') {
      rank--;
      file = 0;
      continue;
    }
    if (/[1-8]/.test(ch)) {
      file += Number(ch);
      continue;
    }
    const sq = rank * 8 + file;
    if (ch === 'K') {
      wk = sq;
    } else if (ch === 'k') {
      bk = sq;
    } else {
      // First unfilled slot of this piece type: same-type pieces (kbbk's two
      // bishops) fill in placement scan order, matching the tablebase parser.
      let slot = -1;
      for (let i = 0; i < letters.length; i++) {
        if (letters[i] === ch && slots[i] === undefined) {
          slot = i;
          break;
        }
      }
      if (slot < 0) throw new Error(`unexpected piece ${ch} in a ${kind} placement`);
      slots[slot] = sq;
    }
    file++;
  }
  if (wk < 0 || bk < 0) throw new Error(`placement is missing a king: ${placement}`);
  /** @type {number[]} */
  const pieces = [];
  for (const sq of slots) {
    if (sq === undefined) throw new Error(`placement is missing a ${kind} piece`);
    pieces.push(sq);
  }
  return { wk, bk, pieces, side: 0 };
}

test('the tablebase engine scores 1.0 on five public seeds per tier, replay-verified', async () => {
  for (const tier of chessEndgames.spec.tiers) {
    for (let i = 0; i < 5; i++) {
      const seed = publicSeed(chessEndgames.spec.id, tier.id, i);
      const trajectory = await runEpisode({
        game: chessEndgames,
        tierId: tier.id,
        seed,
        agent: engineFor(tier, seed, 0),
      });
      if (trajectory.end.reason !== 'terminal') {
        throw new Error(
          `tier ${tier.id} seed ${seed}: engine episode ended as ${trajectory.end.reason}`
        );
      }
      const outcome = /** @type {import('../../core/types.js').Outcome} */ (trajectory.end.outcome);
      if (outcome.solved !== true) {
        throw new Error(`tier ${tier.id} seed ${seed}: engine did not solve (${outcome.reason})`);
      }
      const score = outcome.normalized[0];
      if (score !== 1) {
        throw new Error(`tier ${tier.id} seed ${seed}: engine score ${score} != 1 (${outcome.reason})`);
      }
      await verifyTrajectory(chessEndgames, trajectory);
    }
  }
});

test('the greedy baseline plays legally inside the engine bound', async () => {
  for (const tier of chessEndgames.spec.tiers) {
    const seed = publicSeed(chessEndgames.spec.id, tier.id, 0);
    const greedy = await runEpisode({
      game: chessEndgames,
      tierId: tier.id,
      seed,
      agent: greedyFor(tier, seed, 0),
    });
    if (greedy.end.reason !== 'terminal' && greedy.end.reason !== 'budget-exhausted') {
      throw new Error(`tier ${tier.id}: greedy episode ended as ${greedy.end.reason}`);
    }
    const outcome = /** @type {import('../../core/types.js').Outcome} */ (greedy.end.outcome);
    if (outcome.solved === true && outcome.normalized[0] > 1) {
      throw new Error(`tier ${tier.id}: greedy score above 1`);
    }
    await verifyTrajectory(chessEndgames, greedy);
  }
});

test('the observation never reveals par or DTM values', () => {
  const tier = chessEndgames.spec.tiers[0];
  const seed = publicSeed(chessEndgames.spec.id, tier.id, 0);
  const state = chessEndgames.reset(tier, seed);
  const observation = chessEndgames.observe(state, 0);
  // The board and move list legitimately contain bare digits (rank labels,
  // square names), so the leak check is on DTM/par vocabulary, not numbers.
  if (/\b(par|dtm|distance.to.mate|mate in)\b/i.test(observation.text)) {
    throw new Error('the observation mentions DTM/par concepts');
  }
});

test('parseAction accepts UCI, SAN alternates, verbs, quotes and casing', async () => {
  const tier = chessEndgames.spec.tiers[0];
  const seed = publicSeed(chessEndgames.spec.id, tier.id, 0);
  const state = chessEndgames.reset(tier, seed);
  const legal = chessEndgames.legalActions(state, 0);
  if (legal.length === 0) throw new Error('the start position has no legal actions');
  const uci = legal[0];
  const parsed = chessEndgames.parseAction(state, 0, uci);
  if (!parsed.ok || parsed.action !== uci) {
    throw new Error(`parseAction(${uci}) did not return itself: ${JSON.stringify(parsed)}`);
  }
  // SAN alternate: chess.js names the from-square piece; parse and compare.
  const { Chess } = await import('chess.js');
  const chess = new Chess(state.fen);
  const verbose = chess.moves({ verbose: true });
  const target = verbose.find((/** @type {any} */ m) => m.from + m.to === uci);
  if (target) {
    for (const text of [target.san, `move ${uci}`, `"${uci}"`, uci.toUpperCase()]) {
      const p = chessEndgames.parseAction(state, 0, text);
      if (!p.ok || p.action !== uci) {
        throw new Error(`parseAction(${JSON.stringify(text)}) failed: ${JSON.stringify(p)}`);
      }
    }
  }
});

test('step rejects wrong-turn and over-state moves with GauntletRuleError', async () => {
  const { GauntletRuleError } = await import('../../core/errors.js');
  const tier = chessEndgames.spec.tiers[0];
  const seed = publicSeed(chessEndgames.spec.id, tier.id, 0);
  const state = chessEndgames.reset(tier, seed);
  let threw = false;
  try {
    chessEndgames.step(state, 1, 'e1e2');
  } catch (err) {
    threw = err instanceof GauntletRuleError;
  }
  if (!threw) throw new Error('step must reject a wrong-seat move');
});
