/**
 * End-to-end regression pins for compute-stats.mjs (PR #104 review findings):
 *
 * 1. The corrected-7b fallback — the committed 7B bundles predate the arm
 *    rename and exist only under the corrected-7b arm, so without the
 *    fallback (a) H2 silently dropped 7B from the size-order correlation and
 *    (b) H1 recorded a note for 7B instead of the preregistered comparison.
 *    Both lookups now fall back to corrected-7b exactly like the paired
 *    section always did. Pre-fix, this test fails with sizeOrder.n === 2 +
 *    a note, and a 7B prior note.
 *
 * 2. Game/tier-matched prior-run selection — H1 used to take the FIRST prior
 *    subdirectory holding a suite.json, which silently paired against a
 *    wrong-tier cell when a prior tree carries more than one suite per
 *    model (greptile r4305289846). The prior cell must match the corrected
 *    study's game AND tier. Pre-fix, this test fails: the alphabetically
 *    first wrong-tier cell is chosen and the comparison collapses to n === 0.
 *
 * Everything is real and local: mastermind/mini episodes played through
 * core/runner.js with the calibration engine baseline under the skill dial
 * (free, deterministic, no engines, no network); compute-stats runs as a
 * subprocess over the synthetic runs tree through the official scorer.
 *
 * @module
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runEpisode } from '../../core/runner.js';
import { GAMES } from '../../games/index.js';
import { skillDial } from '../../agents/skill-dial.js';
import { CALIBRATION_GAMES } from '../../calibration/games.js';
import { buildSuite } from '../../scoring/suite.js';

const here = dirname(fileURLToPath(import.meta.url));
const NOW = () => 1_760_000_000_000;
const SEEDS = ['mastermind/mini/public/0', 'mastermind/mini/public/1'];
const STEMS = {
  '0.5b': 'qwen2.5-0.5b-instruct-q4_k_m',
  '1.5b': 'qwen2.5-1.5b-instruct-q4_k_m',
  '7b': 'qwen2.5-7b-instruct-q4_k_m',
};

/** One real mastermind/mini episode under the dial-wrapped engine expert. */
async function playMini(seed, dialP) {
  const game = GAMES.mastermind;
  const tier = game.spec.tiers.find((t) => t.id === 'mini');
  const cal = CALIBRATION_GAMES.find((g) => g.id === 'mastermind');
  const seat = typeof game.agentSeat === 'function' ? game.agentSeat(tier, seed) : 0;
  const expert = cal.makeAgent('engine', { episodeSeed: seed, tier, seat });
  const dial = skillDial(expert, dialP, { episodeSeed: seed });
  return runEpisode({ game, tierId: 'mini', seed, split: 'public', agent: dial, now: NOW });
}

/** A public mastermind suite manifest over one tier with the unit seeds. */
function suiteFor(tierId, arm) {
  const game = GAMES.mastermind;
  const tier = game.spec.tiers.find((t) => t.id === tierId);
  return buildSuite([{ ...game, spec: { ...game.spec, tiers: [{ ...tier, rank: 1, publicSeeds: SEEDS.length }] } }], {
    split: 'public',
    id: `gauntlet-public-example-confound-${arm}-mastermind-${tierId}-${SEEDS.length}`,
  });
}

/** One runs cell: suite.json + run.json + the played trajectories under public/. */
async function writeCell(root, modelStem, cell, arm, tierId, dialP) {
  const dir = join(root, modelStem, cell);
  mkdirSync(join(dir, 'public'), { recursive: true });
  writeFileSync(join(dir, 'suite.json'), JSON.stringify(suiteFor(tierId, arm), null, 2) + '\n');
  writeFileSync(join(dir, 'run.json'), JSON.stringify({ agent: { text: `unit-${arm}` } }) + '\n');
  if (dialP !== null) {
    for (const seed of SEEDS) {
      const trajectory = await playMini(seed, dialP);
      writeFileSync(join(dir, 'public', `${encodeURIComponent(seed)}.json`), JSON.stringify(trajectory) + '\n');
    }
  }
  return dir;
}

test('compute-stats.mjs falls back to corrected-7b and picks the prior cell by game and tier', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'exconf-compute-stats-'));
  try {
    const runs = join(dir, 'runs');
    // Corrected arms: 0.5B and 1.5B under corrected-official, 7B only under
    // its historical corrected-7b name (the committed shape).
    await writeCell(runs, STEMS['0.5b'], 'mastermind-mini-corrected-official', 'corrected-official', 'mini', 0.75);
    await writeCell(runs, STEMS['1.5b'], 'mastermind-mini-corrected-official', 'corrected-official', 'mini', 0.25);
    await writeCell(runs, STEMS['7b'], 'mastermind-mini-corrected-7b', 'corrected-7b', 'mini', 0.75);
    // Prior official tree: for 0.5B/1.5B a WRONG-tier cell sorts first
    // (aaa-…) and the right mastermind/mini cell sorts last (zzz-…); for 7B
    // only the right cell. Wrong-tier cells carry suite.json only.
    const prior = join(dir, 'prior-official');
    await writeCell(prior, STEMS['0.5b'], 'aaa-wrong-tier', 'corrected-official', 'classic', null);
    await writeCell(prior, STEMS['0.5b'], 'zzz-right-tier', 'corrected-official', 'mini', 1);
    await writeCell(prior, STEMS['1.5b'], 'aaa-wrong-tier', 'corrected-official', 'classic', null);
    await writeCell(prior, STEMS['1.5b'], 'zzz-right-tier', 'corrected-official', 'mini', 1);
    await writeCell(prior, STEMS['7b'], 'zzz-right-tier', 'corrected-official', 'mini', 1);

    const outPath = join(dir, 'stats.json');
    execFileSync(
      process.execPath,
      [
        join(here, 'compute-stats.mjs'),
        '--runs', runs,
        '--out', outPath,
        '--prior-official-runs', prior,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
    );
    const stats = JSON.parse(readFileSync(outPath, 'utf8'));

    // H2: all three models in the size order, no missing-run note.
    assert.equal(stats.sizeOrder.n, 3, `H2 must use all three models, got ${JSON.stringify(stats.sizeOrder)}`);
    assert.ok(!('note' in stats.sizeOrder), 'H2 must not fall back to a missing-run note');
    assert.equal(typeof stats.sizeOrder.rho, 'number', 'H2 rho must be computed over three distinct means');
    assert.ok(stats.runs['qwen2.5-7b:corrected-7b'], 'the 7B cell must be collected under its historical arm name');

    // H1: every model gets a real paired comparison; 0.5B/1.5B pair against
    // the game/tier-MATCHED prior cell (not the alphabetically first one),
    // and 7B pairs via the corrected-7b fallback.
    const shorts = { '0.5b': 'qwen2.5-0.5b', '1.5b': 'qwen2.5-1.5b', '7b': 'qwen2.5-7b' };
    for (const [size, short] of Object.entries(shorts)) {
      const key = `${short}:prior-official-minus-corrected-official`;
      const entry = stats.prior[key];
      assert.ok(entry, `H1 entry for ${size} must exist`);
      assert.ok(!entry.note, `H1 entry for ${size} must be computed, got note: ${entry.note}`);
      assert.ok(entry.priorDir.endsWith('zzz-right-tier'), `H1 for ${size} must pick the matched prior cell, got ${entry.priorDir}`);
      assert.equal(entry.n, SEEDS.length, `H1 for ${size} must pair every shared seed`);
      assert.equal(typeof entry.meanDiff, 'number', `H1 for ${size} must have a mean diff`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
