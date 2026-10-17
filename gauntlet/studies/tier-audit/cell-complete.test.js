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
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { GAMES } from '../../games/index.js';
import { manifestSha256 } from '../../runs/plan.js';
import { cellBundleVerdict, tierSuite } from './audit-lib.mjs';

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
    // nest exactly as run.js writes them. The trajectory body carries the
    // full identity/shape the completion verdict requires: game id, tier,
    // seed, agent seat, end action counts (mastermind/mini is an efficiency
    // tier, so an unsolved null outcome needs no par).
    const path = join(dir, `${seed}.json`);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(
      path,
      JSON.stringify({
        format: 'playkit-gauntlet-trajectory/1',
        game: version === null ? {} : { id: gameId, version },
        tier: tierId,
        seed,
        agent: { seat: 0 },
        end: { agentActions: 3, invalidActions: 0, outcome: null },
      }) + '\n'
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

// --- Manifest integrity (Codex #4303998316) --------------------------------

test('a bundle whose suite.json manifest differs from the expected one is NOT complete', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cell-complete-'));
  try {
    const bundle = await makeBundle(root, gameId, tierId, seeds, {
      versions: Object.fromEntries(seeds.map((s) => [s, currentVersion])),
    });
    // The bundle carries a stale-but-internally-consistent manifest: every
    // trajectory is present and version-current, yet built from another
    // suite. The expected hash comes from tierSuite() in run-cells.
    const { suite } = tierSuite(gameId, tierId);
    const stale = { ...suite, id: `${suite.id}-stale` };
    await writeFile(join(bundle, 'suite.json'), JSON.stringify(stale, null, 2) + '\n');
    const verdict = await cellBundleVerdict(bundle, gameId, tierId, seeds, {
      expectedManifestSha256: manifestSha256(suite),
    });
    assert.equal(verdict.complete, false);
    assert.match(verdict.reason, /suite manifest .* differs from the expected/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a bundle with no readable suite.json is NOT complete when a manifest is expected', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cell-complete-'));
  try {
    const bundle = await makeBundle(root, gameId, tierId, seeds, {
      versions: Object.fromEntries(seeds.map((s) => [s, currentVersion])),
    });
    const { suite } = tierSuite(gameId, tierId);
    const verdict = await cellBundleVerdict(bundle, gameId, tierId, seeds, {
      expectedManifestSha256: manifestSha256(suite),
    });
    assert.equal(verdict.complete, false);
    assert.match(verdict.reason, /no readable suite\.json manifest/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a bundle whose run.json records a foreign suite manifest is NOT complete', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cell-complete-'));
  try {
    const bundle = await makeBundle(root, gameId, tierId, seeds, {
      versions: Object.fromEntries(seeds.map((s) => [s, currentVersion])),
    });
    const { suite } = tierSuite(gameId, tierId);
    await writeFile(join(bundle, 'suite.json'), JSON.stringify(suite, null, 2) + '\n');
    await writeFile(
      join(bundle, 'run.json'),
      JSON.stringify({
        format: 'playkit-gauntlet-run/1',
        suite: { id: suite.id, manifestSha256: 'f'.repeat(64) },
        agent: { id: 'dial-engine-p1', track: 'baseline' },
        total: { episodes: seeds.length },
      }) + '\n'
    );
    const verdict = await cellBundleVerdict(bundle, gameId, tierId, seeds, {
      expectedManifestSha256: manifestSha256(suite),
    });
    assert.equal(verdict.complete, false);
    assert.match(verdict.reason, /run\.json suite manifest/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a bundle with the matching manifest, run.json hash, and current trajectories IS complete', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cell-complete-'));
  try {
    const bundle = await makeBundle(root, gameId, tierId, seeds, {
      versions: Object.fromEntries(seeds.map((s) => [s, currentVersion])),
    });
    const { suite } = tierSuite(gameId, tierId);
    await writeFile(join(bundle, 'suite.json'), JSON.stringify(suite, null, 2) + '\n');
    await writeFile(
      join(bundle, 'run.json'),
      JSON.stringify({
        format: 'playkit-gauntlet-run/1',
        suite: { id: suite.id, manifestSha256: manifestSha256(suite) },
        agent: { id: 'dial-engine-p1', track: 'baseline' },
        total: { episodes: seeds.length },
      }) + '\n'
    );
    const verdict = await cellBundleVerdict(bundle, gameId, tierId, seeds, {
      expectedManifestSha256: manifestSha256(suite),
    });
    assert.equal(verdict.complete, true, verdict.reason);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// --- Trajectory identity and shape (Codex #4303998319) ---------------------

/**
 * Rewrite one trajectory file in the fixture bundle with the given fields,
 * starting from the full-shape trajectory makeBundle already wrote.
 *
 * @param {string} bundle
 * @param {string} seed
 * @param {Record<string, *>} overrides merged into the parsed trajectory
 */
async function patchTrajectory(bundle, seed, overrides) {
  const path = join(bundle, gameId, tierId, `${seed}.json`);
  const trajectory = JSON.parse(await readFile(path, 'utf8'));
  await writeFile(path, JSON.stringify({ ...trajectory, ...overrides }) + '\n');
}

const fullShape = {
  versions: Object.fromEntries(seeds.map((s) => [s, currentVersion])),
};

test('a trajectory with a foreign game id, tier, or seed label is NOT complete', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cell-complete-'));
  try {
    const bundle = await makeBundle(root, gameId, tierId, seeds, fullShape);
    await patchTrajectory(bundle, seeds[0], { tier: 'classic' });
    const verdict = await cellBundleVerdict(bundle, gameId, tierId, seeds);
    assert.equal(verdict.complete, false);
    assert.match(verdict.reason, /misfiled or mislabeled/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a trajectory with no agent object (no seat) is NOT complete', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cell-complete-'));
  try {
    const bundle = await makeBundle(root, gameId, tierId, seeds, fullShape);
    await patchTrajectory(bundle, seeds[0], { agent: undefined });
    const verdict = await cellBundleVerdict(bundle, gameId, tierId, seeds);
    assert.equal(verdict.complete, false);
    assert.match(verdict.reason, /no integer agent seat/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a trajectory with no end.agentActions is NOT complete', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cell-complete-'));
  try {
    const bundle = await makeBundle(root, gameId, tierId, seeds, fullShape);
    await patchTrajectory(bundle, seeds[0], { end: { outcome: null } });
    const verdict = await cellBundleVerdict(bundle, gameId, tierId, seeds);
    assert.equal(verdict.complete, false);
    assert.match(verdict.reason, /no non-negative integer end\.agentActions/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a solved efficiency trajectory without usable par/actions is NOT complete', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cell-complete-'));
  try {
    const bundle = await makeBundle(root, gameId, tierId, seeds, fullShape);
    // mastermind/mini is an efficiency tier; solved with no par crashes
    // rawEpisodeScore downstream.
    await patchTrajectory(bundle, seeds[0], {
      end: { agentActions: 4, invalidActions: 0, outcome: { solved: true } },
    });
    const verdict = await cellBundleVerdict(bundle, gameId, tierId, seeds);
    assert.equal(verdict.complete, false);
    assert.match(verdict.reason, /claims solved without usable par\/actions/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
