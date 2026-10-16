import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  // Two-player, terminal: Qwen2.5-1.5B loses to the perfect minimax opponent.
  tictactoe: join(
    here,
    '../studies/model-separation/runs/qwen2.5-1.5b/tictactoe/perfect-opponent/tictactoe/perfect-opponent/public/0.json'
  ),
  // Solitaire forfeit on three consecutive invalid replies (Qwen2.5-1.5B).
  mastermind: join(
    here,
    '../studies/model-separation/runs/qwen2.5-1.5b/mastermind/classic/mastermind/classic/public/0.json'
  ),
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
  assert.ok(stdout.includes('tictactoe v1.1.0 · tier perfect-opponent'));
  assert.ok(stdout.includes('minimax-perfect'));
  assert.ok(stdout.includes('replay-verified ok'));
  assert.ok(stdout.includes('turn 1 · step 0'));
  assert.ok(stdout.includes('turn 3 · step 5'), 'all six steps are shown');
  assert.ok(
    stdout.includes('outcome: seat 1 (O) won with three in a row'),
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
  assert.equal(payload.frames.length, 6);
  assert.ok(payload.frames[0].observation.text.includes('Tic-Tac-Toe'));
  // Replies are carried verbatim — the UI shows exactly what the model sent.
  const trajectory = JSON.parse(readFileSync(FIXTURES.tictactoe, 'utf8'));
  assert.deepEqual(
    payload.frames.map((/** @type {*} */ f) => f.reply.text),
    trajectory.steps.map((/** @type {*} */ s) => s.reply.text)
  );
});

test('--step N shows exactly one turn', async () => {
  const { code, stdout, stderr } = await runCli([
    FIXTURES.mastermind,
    '--step',
    '3',
  ]);
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
  // Build a real, verified episode whose replies are long: re-run the
  // committed tictactoe episode with a scripted agent that rambles before
  // giving the same legal actions. Same seed, so the opponent moves match.
  const recorded = JSON.parse(readFileSync(FIXTURES.tictactoe, 'utf8'));
  const ramble = 'I should think about the board and centre control. '.repeat(4);
  const script = recorded.steps
    .filter((/** @type {*} */ s) => s.by === 'agent')
    .map((/** @type {*} */ s) => `${ramble}\n${s.action}`);
  const trajectory = await runEpisode({
    game: getGame('tictactoe'),
    tierId: 'perfect-opponent',
    seed: recorded.seed,
    agent: createScriptedAgent(script),
  });
  const file = join(tempRoot, 'long-reply.json');
  writeFileSync(file, JSON.stringify(trajectory));

  const full = await runCli([file]);
  assert.equal(full.code, 0, full.stderr);
  assert.ok(full.stdout.includes(ramble), 'default shows replies in full');

  const cut = await runCli([file, '--max-reply-chars', '40']);
  assert.equal(cut.code, 0, cut.stderr);
  assert.ok(cut.stdout.includes(ramble.slice(0, 40)));
  assert.ok(!cut.stdout.includes(ramble.slice(40, 80)), 'the tail is cut');
  assert.match(cut.stdout, /\[\+\d+ chars cut/);

  const json = await runCli([file, '--format', 'json', '--max-reply-chars', '40']);
  assert.equal(json.code, 0, json.stderr);
  const parsed = JSON.parse(json.stdout);
  assert.ok(
    parsed.frames
      .filter((/** @type {*} */ f) => f.by === 'agent')
      .every((/** @type {*} */ f) => f.reply.text.includes(ramble)),
    'json frames always carry the full reply'
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

test('usage errors exit 2 with the usage text', async () => {
  const missing = await runCli([]);
  assert.equal(missing.code, 2);
  assert.match(missing.stderr, /usage: node replay\/cli\.js/);

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
