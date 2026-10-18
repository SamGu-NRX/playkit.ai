/**
 * CLI-level pin for the separation-pilot mirror filter (`analyze.mjs`
 * `scoreAndMirror`): the production `score()` mirror is fed ONLY in-suite
 * trajectories, so a bundle that also carries valid-but-out-of-suite episodes
 * is analyzed with a loud note instead of a mirror mismatch or a crash
 * (greptile r4305289847). The unit suite pins `suiteKeysOf` in isolation;
 * dropping the `memberKeys` filter inside `scoreAndMirror` leaves that unit
 * test green — only this CLI run notices, because the out-of-suite episode
 * then reaches production `score()` and the run fails on the mirror check.
 *
 * Everything is real and local: mastermind/mini episodes played through
 * `core/runner.js` with the calibration engine baseline (free, deterministic,
 * no engines, no network), written to two bundle directories plus a
 * `buildSuite` manifest, then analyzed by the real CLI.
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

/** One real mastermind/mini episode under the dial-wrapped engine expert. */
async function playMastermindMini(seed, dialP) {
  const game = GAMES.mastermind;
  const tier = game.spec.tiers.find((t) => t.id === 'mini');
  const cal = CALIBRATION_GAMES.find((g) => g.id === 'mastermind');
  const seat = typeof game.agentSeat === 'function' ? game.agentSeat(tier, seed) : 0;
  const expert = cal.makeAgent('engine', { episodeSeed: seed, tier, seat });
  const dial = skillDial(expert, dialP, { episodeSeed: seed });
  return runEpisode({ game, tierId: 'mini', seed, split: 'public', agent: dial, now: NOW });
}

/** The two-seed public suite manifest (seeds public/0, public/1). */
function miniSuite() {
  const game = GAMES.mastermind;
  const tier = game.spec.tiers.find((t) => t.id === 'mini');
  return buildSuite([{ ...game, spec: { ...game.spec, tiers: [{ ...tier, rank: 1, publicSeeds: 2 }] } }], {
    split: 'public',
    id: 'unit-sep-pilot-mastermind-mini-2',
  });
}

test('analyze.mjs ignores valid out-of-suite episodes loudly — the score() mirror sees only in-suite trajectories', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sep-pilot-analyze-cli-'));
  try {
    const suite = miniSuite();
    // Suite seeds are fully-qualified '<game>/<tier>/public/<i>' strings.
    const suiteSeeds = suite.games[0].tiers[0].seeds;
    const inSuite = [...suiteSeeds];
    assert.equal(inSuite.length, 2, `fixture suite must carry two seeds, got ${JSON.stringify(suiteSeeds)}`);
    const extra = 'mastermind/mini/public/2';
    assert.ok(!suiteSeeds.includes(extra), 'the extra episode must be OUT of the suite');
    const suitePath = join(dir, 'suite.json');
    writeFileSync(suitePath, JSON.stringify(suite, null, 2) + '\n');

    // Bundle A carries the two in-suite episodes PLUS a valid extra
    // (out-of-suite) episode; bundle B carries the in-suite pair only.
    const writeBundle = async (name, p, episodeSeeds) => {
      const bundle = join(dir, name);
      mkdirSync(bundle, { recursive: true });
      for (const seed of episodeSeeds) {
        const trajectory = await playMastermindMini(seed, p);
        writeFileSync(join(bundle, `${encodeURIComponent(seed)}.json`), JSON.stringify(trajectory) + '\n');
      }
      writeFileSync(join(bundle, 'run.json'), JSON.stringify({ agent: { id: name } }) + '\n');
      return bundle;
    };
    const bundleA = await writeBundle('unit-arm-a', 0.75, [...inSuite, extra]);
    const bundleB = await writeBundle('unit-arm-b', 0.25, inSuite);

    // With the mirror filter intact the extra episode is ignored with a note.
    let out;
    try {
      out = execFileSync(
        process.execPath,
        [join(here, 'analyze.mjs'), bundleA, bundleB, '--suite', suitePath, '--json'],
        { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
      );
    } catch (err) {
      throw new Error(`analyze.mjs must exit 0 with the extra episode present (stderr: ${err.stderr ?? err.message})`);
    }
    const json = JSON.parse(out);
    const note = (json.warnings ?? []).find((w) => w.includes('outside the suite'));
    assert.ok(note, `the out-of-suite episode must produce a loud note, got warnings: ${JSON.stringify(json.warnings)}`);
    assert.ok(note.includes('unit-arm-a'), 'the note must name the bundle carrying the extra episode');
    assert.ok(note.includes(extra), 'the note must name the out-of-suite episode key');

    const comparison = (json.comparisons ?? []).find((c) => c.comparison === 'unit-arm-a~vs~unit-arm-b');
    assert.ok(comparison, 'the two bundles must be compared');
    assert.ok(comparison.readings.raw, 'the comparison must produce a raw reading');
    assert.notEqual(comparison.readings.raw.D, null, 'the raw reading must have a statistic');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
