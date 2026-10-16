/**
 * Integration: the burst-12 CLI polish, as real CLI subprocesses.
 *
 * 1. Baseline sweep — every registered game plays one CLI episode per baseline
 *    kind (greedy, engine) through `gauntlet play`, or the CLI refuses the
 *    spec naming why that game ships none. No game is silently skipped.
 * 2. parseArgs — a declared boolean flag never consumes the next token, so
 *    `--dry-run model:...` fails loudly pointing at --agent instead of eating
 *    the spec; an unknown flag fails naming the flags the command takes.
 * 3. `gauntlet --help` (and -h, and `gauntlet help`) print usage on stdout and
 *    exit 0, not 2.
 * 4. `gauntlet play` prints a usage line (calls, tokens, cost, mean latency)
 *    for model agents: a priced run shows a dollar figure, an unpriced run
 *    shows `cost unknown` (never $0), and baseline and dry-run output stay
 *    exactly as they were — no usage line.
 *
 * @module
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listGames } from '../../games/index.js';
import { findGtpBinary } from '../../engines/gtp/client.js';
import { startStubServer, sendJson } from '../../harness/stub-server.js';

const gauntletRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const cli = join(gauntletRoot, 'cli', 'gauntlet.js');

/**
 * Run the CLI as a subprocess and await its exit. Async spawn keeps this
 * process's event loop free — the stub provider lives here, and a spawnSync
 * would block its responses while the child waits on them.
 *
 * @param {...string} args
 * @returns {Promise<{ status: number, stdout: string, stderr: string }>}
 */
async function gauntlet(...args) {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ stdout, stderr, status: code ?? -1 });
    });
  });
}

test('baseline sweep: every registered game plays both baselines or the CLI names why it has none', { timeout: 20 * 60 * 1000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'gauntlet-cli-polish-sweep-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  /** @type {string[]} */
  const played = [];
  /** @type {string[]} */
  const refused = [];
  for (const game of listGames()) {
    const tier = game.spec.tiers[0];
    for (const kind of /** @type {const} */ (['greedy', 'engine'])) {
      const spec = `baseline:${game.spec.id}:${kind}`;
      // Go's engine baseline is GNU Go itself; without a binary it is
      // skipped out loud, the same gate games/go/game.test.js uses.
      if (spec === 'baseline:go:engine' && !findGtpBinary()) {
        console.error(`[skip] ${spec}: no GNU Go binary found (set GAUNTLET_GNUGO or install gnugo)`);
        continue;
      }
      const out = join(root, `${game.spec.id}-${kind}.json`);
      const result = await gauntlet(
        'play',
        '--game', game.spec.id,
        '--tier', tier.id,
        '--agent', spec,
        '--out', out,
      );
      if (result.status === 0) {
        // One run is one entry: the trajectory carries the spec text as the
        // agent id, never a game packet's tier-resolved id.
        const trajectory = JSON.parse(readFileSync(out, 'utf8'));
        assert.equal(trajectory.agent.id, spec, `${spec} lost its spec id`);
        assert.match(result.stdout, /^game\s+/m);
        assert.match(result.stdout, /^outcome\s+/m);
        played.push(spec);
      } else {
        // A game without baselines is refused with the reason spelled out —
        // not a crash, not an "unknown agent spec" shrug.
        assert.match(
          result.stderr,
          /ships no baseline agents/,
          `${spec} must name why it has none:\n${result.stderr}`
        );
        refused.push(spec);
      }
    }
  }
  // The sweep must actually exercise the baseline table: most registered
  // games ship both kinds, so a near-empty `played` list means the sweep
  // broke, not the games.
  assert.ok(
    played.length >= 20,
    `expected most games to play both baselines, played ${played.length}:\n${played.join('\n')}`
  );
});

test('--dry-run before the agent spec fails loudly instead of eating it', async () => {
  const result = await gauntlet(
    'play',
    '--game', 'tictactoe',
    '--tier', 'random-opponent',
    '--dry-run', 'model:anthropic/claude-opus-4-5',
    '--script', 'nope.js',
  );
  assert.notEqual(result.status, 0);
  // The spec lands as a positional, not as --dry-run's value, and the error
  // points the researcher at the flag that actually takes it.
  assert.match(result.stderr, /unexpected positional "model:anthropic\/claude-opus-4-5"/);
  assert.match(result.stderr, /--agent <spec>/);
});

test('unknown flag fails naming the flags the command takes', async () => {
  const result = await gauntlet(
    'play',
    '--game', 'tictactoe',
    '--tier', 'random-opponent',
    '--seeds', '4',
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /unknown flag "--seeds" for gauntlet play/);
  // The failure lists the flags the command takes (--agent among them).
  assert.match(result.stderr, /--agent/);
  assert.match(result.stderr, /--dry-run/);
});

test('estimate takes --no-probes and --against, and still rejects an unknown flag', { timeout: 2 * 60 * 1000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'gauntlet-estimate-flags-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const suitePath = join(dir, 'suite.json');
  const runDir = join(dir, 'run');
  const built = await gauntlet(
    'suite', 'build', '--split', 'public', '--games', 'tictactoe',
    '--seeds-per-tier', '1', '--out', suitePath,
  );
  assert.equal(built.status, 0, built.stderr);
  const ran = await gauntlet('run', '--suite', suitePath, '--agent', 'random', '--out', runDir, '--limit', '1');
  assert.equal(ran.status, 0, ran.stderr);

  const result = await gauntlet(
    'estimate', '--suite', suitePath, '--agent', 'random',
    '--no-probes', '--against', runDir, '--json',
  );
  assert.equal(result.status, 0, result.stderr);
  const comparison = JSON.parse(result.stdout);
  // --against reached the estimator: the output is a comparison, not an estimate.
  assert.equal(comparison.kind, 'estimate-vs-actual');
  // --no-probes reached it too: with probes, tictactoe's low call count comes
  // from a baseline probe; without them it stays unknown.
  assert.equal(comparison.games[0].gameId, 'tictactoe');
  assert.equal(comparison.games[0].figures.estimated.callsLow, null);

  const rejected = await gauntlet(
    'estimate', '--suite', suitePath, '--agent', 'random', '--probes',
  );
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /unknown flag "--probes" for gauntlet estimate/);
  assert.match(rejected.stderr, /--no-probes/);
  assert.match(rejected.stderr, /--against/);
});

test('--help, -h and `gauntlet help` print usage on stdout and exit 0', async () => {
  for (const argv of [['--help'], ['-h'], ['help']]) {
    const result = await gauntlet(...argv);
    assert.equal(result.status, 0, `gauntlet ${argv.join(' ')} must exit 0`);
    assert.match(result.stdout, /^usage: gauntlet list/m);
    assert.match(result.stdout, /agent specs:/);
  }
});

test('an out-of-range --reasoning-effort names the full accepted set', async () => {
  const result = await gauntlet(
    'play',
    '--game', 'tictactoe',
    '--tier', 'random-opponent',
    '--agent', 'model:openai/gpt-5.2',
    '--reasoning-effort', 'ultra',
  );
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /--reasoning-effort must be low, medium, high, xhigh or max/
  );
});

test('play prints calls, tokens, cost and mean latency for a priced model run', { timeout: 2 * 60 * 1000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'gauntlet-cli-polish-usage-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  // Stub provider: always answers `b2` with 100 in / 10 out tokens. The first
  // b2 is legal; the runner's default invalid-action policy ends the episode
  // after three repeats — every one of them a real provider call with usage.
  const stub = await startStubServer(
    /** @param {import('node:http').IncomingMessage} req @param {import('node:http').ServerResponse} res @param {*} body */
    (req, res, body) => {
      sendJson(res, 200, {
        id: 'chatcmpl-stub',
        object: 'chat.completion',
        created: 1,
        model: /** @type {{model?: string}} */ (body)?.model ?? 'stub-model',
        choices: [
          { index: 0, message: { role: 'assistant', content: 'b2' }, finish_reason: 'stop' },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 10 },
      });
    }
  );
  t.after(() => stub.close());

  const pricesFile = join(root, 'prices.json');
  // openai-chat/stub-model at $10/MTok in, $30/MTok out: exactly $0.0013/call.
  writeFileSync(
    pricesFile,
    JSON.stringify(
      { 'openai-chat/stub-model': { inputPerMTok: 10, outputPerMTok: 30, source: 'stub', checked: '2026-10-16' } },
      null,
      2
    )
  );

  const out = join(root, 'episode.json');
  const result = await gauntlet(
    'play',
    '--game', 'tictactoe',
    '--tier', 'random-opponent',
    '--agent', 'model:openai-chat/stub-model',
    '--base-url', stub.url,
    '--api-key-env', 'GAUNTLET_CLI_POLISH_KEY',
    '--prices', pricesFile,
    '--out', out,
  );
  assert.equal(result.status, 0, `play exits clean:\n${result.stdout}\n${result.stderr}`);
  assert.match(
    result.stdout,
    /^usage\s+\d+ calls? · [\d,]+ in \/ [\d,]+ out tok · \$[\d.]+ · [\d.]+ (s|ms)\/call$/m
  );
  // A priced run never renders its cost as unknown, and the dollar figure is
  // the real sum, not a per-call quote.
  assert.doesNotMatch(result.stdout, /cost unknown/);
  const trajectory = JSON.parse(readFileSync(out, 'utf8'));
  // Only the agent's provider calls carry usage; the random opponent's steps
  // have none and are not calls.
  const callSteps = trajectory.steps.filter((/** @type {*} */ s) => s.usage);
  assert.ok(callSteps.length > 0, 'the agent steps record provider usage');
  const match = /^usage\s+(\d+) calls? · ([\d,]+) in \/ ([\d,]+) out tok · \$([\d.]+) ·/m.exec(
    result.stdout
  );
  assert.ok(match, 'the usage line parses');
  assert.equal(Number(match[1]), callSteps.length, 'calls equals the provider-call step count');
  const expectedIn = callSteps.reduce(
    (/** @type {number} */ sum, /** @type {*} */ s) => sum + (s.usage.inputTokens ?? 0),
    0
  );
  assert.equal(match[2], expectedIn.toLocaleString('en-US'), 'input tokens are the call sum');
});

test('an unpriced model run prints cost unknown, never $0', { timeout: 2 * 60 * 1000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'gauntlet-cli-polish-unpriced-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const stub = await startStubServer(
    /** @param {import('node:http').IncomingMessage} req @param {import('node:http').ServerResponse} res @param {*} body */
    (req, res, body) => {
      sendJson(res, 200, {
        id: 'chatcmpl-stub',
        object: 'chat.completion',
        created: 1,
        model: /** @type {{model?: string}} */ (body)?.model ?? 'stub-model',
        choices: [
          { index: 0, message: { role: 'assistant', content: 'b2' }, finish_reason: 'stop' },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 10 },
      });
    }
  );
  t.after(() => stub.close());

  const result = await gauntlet(
    'play',
    '--game', 'tictactoe',
    '--tier', 'random-opponent',
    '--agent', 'model:openai-chat/stub-model',
    '--base-url', stub.url,
    '--api-key-env', 'GAUNTLET_CLI_POLISH_KEY',
  );
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(
    result.stdout,
    /^usage\s+\d+ calls? · [\d,]+ in \/ [\d,]+ out tok · cost unknown · /m
  );
});

test('baseline and dry-run play output stays as it was — no usage line', { timeout: 2 * 60 * 1000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'gauntlet-cli-polish-quiet-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const baseline = await gauntlet(
    'play',
    '--game', 'mastermind',
    '--tier', 'classic',
    '--agent', 'baseline:mastermind:greedy',
  );
  assert.equal(baseline.status, 0, `${baseline.stdout}\n${baseline.stderr}`);
  assert.doesNotMatch(baseline.stdout, /^usage\s/m);

  const scriptFile = join(root, 'replies.json');
  // Three invalid replies end the episode under the runner's default
  // forfeit-after-three-invalids policy — a dry run that never dials a server.
  writeFileSync(scriptFile, JSON.stringify(['zzz', 'zzz', 'zzz']));
  const dry = await gauntlet(
    'play',
    '--game', 'tictactoe',
    '--tier', 'random-opponent',
    '--agent', 'model:openai-chat/stub-model',
    '--dry-run', '--script', scriptFile,
  );
  assert.equal(dry.status, 0, `${dry.stdout}\n${dry.stderr}`);
  assert.doesNotMatch(dry.stdout, /^usage\s/m);
});
