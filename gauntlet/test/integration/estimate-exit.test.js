/**
 * Integration: `gauntlet estimate` over a suite with an engine-backed tier
 * exits on its own, leaving no engine process behind (PR #102).
 *
 * The estimate plays local baseline probe episodes for unfitted tiers. The go
 * tiers are unfitted: resolveBaseline seats the game's bundled opponent — a
 * GTP GNU Go client holding a child process — as the probe agent. The probe
 * wrapper (runs/estimate.js probeEpisode) did not forward the baseline's
 * dispose(), so the runner's shutdown reached only the wrapper — a no-op —
 * and each probe episode leaked one GNU Go child. A leaked child's open stdio
 * pipe keeps the event loop referenced, so the estimate process never exited;
 * pilot.sh had to kill it after a timeout and reap the orphaned gnugo
 * processes. With dispose forwarded, the shutdown reaches the engine client,
 * the child quits, and the process exits by itself.
 *
 * The suite here is go/ladder-2 (the engine opponent at level 1, the cheapest
 * GNU Go tier) plus chess-stockfish/sf-250. Every chess-stockfish tier
 * carries fitted parameters, so its estimate basis is model-fit with no probe
 * episode — the live engine pressure comes from the go tier, and the
 * no-leftover check covers both binaries.
 *
 * Exit bound: 180 s. Post-fix the estimate runs one GNU Go probe episode
 * (seconds at level 1 on 9x9) plus CLI startup; 180 s is several times the
 * expected wall clock. Pre-fix the process never exits, so any bound
 * separates the behaviors — the test kills the process at the bound and
 * fails. Engine children spawned by the run and still alive after it are
 * reaped in cleanup so a red run leaves the shared sandbox clean.
 *
 * Binary-gated: skipped unless both engines are installed; the skip message
 * names the install command.
 *
 * @module
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { findGtpBinary } from '../../engines/gtp/client.js';
import { findEngineBinary } from '../../engines/uci/client.js';

const execFileAsync = promisify(execFile);
const gauntletRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const cli = join(gauntletRoot, 'cli', 'gauntlet.js');

/** The bound the test enforces on the estimate process. */
const EXIT_BOUND_MS = 180 * 1000;

/**
 * Every live engine process on the machine, as pid → command name. The
 * sandbox is shared, so other threads may hold engines of their own: the
 * leftover check compares the after-set against the before-set and flags
 * only pids that appeared while the estimate ran.
 *
 * @returns {Promise<Map<number, string>>}
 */
async function engineProcesses() {
  const { stdout } = await execFileAsync('ps', ['-eo', 'pid=,comm=']);
  /** @type {Map<number, string>} */
  const live = new Map();
  for (const line of stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!match) continue;
    const comm = match[2].trim();
    if (comm === 'gnugo' || comm === 'stockfish') live.set(Number(match[1]), comm);
  }
  return live;
}

/**
 * Run the CLI as a subprocess and await its exit.
 *
 * @param {...string} args
 * @returns {Promise<{ stdout: string, stderr: string, status: number }>}
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
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ stdout, stderr, status: code ?? -1 });
    });
  });
}

test('estimate over an engine-backed suite exits on its own with no engine left behind', { timeout: EXIT_BOUND_MS + 120_000 }, async (t) => {
  const gnugo = findGtpBinary('gnugo');
  const stockfish = findEngineBinary('stockfish');
  if (!gnugo || !stockfish) {
    const missing = [!gnugo ? 'gnugo' : null, !stockfish ? 'stockfish' : null].filter(Boolean);
    t.skip(
      `missing engine binary: ${missing.join(', ')} — install with apt-get install -y gnugo and/or apt-get install -y stockfish`
    );
    return;
  }

  const root = mkdtempSync(join(tmpdir(), 'gauntlet-estimate-exit-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  // One seed per tier, then keep the cheapest engine-backed go tier and the
  // chess-stockfish tier: one GNU Go probe episode in total.
  const suiteFile = join(root, 'suite.json');
  const build = await gauntlet(
    'suite', 'build', '--split', 'public', '--games', 'go,chess-stockfish',
    '--seeds-per-tier', '1', '--out', suiteFile
  );
  assert.equal(build.status, 0, `suite build exits clean:\n${build.stdout}\n${build.stderr}`);
  const suite = JSON.parse(readFileSync(suiteFile, 'utf8'));
  const go = /** @type {*} */ (suite).games.find((/** @type {*} */ g) => g.id === 'go');
  const sf = /** @type {*} */ (suite).games.find((/** @type {*} */ g) => g.id === 'chess-stockfish');
  assert.ok(go && sf, 'both games are in the suite');
  go.tiers = go.tiers.filter((/** @type {*} */ tier) => tier.id === 'ladder-2');
  sf.tiers = sf.tiers.filter((/** @type {*} */ tier) => tier.id === 'sf-250');
  writeFileSync(suiteFile, JSON.stringify(suite, null, 2) + '\n');

  const before = await engineProcesses();
  /** Best-effort reaper: any engine pid that appeared during this run and is
   * still alive at cleanup was leaked by a red run — kill it so the shared
   * sandbox stays clean. On the green path this finds nothing. */
  t.after(async () => {
    const remaining = await engineProcesses();
    for (const pid of remaining.keys()) {
      if (!before.has(pid)) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // Already gone.
        }
      }
    }
  });

  const outDir = join(root, 'estimate');
  const child = spawn(
    process.execPath,
    [cli, 'estimate', '--suite', suiteFile, '--agent', 'random', '--out', outDir, '--json'],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  );
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  let killedByBound = false;
  const bound = setTimeout(() => {
    killedByBound = true;
    child.kill('SIGKILL');
  }, EXIT_BOUND_MS);
  const status = await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => resolve(code ?? -1));
  });
  clearTimeout(bound);

  assert.equal(
    killedByBound,
    false,
    `estimate exited on its own within ${EXIT_BOUND_MS}ms — killed at the bound means engine children held the process alive (the PR #102 hang):\n${stdout}\n${stderr}`
  );
  assert.equal(status, 0, `estimate exits clean:\n${stdout}\n${stderr}`);
  assert.ok(existsSync(join(outDir, 'estimate.json')), 'estimate.json was written');
  const estimate = JSON.parse(readFileSync(join(outDir, 'estimate.json'), 'utf8'));
  const goTier = /** @type {*} */ (estimate).tiers.find(
    (/** @type {*} */ x) => x.gameId === 'go' && x.tierId === 'ladder-2'
  );
  assert.equal(
    goTier?.basis,
    'engine-probe',
    'the go tier was probed — a GNU Go episode actually ran, so the shutdown path is exercised'
  );
  const sfTier = /** @type {*} */ (estimate).tiers.find(
    (/** @type {*} */ x) => x.gameId === 'chess-stockfish'
  );
  assert.equal(
    sfTier?.basis,
    'model-fit',
    'the chess-stockfish tier resolves to the fit — no probe episode, documenting where engine pressure comes from'
  );

  const after = await engineProcesses();
  const leftovers = [...after.keys()]
    .filter((pid) => !before.has(pid))
    .map((pid) => `${after.get(pid)} pid ${pid}`);
  assert.deepEqual(
    leftovers,
    [],
    'no engine process appeared and stayed while the estimate ran — a leaked gnugo or stockfish child is the PR #102 symptom'
  );
});
