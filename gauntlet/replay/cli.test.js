import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, 'cli.js');

// Fixtures are generated deterministically at the CURRENT game versions by
// replay/fixtures/generate.mjs (a scripted dry-run model agent with
// model-shaped replies — a long ramble, an unparseable guess). Regenerate with
// `node replay/fixtures/generate.mjs`; the script is byte-identical across
// runs, and the tests never depend on studies/ or reports/ recordings, so a
// game-version bump cannot rot them again.
/** @type {Record<string, string>} */
const FIXTURES = {
  // Two-player, terminal: the fixture agent loses to the perfect minimax
  // opponent; every reply parses.
  tictactoe: join(here, 'fixtures/tictactoe-perfect-opponent.json'),
  // Solitaire, forfeit-invalid: three valid guesses, then three consecutive
  // unparseable ones.
  mastermind: join(here, 'fixtures/mastermind-forfeit.json'),
};

const tempRoot = mkdtempSync(join(tmpdir(), 'gauntlet-replay-cli-'));
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

test('text format shows the header, every turn, and the outcome', async () => {
  const { code, stdout, stderr } = await runCli([FIXTURES.tictactoe]);
  assert.equal(code, 0, stderr);
  assert.ok(stdout.includes('PlayKit Gauntlet episode replay'));
  assert.ok(stdout.includes('tictactoe v1.2.0 · tier perfect-opponent'));
  assert.ok(stdout.includes('minimax-perfect'));
  assert.ok(stdout.includes('replay-verified ok'));
  assert.ok(stdout.includes('turn 1 · step 0'));
  assert.ok(stdout.includes('turn 3 · step 4'), 'all five steps are shown');
  assert.ok(
    stdout.includes('outcome: seat 0 (X) won with three in a row'),
    'the end outcome appears in the header'
  );
  assert.ok(stdout.includes('referee: valid'), 'parse verdicts are shown');
  assert.ok(stdout.includes('observation:'));
  assert.ok(stdout.includes('reply:'));
});

test('json format prints the frames payload for the UI pass', async () => {
  const { code, stdout, stderr } = await runCli([FIXTURES.tictactoe, '--format', 'json']);
  assert.equal(code, 0, stderr);
  const payload = JSON.parse(stdout);
  assert.equal(payload.format, 'playkit-gauntlet-replay-frames/1');
  assert.equal(payload.game.id, 'tictactoe');
  assert.equal(payload.end.reason, 'terminal');
  assert.equal(payload.frames.length, 5);
  assert.ok(payload.frames[0].observation.text.includes('Tic-Tac-Toe'));
  // Replies are carried verbatim — the UI shows exactly what the model sent.
  const trajectory = JSON.parse(readFileSync(FIXTURES.tictactoe, 'utf8'));
  assert.deepEqual(
    payload.frames.map((/** @type {*} */ f) => f.reply.text),
    trajectory.steps.map((/** @type {*} */ s) => s.reply.text)
  );
});

test('--step N shows exactly one turn', async () => {
  // Step 3 is the first unparseable guess in the forfeit fixture.
  const { code, stdout, stderr } = await runCli([FIXTURES.mastermind, '--step', '3']);
  assert.equal(code, 0, stderr);
  assert.ok(stdout.includes('turn 4 · step 3'));
  assert.ok(stdout.includes('INVALID'));
  assert.ok(!stdout.includes('turn 1 · step 0'), 'no other turn is printed');
});

test('--step N filters the json frames array', async () => {
  const { code, stdout } = await runCli([
    FIXTURES.tictactoe,
    '--step',
    '1',
    '--format',
    'json',
  ]);
  assert.equal(code, 0);
  const payload = JSON.parse(stdout);
  assert.equal(payload.frames.length, 1);
  assert.equal(payload.frames[0].index, 1);
});

test('--max-reply-chars truncates long replies in text, never in json', async () => {
  // The fixture's first reply is a model-shaped ramble four sentences long,
  // so the same file exercises the full and the truncated view.
  const recorded = JSON.parse(readFileSync(FIXTURES.tictactoe, 'utf8'));
  const ramble = /** @type {string} */ (
    recorded.steps.find((/** @type {*} */ s) => s.by === 'agent').reply.text
  ).split('\n')[0];
  assert.ok(ramble.length >= 40, 'the first fixture reply is long enough to cut');

  const full = await runCli([FIXTURES.tictactoe]);
  assert.equal(full.code, 0, full.stderr);
  assert.ok(full.stdout.includes(ramble), 'default shows replies in full');

  const cut = await runCli([FIXTURES.tictactoe, '--max-reply-chars', '40']);
  assert.equal(cut.code, 0, cut.stderr);
  assert.ok(cut.stdout.includes(ramble.slice(0, 40)));
  assert.ok(!cut.stdout.includes(ramble.slice(40, 80)), 'the tail is cut');
  assert.match(cut.stdout, /\[\+\d+ chars cut/);

  const json = await runCli([FIXTURES.tictactoe, '--format', 'json', '--max-reply-chars', '40']);
  assert.equal(json.code, 0, json.stderr);
  const parsed = JSON.parse(json.stdout);
  assert.deepEqual(
    parsed.frames.map((/** @type {*} */ f) => f.reply.text),
    recorded.steps.map((/** @type {*} */ s) => s.reply.text),
    'json frames always carry the full reply, truncated nowhere'
  );
});

test('refuses a tampered trajectory with the failing step on stderr, exit 1', async () => {
  const trajectory = JSON.parse(readFileSync(FIXTURES.tictactoe, 'utf8'));
  trajectory.steps[1].action = 'zz9';
  const file = join(tempRoot, 'tampered.json');
  writeFileSync(file, JSON.stringify(trajectory));
  const { code, stdout, stderr } = await runCli([file]);
  assert.equal(code, 1);
  assert.equal(stdout, '');
  assert.match(stderr, /refused to replay/);
  assert.match(stderr, /step 1:/);
});

test('refuses an older-version trajectory, naming both versions, exit 1', async () => {
  // The version guard is what keeps a game-version bump from silently
  // replaying stale episodes: an episode recorded at 1.0.0 must be refused
  // with a message that names the recorded and the current version.
  const trajectory = JSON.parse(readFileSync(FIXTURES.tictactoe, 'utf8'));
  trajectory.game.version = '1.0.0';
  const file = join(tempRoot, 'stale-version.json');
  writeFileSync(file, JSON.stringify(trajectory));
  const { code, stdout, stderr } = await runCli([file]);
  assert.equal(code, 1);
  assert.equal(stdout, '');
  assert.match(stderr, /refused to replay/);
  assert.match(stderr, /1\.0\.0/);
  assert.match(stderr, /1\.2\.0/);
});

test('usage errors exit 2 with the usage text', async () => {
  const missing = await runCli([]);
  assert.equal(missing.code, 2);
  assert.match(missing.stderr, /usage:\n {2}node replay\/cli\.js <trajectory\.json>/);

  const unknownFlag = await runCli([FIXTURES.tictactoe, '--bogus']);
  assert.equal(unknownFlag.code, 2);
  assert.match(unknownFlag.stderr, /--bogus/);

  const outOfRange = await runCli([FIXTURES.tictactoe, '--step', '99']);
  assert.equal(outOfRange.code, 2);
  assert.match(outOfRange.stderr, /outside this episode/);

  const notATrajectory = join(tempRoot, 'not-a-trajectory.json');
  writeFileSync(notATrajectory, JSON.stringify({ hello: 'world' }));
  const notOne = await runCli([notATrajectory]);
  assert.equal(notOne.code, 2);
  assert.match(notOne.stderr, /not a gauntlet trajectory/);
});
