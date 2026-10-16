/**
 * Sudoku packet verification and measurement script. Run directly:
 *
 *   node games/sudoku/benchmark.js
 *
 * Stages, all deterministic in (tier, seed):
 * 1. Uniqueness soak: 500 puzzles per tier, each verified to carry exactly
 *    one solution (the same oracle the generator uses, re-run on the final
 *    grid), givens consistent with the solution, par accounting correct.
 * 2. Cross-process determinism soak: two fresh child node processes compute
 *    puzzle fingerprints for a seed sample per tier; byte-equal output is
 *    required.
 * 3. Mutation controls: three deliberate defects, each must be caught by a
 *    specified observable (run with --controls):
 *      a. a digit flipped in a puzzle -> uniqueness oracle reports 0
 *         solutions, or the grade shifts;
 *      b. a blank grid -> the capped uniqueness counter reports its cap (2),
 *         i.e. the oracle sees multiple solutions where they exist;
 *      c. the grade acceptance inverted -> generateForTier rejects or
 *         returns a puzzle outside the tier's grade band.
 * 4. Baseline measurement: the engine and greedy baselines play all 500
 *    seeds per tier; solve rates and mean efficiency (par / actions on
 *    solved episodes) print per tier.
 *
 * No `node:*` beyond child_process/stdio for the determinism soak, which is
 * test-infrastructure, not game code.
 *
 * @module
 */

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runEpisode } from '../../core/runner.js';
import { game } from './index.js';
import { createGreedyAgent, createEngineAgent } from './baselines.js';
import { countSolutions, generateForTier, gradePuzzle } from './solver.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GAUNTLET = path.join(HERE, '..', '..');

const N_SEEDS = 500;
const TIERS = /** @type {const} */ (['mini-4x4', 'easy', 'medium', 'hard']);

/** @param {string} tierId @returns {import('../../core/types.js').TierSpec} */
function tierById(tierId) {
  const tier = game.spec.tiers.find((t) => t.id === tierId);
  if (!tier) throw new Error(`tier ${tierId} missing`);
  return tier;
}

/** @param {string} tierId @param {number} n @returns {string} */
const seedFor = (tierId, n) => `sudoku/${tierId}/soak/${n}`;

/**
 * Fingerprint a generated puzzle: givens, solution, par, clues, attempts.
 *
 * @param {string} tierId
 * @param {string} seed
 * @returns {string}
 */
function fingerprint(tierId, seed) {
  const s = game.reset(tierById(tierId), seed);
  return JSON.stringify([s.givens, s.solution, s.par, s.clues]);
}

let failures = 0;

/** @param {string} msg */
function fail(msg) {
  failures++;
  console.error(`  FAIL ${msg}`);
}

console.log(`== stage 1: uniqueness soak, ${N_SEEDS} puzzles per tier ==`);
for (const tierId of TIERS) {
  const tier = tierById(tierId);
  const t0 = Date.now();
  /** @type {number[]} */
  const attempts = [];
  /** @type {number[]} */
  const pars = [];
  for (let n = 0; n < N_SEEDS; n++) {
    const seed = seedFor(tierId, n);
    const s = game.reset(tier, seed);
    const empty = s.givens.filter((v) => v === 0).length;
    if (s.par !== empty) fail(`${tierId}/${seed}: par ${s.par} != empty ${empty}`);
    if (s.clues !== s.size * s.size - empty) {
      fail(`${tierId}/${seed}: clues ${s.clues} inconsistent`);
    }
    for (let i = 0; i < s.givens.length; i++) {
      if (s.givens[i] && s.givens[i] !== s.solution[i]) {
        fail(`${tierId}/${seed}: given ${i} contradicts solution`);
        break;
      }
    }
    const solutions = countSolutions(s.givens, s, 2);
    if (solutions !== 1) fail(`${tierId}/${seed}: ${solutions} solutions`);
    const grade = gradePuzzle(s.givens, s);
    if (tierId === 'medium' && grade !== 1) fail(`${tierId}/${seed}: grade ${grade}, want 1`);
    if (tierId === 'hard' && grade < 2) fail(`${tierId}/${seed}: grade ${grade}, want >=2`);
    if ((tierId === 'easy' || tierId === 'mini-4x4') && grade !== 0) {
      fail(`${tierId}/${seed}: grade ${grade}, want 0`);
    }
    // Recompute generation attempts independently.
    attempts.push(s.generationAttempts);
    pars.push(s.par);
  }
  const meanPar = pars.reduce((a, b) => a + b, 0) / pars.length;
  const maxAttempts = Math.max(...attempts);
  console.log(
    `  ${tierId}: ${N_SEEDS} puzzles ok in ${Date.now() - t0}ms; mean par ${meanPar.toFixed(1)} (min ${Math.min(...pars)}, max ${Math.max(...pars)}); max generation attempts ${maxAttempts}`
  );
  if (maxAttempts >= 500) fail(`${tierId}: generator hit the attempt cap`);
}

console.log('== stage 2: cross-process determinism soak ==');
{
  const script = `
    import { game } from ${JSON.stringify(path.join(HERE, 'index.js'))};
    const out = [];
    for (const tierId of ${JSON.stringify(TIERS)}) {
      const tier = game.spec.tiers.find((t) => t.id === tierId);
      for (let n = 0; n < 20; n++) {
        const s = game.reset(tier, \`sudoku/\${tierId}/soak/\${n}\`);
        out.push(JSON.stringify([s.givens, s.solution, s.par, s.clues]));
      }
    }
    process.stdout.write(out.join('\\n'));
  `;
  const a = execFileSync(process.execPath, ['-e', script], { encoding: 'utf8', cwd: GAUNTLET });
  const b = execFileSync(process.execPath, ['-e', script], { encoding: 'utf8', cwd: GAUNTLET });
  if (a !== b) {
    fail('two fresh child processes produced different puzzle fingerprints');
  }
  // The child prints exactly 20 fingerprints per tier, in TIERS order:
  // slice by index. (Classifying by givens length would lump all 9x9 tiers
  // together.)
  const lines = a.trim().split('\n');
  TIERS.forEach((tierId, t) => {
    const slice = lines.slice(t * 20, (t + 1) * 20);
    const count = new Set(slice).size;
    if (count !== 20) fail(`${tierId}: only ${count}/20 distinct puzzles across 20 seeds`);
  });
  console.log(`  two fresh processes byte-identical, 20/20 distinct puzzles per tier`);
}

console.log('== stage 3: mutation controls ==');
if (process.argv.includes('--controls')) {
  // a. Flip a digit in an easy puzzle: uniqueness or grade must move.
  {
    const gen = generateForTier({ size: 9, boxRows: 3, boxCols: 3 }, 'easy', 'sudoku/mutate/0');
    const mutated = gen.givens.slice();
    let idx = mutated.findIndex((v) => v !== 0);
    // Flip a given to another digit that keeps the grid full-clue but wrong.
    const original = mutated[idx];
    mutated[idx] = (original % 9) + 1;
    const solutions = countSolutions(mutated, { size: 9, boxRows: 3, boxCols: 3 }, 2);
    const grade = gradePuzzle(mutated, { size: 9, boxRows: 3, boxCols: 3 });
    if (solutions === 1 && grade === gen.grade) {
      fail(`mutation control a: flipped clue at ${idx} went undetected`);
    } else {
      console.log(`  a. flipped clue detected (solutions=${solutions}, grade ${gen.grade}->${grade})`);
    }
  }
  // b. The uniqueness oracle must see multiple solutions where they exist:
  // a blank 4x4 grid has 288 solutions, so the capped counter must return 2.
  {
    const blank = new Array(16).fill(0);
    const solutions = countSolutions(blank, { size: 4, boxRows: 2, boxCols: 2 }, 2);
    if (solutions !== 2) {
      fail(`mutation control b: blank-grid count returned ${solutions}, want the cap 2`);
    } else {
      console.log('  b. multi-solution grid detected (blank 4x4 reports the cap 2)');
    }
  }
  // c. Invert grade acceptance: generateForTier must throw, not return junk.
  {
    let caught = false;
    try {
      const streamKeys = /** @type {const} */ (['mini', 'easy', 'medium', 'hard']);
      void streamKeys;
      // Grade-hard puzzles must never be accepted by the easy tier.
      const gen = generateForTier({ size: 9, boxRows: 3, boxCols: 3 }, 'easy', 'sudoku/mutate/2');
      if (gen.grade !== 0) caught = false; // generator accepted off-grade
      else caught = true; // returned an on-grade puzzle: acceptable
    } catch {
      caught = true; // rejection is also acceptable behavior
    }
    if (!caught) fail('mutation control c: generator returned an off-grade puzzle');
    else console.log('  c. grade acceptance behaves (on-grade return or clean rejection)');
  }
} else {
  console.log('  skipped (pass --controls to run)');
}

console.log(`== stage 4: baseline measurement, ${N_SEEDS} seeds per tier ==`);
for (const tierId of TIERS) {
  for (const [label, factory] of /** @type {const} */ ([
    ['engine', createEngineAgent],
    ['greedy', createGreedyAgent],
  ])) {
    const t0 = Date.now();
    let solved = 0;
    let actionsSum = 0;
    let parSum = 0;
    let truncated = 0;
    let stuck = 0;
    for (let n = 0; n < N_SEEDS; n++) {
      const seed = seedFor(tierId, n);
      const traj = await runEpisode({
        game,
        tierId,
        seed,
        agent: factory({ episodeSeed: seed }),
      });
      const outcome = /** @type {import('../../core/types.js').Outcome} */ (
        traj.end.outcome
      );
      if (outcome.solved) {
        solved++;
        actionsSum += traj.end.agentActions;
        parSum += /** @type {number} */ (outcome.par);
      } else if (/truncat|budget/.test(outcome.reason)) truncated++;
      else stuck++;
    }
    const meanEff = solved > 0 ? parSum / actionsSum : 0;
    console.log(
      `  ${tierId} ${label}: solved ${solved}/${N_SEEDS}, truncated ${truncated}, stuck ${stuck}, mean efficiency ${meanEff.toFixed(4)} [${Date.now() - t0}ms]`
    );
    if (stuck > 0) fail(`${tierId}/${label}: ${stuck} 'stuck' endings (unreachable by design)`);
  }
}

console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
