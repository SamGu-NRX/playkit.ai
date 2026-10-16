/**
 * Decision-diff harness: best-move comparison between the baseline engine
 * (path given as argv[2]) and the current engine, across tiers, positions,
 * and seeds. Prints one line per differing decision with its cause hints.
 * Run from gauntlet/: node decision-diff.mjs /tmp/base-engine.mjs
 */

import { bestMove } from './games/chess/engine.js';
import { createRequire } from 'node:module';
import process from 'node:process';

const require = createRequire(import.meta.url);
const { Chess } = require('chess.js');

const base = await import(process.argv[2]);

const game = await import('./games/chess/index.js');
const TIERS = game.default.spec.tiers.map((t) => ({ id: t.id, params: t.params }));

const POSITIONS = [
  { name: 'start', fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1' },
  { name: 'middlegame', fen: 'r1bq1rk1/pp2ppbp/2np1np1/8/2BNP3/2N1BP2/PPPQ2PP/R3K2R w KQkq - 0 9' },
  { name: 'kiwipete', fen: 'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1' },
  { name: 'position3', fen: '8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1' },
  { name: 'black-edge', fen: '4k3/3pn3/3BPQ2/3Ppr2/8/8/8/K7 b - - 0 1' },
];

const SEEDS = ['diff-a', 'diff-b', 'diff-c'];

/** Deterministic small rng per seed so tier tie-breaking is reproducible. */
function rngFor(seed) {
  let h = 2166136261;
  for (const c of seed) {
    h ^= c.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  return () => {
    h ^= h << 13;
    h ^= h >>> 17;
    h ^= h << 5;
    return ((h >>> 0) % 10000) / 10000;
  };
}

/** Best move from a fen using an engine module + a tier's params. */
function pick(engine, tier, fen, seed) {
  const chess = new Chess(fen);
  const move = engine.bestMove(chess, tier.params, rngFor(`${tier.id}/${seed}/${fen}`));
  return move?.san ?? move?.uci ?? String(move);
}

let diffs = 0;
let total = 0;
for (const tier of TIERS) {
  for (const pos of POSITIONS) {
    for (const seed of SEEDS) {
      total++;
      const a = pick(base, tier, pos.fen, seed);
      const current = pickCurrent(tier, pos.fen, seed);
      if (a !== current) {
        diffs++;
        console.log(`DIFF ${tier.id}/${pos.name}/${seed}: base=${a} head=${current}`);
      }
    }
  }
}
console.log(`\n${diffs}/${total} differing best moves`);

function pickCurrent(tier, fen, seed) {
  const chess = new Chess(fen);
  const move = bestMove(chess, tier.params, rngFor(`${tier.id}/${seed}/${fen}`));
  return move?.san ?? move?.uci ?? String(move);
}
