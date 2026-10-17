import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const gauntletRoot = resolve(here, '../..');

const SCRIPTS = {
  pilot: join(gauntletRoot, 'journeys/pilot/pilot.sh'),
  separationRun: join(gauntletRoot, 'journeys/pilot/separation-run.sh'),
  rehearse: join(gauntletRoot, 'journeys/pilot/rehearse.sh'),
  separation: join(gauntletRoot, 'journeys/separation/separation.sh'),
  release: join(gauntletRoot, 'journeys/release/release.sh'),
};

/**
 * Smallest legal suite: the pilot-1seed manifest's tictactoe/random-opponent
 * tier with its first public seed — one episode per arm. Schema-exact (copied
 * fields from a committed option file, never hand-rolled).
 */
/** @param {string} dir */
function writeMiniSuite(dir, name = 'suite-mini.json') {
  const full = JSON.parse(
    readFileSync(join(gauntletRoot, 'studies/separation-pilot/outputs/suites/suite.pilot-1seed.json'), 'utf8')
  );
  const game = full.games.find((/** @type {{ id: string }} */ g) => g.id === 'tictactoe');
  const mini = {
    ...full,
    games: [
      {
        ...game,
        tiers: game.tiers
          .filter((/** @type {{ id: string; seeds: string[] }} */ t) => t.id === 'random-opponent')
          .map((/** @type {{ seeds: string[] }} */ t) => ({ ...t, seeds: t.seeds.slice(0, 1) })),
      },
    ],
  };
  const p = join(dir, name);
  writeFileSync(p, JSON.stringify(mini));
  return p;
}

function freshDir() {
  return mkdtempSync(join(tmpdir(), 'pilot-scripts-'));
}

/**
 * Run a journey script from a caller cwd with ambient keys stripped.
 * @param {string} script
 * @param {string[]} args
 * @param {{ cwd: string, env?: Record<string, string | undefined>, timeoutMs?: number }} opts
 */
function runScript(script, args, { cwd, env = {}, timeoutMs = 120000 }) {
  const clean = { ...process.env };
  for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY']) delete clean[k];
  return spawnSync('bash', [script, ...args], {
    encoding: 'utf8',
    cwd,
    env: { ...clean, ...env },
    timeout: timeoutMs,
  });
}

test('journey shell scripts parse (bash -n)', () => {
  for (const [name, script] of Object.entries(SCRIPTS)) {
    execFileSync('bash', ['-n', script], { encoding: 'utf8' });
  }
});

test('pilot.sh resolves a caller-relative SUITE and PILOT_OUT before changing directory', { timeout: 120000 }, () => {
  const work = freshDir();
  const suite = writeMiniSuite(work);
  const rel = suite.slice(work.length + 1); // caller-relative path
  // Loopback base with no listener: the estimate is free and must succeed on
  // the absolutized suite; the run step then fails fast on ECONNREFUSED.
  const r = runScript(
    SCRIPTS.pilot,
    [rel, 'anthropic/claude-opus-5-5', 'high', '999', '1', 'http://127.0.0.1:9'],
    { cwd: work, env: { PILOT_OUT: 'out-rel' }, timeoutMs: 110000 }
  );
  const out = `${r.stdout}\n${r.stderr}`;
  assert.ok(out.includes('PRE-FLIGHT'), `pilot.sh never reached pre-flight (suite unresolved from caller cwd)\n${out}`);
  assert.ok(
    existsSync(join(work, 'out-rel', 'estimate', 'estimate.json')),
    `estimate output not under the caller's relative PILOT_OUT\n${out}`
  );
  assert.ok(r.status !== 0, 'run against a dead loopback port must fail loudly');
});

test('separation-run.sh refuses a LIVE run up front when any arm key is missing', () => {
  const work = freshDir();
  const suite = writeMiniSuite(work);
  const r = runScript(
    SCRIPTS.separationRun,
    [suite, '5', '2'],
    { cwd: work, env: { OPENAI_API_KEY: 'test-dummy' } }
  );
  const err = r.stderr || '';
  assert.match(err, /refusing to start LIVE arms/, 'separation-run must pre-check every arm key before the first arm');
  assert.match(err, /ANTHROPIC_API_KEY/, `must name the missing anthropic key\n${err}`);
  assert.match(err, /GEMINI_API_KEY/, `must name the missing gemini key\n${err}`);
  assert.doesNotMatch(err, /pilot: refusing/, 'must refuse before any pilot.sh arm is invoked');
});

test('separation-run.sh --rehearse completes all four arms on the mini suite (faults off)', { timeout: 420000 }, () => {
  const work = freshDir();
  const suite = writeMiniSuite(work);
  const r = runScript(
    SCRIPTS.separationRun,
    [suite, '999', '1', '--rehearse'],
    {
      cwd: work,
      timeoutMs: 400000,
      env: {
        SEPARATION_RUN_OUT: join(work, 'out'),
        STUB_RATE_LIMIT_EVERY: '0',
        STUB_OVERLOAD_EVERY: '0',
        STUB_REFUSE_EVERY: '0',
        STUB_TRUNCATE_EVERY: '0',
      },
    }
  );
  const out = `${r.stdout}\n${r.stderr}`;
  assert.equal(r.status, 0, `rehearsal must complete\n--- stdout ---\n${r.stdout?.slice(-4000)}\n--- stderr ---\n${r.stderr?.slice(-2000)}`);
  assert.match(out, /separation-run: COMPLETE/);
  for (const arm of ['anthropic-claude-opus-5-5', 'openai-gpt-6-astra', 'openai-chat-gemini-4-argon', 'random']) {
    assert.ok(existsSync(join(work, 'out', arm, 'run', 'run.json')), `run.json missing for ${arm}`);
  }
});

test('separation-run.sh cap guard refuses loudly when the cap cannot afford one call', { timeout: 180000 }, () => {
  const work = freshDir();
  const suite = writeMiniSuite(work);
  const r = runScript(
    SCRIPTS.separationRun,
    [suite, '0.000001', '1', '--rehearse'],
    { cwd: work, timeoutMs: 160000, env: { SEPARATION_RUN_OUT: join(work, 'out') } }
  );
  const err = `${r.stderr || ''}`;
  assert.ok(r.status !== 0, 'a cap that cannot afford one call must fail');
  assert.match(err, /leaves no headroom/, `must print the loud no-headroom refusal\n${r.stdout?.slice(-2000)}\n${err}`);
});

test('separation.sh stalls the stub from the selected clone, not the caller checkout', () => {
  const s = readFileSync(SCRIPTS.separation, 'utf8');
  assert.match(s, /\$SRC\/journeys\/separation\/stalled-stub\.mjs/, 'stage D must run the clone copy');
  assert.doesNotMatch(s, /\$here\/stalled-stub\.mjs/, 'the caller checkout must not be used');
});
