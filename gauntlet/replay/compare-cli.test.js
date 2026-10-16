import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { runEpisode } from '../core/runner.js';
import { getGame } from '../games/index.js';
import { createScriptedAgent } from '../harness/dry-run.js';

const execFile = promisify(execFileCallback);
const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, 'cli.js');

/** @type {Record<string, string>} */
const FIXTURES = {
  mastermind: join(here, 'fixtures/mastermind-forfeit.json'),
};

const tempRoot = mkdtempSync(join(tmpdir(), 'gauntlet-replay-compare-cli-'));
test.after(() => rmSync(tempRoot, { recursive: true, force: true }));

/**
 * Run the CLI and capture its exit code even when nonzero.
 *
 * @param {string[]} args
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
 */
async function runCli(args) {
  try {
    const { stdout, stderr } = await execFile(process.execPath, [CLI, ...args], {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    });
    return { code: 0, stdout, stderr };
  } catch (/** @type {*} */ err) {
    return {
      code: typeof err.code === 'number' ? err.code : 1,
      stdout: typeof err.stdout === 'string' ? err.stdout : '',
      stderr: typeof err.stderr === 'string' ? err.stderr : String(err),
    };
  }
}

// A fixed replay that never starves: every entry is a legal cell name and the
// episode ends (win, draw or the 20-attempt budget) long before the script
// runs out. Independent of committed fixtures, so game-version recalibration
// cannot break these tests.
const OPENING = [
  'a1', 'c1', 'b2', 'c3', 'a3', 'b1', 'c2', 'b3', 'a1', 'b2',
  'c1', 'a2', 'a3', 'c3', 'b1', 'b3', 'c2', 'a2', 'a1', 'b1',
  'c2', 'a3', 'b2', 'c3',
];
const DIVERGING = ['c3', ...OPENING.slice(1)];

/**
 * @param {string[]} script
 * @param {string} seed
 * @returns {Promise<*>}
 */
async function runScripted(script, seed) {
  return runEpisode({
    game: getGame('tictactoe'),
    tierId: 'perfect-opponent',
    seed,
    agent: createScriptedAgent(script),
  });
}

// Episode A follows OPENING; episode B opens on a different legal cell, so
// the two diverge at step 0. Both record the same episode identity, which is
// exactly what --against is for (they live in separate files; a single run
// directory holds one episode per identity).
const episodeA = await runScripted(OPENING, '0');
const episodeB = await runScripted(DIVERGING, '0');
// A second episode of the same game but a different seed, for the unpaired
// side of the bundle comparison.
const episodeOtherSeed = await runScripted(OPENING, '7');

const fileA = join(tempRoot, 'a.json');
const fileB = join(tempRoot, 'b.json');
writeFileSync(fileA, JSON.stringify(episodeA));
writeFileSync(fileB, JSON.stringify(episodeB));

test('--against on the same file reports an identical replay', async () => {
  const { code, stdout, stderr } = await runCli([fileA, '--against', fileA]);
  assert.equal(code, 0, stderr);
  assert.ok(stdout.includes('PlayKit Gauntlet replay compare'));
  assert.ok(stdout.includes('the two replays are identical'));

  const json = await runCli([fileA, '--against', fileA, '--format', 'json']);
  assert.equal(json.code, 0, json.stderr);
  const payload = JSON.parse(json.stdout);
  assert.equal(payload.format, 'playkit-gauntlet-replay-compare/1');
  assert.equal(payload.mode, 'episode');
  assert.equal(payload.identical, true);
  assert.equal(payload.divergence, null);
});

test('--against reports the first divergence with both observations', async () => {
  const { code, stdout, stderr } = await runCli([fileA, '--against', fileB]);
  assert.equal(code, 0, stderr);
  // The agent's seat alternates with the seed, so the divergence step number
  // is not fixed — match the shape, then the step that follows.
  const stepMatch = stdout.match(/first divergence: step (\d+) — actions differ/);
  assert.ok(stepMatch, 'reports the first divergence with the reason');
  const step = stepMatch[1];
  assert.ok(stdout.includes(`A at step ${step}:`));
  assert.ok(stdout.includes(`B at step ${step}:`));
  assert.ok(stdout.includes('observation hash'));
  assert.ok(stdout.includes('reply'), 'both sides show the raw reply');

  const json = await runCli([fileA, '--against', fileB, '--format', 'json']);
  assert.equal(json.code, 0, json.stderr);
  const payload = JSON.parse(json.stdout);
  assert.equal(payload.identical, false);
  assert.equal(payload.divergence.index, Number(step));
  assert.equal(payload.divergence.reason, 'actions-differ');
  assert.notEqual(payload.divergence.a.canonical, payload.divergence.b.canonical);
});

test('--against refuses episodes that are not the same episode', async () => {
  const { code, stdout, stderr } = await runCli([fileA, '--against', FIXTURES.mastermind]);
  assert.equal(code, 1);
  assert.equal(stdout, '');
  assert.match(stderr, /refused to compare: game/);
});

test('--bundles compares two run directories episode by episode', async () => {
  const dirA = join(tempRoot, 'run-a');
  const dirB = join(tempRoot, 'run-b');
  mkdirSync(join(dirA, 'nested'), { recursive: true });
  mkdirSync(dirB, { recursive: true });
  writeFileSync(join(dirA, 'a.json'), JSON.stringify(episodeA));
  writeFileSync(join(dirA, 'other-seed.json'), JSON.stringify(episodeOtherSeed));
  writeFileSync(join(dirA, 'run.json'), JSON.stringify({ kind: 'run manifest' }));
  writeFileSync(join(dirB, 'a.json'), JSON.stringify(episodeA));
  writeFileSync(join(dirB, 'suite.json'), JSON.stringify({ kind: 'suite manifest' }));

  const { code, stdout, stderr } = await runCli(['--bundles', dirA, dirB, '--format', 'json']);
  assert.equal(code, 0, stderr);
  const payload = JSON.parse(stdout);
  assert.equal(payload.format, 'playkit-gauntlet-replay-compare/1');
  assert.equal(payload.mode, 'bundle');
  assert.equal(payload.bundles.a.episodes, 2);
  assert.equal(payload.bundles.b.episodes, 1);
  assert.equal(payload.pairs.length, 1);
  assert.equal(payload.pairs[0].verdict, 'verified');
  assert.equal(payload.unpaired.a.length, 1, 'the other-seed episode has no B side');
  assert.equal(payload.unpaired.b.length, 0);
  assert.equal(payload.refused.length, 0);
  assert.ok(payload.ignored.includes(join(dirA, 'run.json')));
  assert.ok(payload.ignored.includes(join(dirB, 'suite.json')));
  assert.equal(payload.games.length, 1);
  assert.equal(payload.games[0].game, 'tictactoe');
  assert.equal(payload.games[0].pairs, 1);

  const text = await runCli(['--bundles', dirA, dirB]);
  assert.equal(text.code, 0, text.stderr);
  assert.ok(text.stdout.includes('PlayKit Gauntlet bundle compare'));
  assert.ok(text.stdout.includes('per-game paired results'));
  assert.ok(text.stdout.includes('unpaired, only in A (1):'));
  assert.ok(text.stdout.includes('ignored files (2):'));
});

test('compare flags reject invalid combinations with the usage text', async () => {
  const stepWithAgainst = await runCli([fileA, '--against', fileB, '--step', '1']);
  assert.equal(stepWithAgainst.code, 2);
  assert.match(stepWithAgainst.stderr, /--step only works in single-trajectory mode/);

  const stepWithBundles = await runCli(['--bundles', tempRoot, tempRoot, '--step', '1']);
  assert.equal(stepWithBundles.code, 2);
  assert.match(stepWithBundles.stderr, /--step only works in single-trajectory mode/);

  const bothModes = await runCli([fileA, '--against', fileB, '--bundles', tempRoot, tempRoot]);
  assert.equal(bothModes.code, 2);
  assert.match(bothModes.stderr, /--bundles cannot be combined with --against/);

  const oneBundleDir = await runCli(['--bundles', tempRoot]);
  assert.equal(oneBundleDir.code, 2);
  assert.match(oneBundleDir.stderr, /--bundles needs a value|unexpected extra argument/);

  const missingDir = await runCli(['--bundles', join(tempRoot, 'does-not-exist'), tempRoot]);
  assert.equal(missingDir.code, 2);
  assert.match(missingDir.stderr, /cannot read|no such file|does-not-exist/);
});
