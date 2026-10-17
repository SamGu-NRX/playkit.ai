/**
 * The cell-completion rule: a cell bundle counts as present only when every
 * planned seed has a trajectory that records the registry's **current** game
 * version. run.json episode counts alone are not evidence — #107 committed
 * run.json + suite.json with trajectories untracked, and #108's version bumps
 * stranded every recorded episode while the old rule kept "finding" the cells
 * complete. That gap is what let the separation pilot reach alpha stranded.
 *
 * @module
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { GAMES } from '../../games/index.js';
import { cellBundleVerdict } from './audit-lib.mjs';

/**
 * A bundle fixture for one game/tier: writes run.json and, where `versions`
 * supplies an entry, a trajectory file for that seed recording the given
 * game version. Trajectories live at <bundle>/<game>/<tier>/<seed>.json —
 * the same layout run-cells writes and verify-cells reads.
 *
 * @param {string} root
 * @param {string} gameId
 * @param {string} tierId
 * @param {string[]} seeds
 * @param {{ runJson?: boolean, versions?: Record<string, string | null> }} opts
 */
async function makeBundle(root, gameId, tierId, seeds, { runJson = true, versions = {} } = {}) {
  const bundle = join(root, gameId, tierId, 'dial-1');
  const dir = join(bundle, gameId, tierId);
  await mkdir(dir, { recursive: true });
  if (runJson) {
    await writeFile(
      join(bundle, 'run.json'),
      JSON.stringify({ format: 'playkit-gauntlet-run/1', total: { episodes: seeds.length } }) + '\n'
    );
  }
  for (const seed of seeds) {
    const version = versions[seed];
    if (version === undefined) continue;
    // Seeds carry path components ("game/tier/split/hash") — trajectory files
    // nest exactly as run.js writes them.
    const path = join(dir, `${seed}.json`);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(
      path,
      JSON.stringify({ game: version === null ? {} : { version }, seed }) + '\n'
    );
  }
  return bundle;
}

const gameId = 'mastermind';
const game = /** @type {*} */ (GAMES[gameId]);
const tierId = /** @type {*} */ (game).spec.tiers[0].id;
const currentVersion = /** @type {*} */ (game).spec.version;
const seeds = ['a', 'b'].map((s) => `${gameId}/${tierId}/public/${s}`);

test('a cell with run.json and a current-version trajectory for every planned seed is complete', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cell-complete-'));
  try {
    const bundle = await makeBundle(root, gameId, tierId, seeds, {
      versions: Object.fromEntries(seeds.map((s) => [s, currentVersion])),
    });
    const verdict = await cellBundleVerdict(bundle, gameId, tierId, seeds);
    assert.equal(verdict.complete, true, verdict.reason);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('run.json claiming every episode without trajectories is NOT complete (the #107 strand)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cell-complete-'));
  try {
    const bundle = await makeBundle(root, gameId, tierId, seeds, { runJson: true, versions: {} });
    const verdict = await cellBundleVerdict(bundle, gameId, tierId, seeds);
    assert.equal(verdict.complete, false);
    assert.match(verdict.reason, /missing trajectory/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a trajectory recording a stale game version is NOT complete, and the reason names both versions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cell-complete-'));
  try {
    const stale = '0.0.1-stale';
    assert.notEqual(stale, currentVersion);
    const bundle = await makeBundle(root, gameId, tierId, seeds, {
      versions: { [seeds[0]]: stale, [seeds[1]]: currentVersion },
    });
    const verdict = await cellBundleVerdict(bundle, gameId, tierId, seeds);
    assert.equal(verdict.complete, false);
    assert.match(verdict.reason, new RegExp(`recorded game version ${stale}, registry is at ${currentVersion}`));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a trajectory recording no game version is NOT complete', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cell-complete-'));
  try {
    const bundle = await makeBundle(root, gameId, tierId, seeds, {
      versions: { [seeds[0]]: null, [seeds[1]]: currentVersion },
    });
    const verdict = await cellBundleVerdict(bundle, gameId, tierId, seeds);
    assert.equal(verdict.complete, false);
    assert.match(verdict.reason, /recorded game version none/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a bundle without run.json is NOT complete even with trajectories on disk', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cell-complete-'));
  try {
    const bundle = await makeBundle(root, gameId, tierId, seeds, {
      runJson: false,
      versions: Object.fromEntries(seeds.map((s) => [s, currentVersion])),
    });
    const verdict = await cellBundleVerdict(bundle, gameId, tierId, seeds);
    assert.equal(verdict.complete, false);
    assert.match(verdict.reason, /no run\.json/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('an unreadable trajectory file is NOT complete', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cell-complete-'));
  try {
    const bundle = await makeBundle(root, gameId, tierId, seeds, {
      runJson: true,
      versions: Object.fromEntries(seeds.map((s) => [s, currentVersion])),
    });
    const dir = join(bundle, gameId, tierId);
    await writeFile(join(dir, `${seeds[1]}.json`), '{not json');
    const verdict = await cellBundleVerdict(bundle, gameId, tierId, seeds);
    assert.equal(verdict.complete, false);
    assert.match(verdict.reason, /unreadable trajectory/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
