/**
 * Integration: the wave-11 CLI surface, as real CLI subprocesses.
 *
 * 1. `gauntlet replay <trajectory.json>` — the command table's delegate to
 *    replay/cli.js — renders a replay fixture in text format, filters by
 *    `--step`, and emits the `playkit-gauntlet-replay-frames/1` JSON payload.
 * 2. Bad inputs exit 2 with the viewer's usage errors on stderr; a trajectory
 *    that fails replay verification exits 1 naming the problem.
 * 3. `gauntlet run` with the `skill:<p>:<expert-spec>` agent spec produces a
 *    trajectory whose agent id is the dial's own (`dial-<expert id>-p<p*100>`),
 *    replay-verifies through `gauntlet verify`, and renders through
 *    `gauntlet replay` — the two wave-11 pieces composing end to end.
 * 4. Malformed `skill:` specs are loud parse-time errors with exit code 1.
 *
 * @module
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { GAMES } from '../../games/index.js';
import { execFile as execFileCallback } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const gauntletRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = join(gauntletRoot, 'cli', 'gauntlet.js');

// The render tests read an episode the repository keeps current: the replay
// fixtures are recorded by replay/fixtures/generate.mjs at the CURRENT game
// versions and regenerated deterministically after every version bump. These
// tests used to borrow a committed study trajectory instead, which went stale
// twice (tictactoe via reports/first-model-run, then mastermind 1.0.0 via
// studies/model-separation when #108 bumped the game), each time going red
// through no fault of any change — so the borrow now lives only in the
// refusal test below.
const CURRENT_MASTERMIND = join(gauntletRoot, 'replay', 'fixtures', 'mastermind-mixed.json');
const CURRENT_MASTERMIND_TRAJECTORY = JSON.parse(readFileSync(CURRENT_MASTERMIND, 'utf8'));
// Committed at mastermind 1.0.0; the version guard refuses it.
const STALE_MASTERMIND_1_0_0 = join(
  gauntletRoot,
  'studies/model-separation/runs/qwen2.5-1.5b/mastermind/classic/mastermind/classic/public/0.json'
);
// Committed before tictactoe moved on: the version guard refuses it.
const STALE_TICTACTOE = join(
  gauntletRoot,
  'reports/first-model-run/run-qwen/tictactoe/perfect-opponent/tictactoe/perfect-opponent/public/0.json'
);

/**
 * Run the CLI and capture its exit code even when nonzero.
 *
 * @param {...string} args
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
 */
async function gauntlet(...args) {
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

test('gauntlet replay renders a committed episode in text format', async () => {
  const { code, stdout, stderr } = await gauntlet('replay', CURRENT_MASTERMIND);
  assert.equal(code, 0, stderr);
  assert.ok(stdout.includes('PlayKit Gauntlet episode replay'));
  assert.ok(
    stdout.includes(`mastermind v${CURRENT_MASTERMIND_TRAJECTORY.game.version} · tier classic`),
    'the header names the recorded game version and tier of the fixture'
  );
  assert.ok(stdout.includes('replay-verified ok'));
  assert.ok(stdout.includes('turn 1 · step 0'));
  assert.ok(stdout.includes('referee: INVALID'), 'the recorded invalid attempts are shown');
  assert.ok(stdout.includes('referee: valid'));
  assert.ok(stdout.includes('observation:'));
});

test('gauntlet replay --step N shows exactly that step, in text and in json', async () => {
  const text = await gauntlet('replay', CURRENT_MASTERMIND, '--step', '0');
  assert.equal(text.code, 0, text.stderr);
  assert.ok(text.stdout.includes('step 0'));
  assert.ok(!text.stdout.includes('step 1'), 'only the requested step is shown');

  const json = await gauntlet('replay', CURRENT_MASTERMIND, '--step', '0', '--format', 'json');
  assert.equal(json.code, 0, json.stderr);
  const payload = JSON.parse(json.stdout);
  assert.equal(payload.format, 'playkit-gauntlet-replay-frames/1');
  assert.equal(payload.frames.length, 1);
  assert.equal(payload.frames[0].index, 0);
  assert.equal(typeof payload.agentSeat, 'number');
});

test('gauntlet replay --format json emits the full frames payload', async () => {
  const { code, stdout, stderr } = await gauntlet('replay', CURRENT_MASTERMIND, '--format', 'json');
  assert.equal(code, 0, stderr);
  const payload = JSON.parse(stdout);
  assert.equal(payload.format, 'playkit-gauntlet-replay-frames/1');
  const trajectory = CURRENT_MASTERMIND_TRAJECTORY;
  assert.equal(payload.frames.length, trajectory.steps.length);
  assert.equal(payload.agentSeat, trajectory.agent.seat);
  assert.ok(
    payload.game.id === 'mastermind' && payload.game.version === trajectory.game.version,
    'the payload names the fixture\u2019s recorded game and version'
  );
});

test('gauntlet replay usage errors exit 2 with the viewer message on stderr', async () => {
  const noArgs = await gauntlet('replay');
  assert.equal(noArgs.code, 2);
  assert.ok(noArgs.stderr.includes('usage:'), 'usage text accompanies the error');

  const badFormat = await gauntlet('replay', CURRENT_MASTERMIND, '--format', 'xml');
  assert.equal(badFormat.code, 2);
  assert.ok(badFormat.stderr.includes('--format must be "text" or "json"'));

  const badStep = await gauntlet('replay', CURRENT_MASTERMIND, '--step', '-1');
  assert.equal(badStep.code, 2);
  assert.ok(badStep.stderr.includes('--step must be a non-negative integer'));

  const missingFile = await gauntlet('replay', join(tmpdir(), 'no-such-episode.json'));
  assert.equal(missingFile.code, 2);
  assert.ok(missingFile.stderr.includes('cannot read'));
});

test('gauntlet replay refuses a stale trajectory with exit 1', async () => {
  // Both stale cases are committed episodes the version guard correctly
  // refuses: the tictactoe report predates the game's bump, and the
  // model-separation mastermind run is recorded at 1.0.0 — the bump #108
  // shipped is the whole reason the render tests read the fixtures.
  for (const stale of [STALE_TICTACTOE, STALE_MASTERMIND_1_0_0]) {
    const { code, stdout, stderr } = await gauntlet('replay', stale);
    assert.equal(code, 1, 'refused episodes exit 1');
    assert.ok(stderr.includes('replay:'), 'the refusal names the problem on stderr');
    assert.equal(stdout, '');
  }
  // The mastermind refusal names both versions: what the episode recorded and
  // what the game ships now.
  const mm = await gauntlet('replay', STALE_MASTERMIND_1_0_0);
  assert.ok(mm.stderr.includes('recorded game version 1.0.0'));
  assert.ok(
    mm.stderr.includes(`the current game is ${GAMES['mastermind'].spec.version}`)
  );
});

test('gauntlet run with a skill spec records the dial id and replay-verifies', { timeout: 5 * 60 * 1000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'gauntlet-w11-cli-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const suiteFile = join(root, 'suite.json');
  const runDir = join(root, 'run');

  // One game, one seed per tier: the spec scopes the manifest to mastermind.
  const suite = await gauntlet('suite', 'build', '--split', 'public', '--seeds-per-tier', '1', '--games', 'mastermind', '--out', suiteFile);
  assert.equal(suite.code, 0, suite.stderr);

  const run = await gauntlet(
    'run', '--suite', suiteFile,
    '--agent', 'skill:0.5:baseline:mastermind:greedy',
    '--out', runDir,
    '--limit', '1',
    '--concurrency', '1'
  );
  assert.equal(run.code, 0, run.stderr);
  assert.ok(run.stdout.includes('every planned episode has a trajectory'), 'the run completes');

  const trajectories = /** @type {string[]} */ ([]);
  const collect = (/** @type {string} */ dir) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) collect(path);
      else if (name.endsWith('.json') && name !== 'run.json' && name !== 'suite.json' && !name.startsWith('_')) {
        trajectories.push(path);
      }
    }
  };
  collect(runDir);
  // --limit 1 takes one seed per tier; mastermind ships three tiers.
  assert.ok(trajectories.length >= 1, 'the run wrote trajectories');
  for (const path of trajectories) {
    const trajectory = JSON.parse(readFileSync(path, 'utf8'));
    assert.equal(trajectory.agent.id, 'dial-greedy-p50', 'the trajectory records the dial-defined agent id');
    assert.equal(trajectory.agent.track, 'baseline');
  }

  // The produced episodes must pass replay verification like any other.
  const verify = await gauntlet('verify', runDir);
  assert.equal(verify.code, 0, verify.stdout + verify.stderr);

  // …and one of them renders through the replay command.
  const replay = await gauntlet('replay', trajectories[0]);
  assert.equal(replay.code, 0, replay.stderr);
  assert.ok(replay.stdout.includes('dial-greedy-p50'));
  assert.ok(replay.stdout.includes('mastermind'));
});

test('gauntlet play with the dial over the random expert runs offline', { timeout: 2 * 60 * 1000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'gauntlet-w11-dial-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const out = join(root, 'dial.json');
  const result = await gauntlet('play', '--game', 'mastermind', '--tier', 'classic', '--agent', 'skill:1:random', '--out', out);
  assert.equal(result.code, 0, result.stderr);
  const trajectory = JSON.parse(readFileSync(out, 'utf8'));
  assert.equal(trajectory.agent.id, 'dial-random-p100');
  assert.equal(trajectory.agent.track, 'baseline');
});

test('malformed skill specs are loud parse-time errors', { timeout: 2 * 60 * 1000 }, async (t) => {
  const cases = [
    {
      args: ['play', '--game', 'mastermind', '--tier', 'classic', '--agent', 'skill:1.5:baseline:mastermind:greedy'],
      message: 'noise probability must be a number in [0, 1]',
    },
    {
      args: ['play', '--game', 'mastermind', '--tier', 'classic', '--agent', 'skill:abc:baseline:mastermind:greedy'],
      message: 'noise probability must be a number in [0, 1]',
    },
    {
      args: ['play', '--game', 'mastermind', '--tier', 'classic', '--agent', 'skill:0.5:model:anthropic/claude-opus-4-5'],
      message: 'must be "random" or a baseline spec, not a model spec',
    },
    {
      args: ['play', '--game', 'mastermind', '--tier', 'classic', '--agent', 'skill:0.5:nonsense'],
      message: 'must be "random" or "baseline:<game>:<greedy|engine>"',
    },
    {
      args: ['play', '--game', 'mastermind', '--tier', 'classic', '--agent', 'skill:0.5:'],
      message: 'must be "random" or "baseline:<game>:<greedy|engine>"',
    },
    {
      args: ['play', '--game', 'mastermind', '--tier', 'classic', '--agent', 'skill:0.5:baseline:no-such-game:greedy'],
      message: 'unknown game "no-such-game"',
    },
    {
      args: ['play', '--game', 'mastermind', '--tier', 'classic', '--agent', 'skill:0.5:random', '--thinking-budget', '1024'],
      message: 'takes no --dry-run, --script, --prices',
    },
  ];
  for (const { args, message } of cases) {
    const result = await gauntlet(...args);
    assert.equal(result.code, 1, `expected exit 1 for ${args.join(' ')}, stderr: ${result.stderr}`);
    assert.ok(result.stderr.includes(message), `"${result.stderr}" should name "${message}"`);
  }
});
