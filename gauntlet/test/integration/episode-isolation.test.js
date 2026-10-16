/**
 * Integration: episode isolation for model agents. The CLI must build one
 * fresh model agent per episode, so nothing an episode said or heard leaks
 * into another episode's requests — at --concurrency 1 and at
 * --concurrency 4 alike.
 *
 * The stub replies with a marker derived from the request body. Each sliding
 * episode therefore produces a deterministic three-request conversation
 * ("mk…" is never a legal sliding action, so every episode forfeits after
 * three calls): turn 1 carries no marker at all, turn 2 carries turn 1's
 * marker (the official turn message shows the previous reply and its
 * invalid-action feedback echo), turn 3 turn 2's — and no marker from any
 * other episode ever appears in a request. Any such foreign marker in a
 * request is a leak. Because markers are content-derived, the concurrency-4
 * run makes exactly the same requests and writes exactly the same trajectories
 * as the concurrency-1 run only when every episode is isolated.
 *
 * Runs against a local stub chat-completions server on 127.0.0.1; no paid
 * calls.
 *
 * @module
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalJson } from '../../core/canonical.js';
import { startStubServer, sendJson } from '../../harness/stub-server.js';

const gauntletRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const cli = join(gauntletRoot, 'cli', 'gauntlet.js');

/** Marker format the stub replies with. Never a legal sliding action. */
const MARKER_RE = /mk[0-9a-f]{12}/;

/** Usage the stub reports per call, priced so runs record real spend. */
const STUB_USAGE = { prompt_tokens: 100, completion_tokens: 10 };

/**
 * Run the CLI as a subprocess and await its exit. Async spawn keeps this
 * process's event loop free — the stub server lives here.
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
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ stdout, stderr, status: code ?? -1 });
    });
  });
}

/**
 * Start a stub that answers every call with a marker derived from the
 * request body, and records every request body it saw.
 *
 * @returns {Promise<{ url: string, close: () => Promise<void>, bodies: string[] }>}
 */
async function startMarkingStub() {
  /** @type {string[]} */
  const bodies = [];
  const stub = await startStubServer(
    /** @param {import('node:http').IncomingMessage} req @param {import('node:http').ServerResponse} res @param {*} body */
    (req, res, body) => {
      const raw = JSON.stringify(body);
      bodies.push(raw);
      const marker = `mk${createHash('sha256').update(raw).digest('hex').slice(0, 12)}`;
      sendJson(res, 200, {
        id: 'chatcmpl-stub',
        object: 'chat.completion',
        created: 1,
        model: /** @type {{model?: string}} */ (body)?.model ?? 'stub-model',
        choices: [
          { index: 0, message: { role: 'assistant', content: marker }, finish_reason: 'stop' },
        ],
        usage: { ...STUB_USAGE },
      });
    }
  );
  return { url: stub.url, close: stub.close, bodies };
}

/**
 * The marker the stub replied to request `bodies[i]` with.
 *
 * @param {string[]} bodies
 * @param {number} i
 */
function markerFor(bodies, i) {
  return `mk${createHash('sha256').update(bodies[i]).digest('hex').slice(0, 12)}`;
}

/**
 * Strip wall-clock fields so two runs of the same episode compare equal.
 *
 * @param {{ startedAt: string, finishedAt: string, steps: { ms: number }[] }} t
 */
function stripTiming(t) {
  return {
    ...t,
    startedAt: '',
    finishedAt: '',
    steps: t.steps.map((/** @type {{ ms: number }} */ s) => ({ ...s, ms: 0 })),
  };
}

/**
 * Every trajectory in a run bundle, keyed by its bundle-relative path.
 *
 * @param {string} root
 */
function readTrajectories(root) {
  /** @type {Map<string, string>} */
  const out = new Map();
  const walk = (/** @type {string} */ dir, /** @type {string} */ rel) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const key = rel ? `${rel}/${name}` : name;
      if (statSync(path).isDirectory()) {
        walk(path, key);
        continue;
      }
      if (!name.endsWith('.json') || name.startsWith('_') || name === 'run.json' || name === 'suite.json') {
        continue;
      }
      out.set(key, canonicalJson(stripTiming(JSON.parse(readFileSync(path, 'utf8')))));
    }
  };
  walk(root, '');
  return out;
}

test('model agents are episode-isolated: no cross-episode text at concurrency 1 or 4', { timeout: 4 * 60 * 1000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'gauntlet-episode-isolation-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  // Suite: sliding only, one seed per tier — four independent episodes.
  const suiteFile = join(root, 'suite.json');
  await gauntlet('suite', 'build', '--split', 'public', '--games', 'sliding', '--seeds-per-tier', '1', '--out', suiteFile);
  const suite = JSON.parse(readFileSync(suiteFile, 'utf8'));
  const episodeCount = suite.games.reduce(
    (/** @type {number} */ n, /** @type {*} */ g) => n + g.tiers.reduce(
      (/** @type {number} */ m, /** @type {*} */ tier) => m + tier.seeds.length, 0), 0);
  assert.ok(episodeCount >= 2, 'the suite has at least two episodes');

  const pricesFile = join(root, 'prices.json');
  writeFileSync(
    pricesFile,
    JSON.stringify(
      { 'openai-chat/stub-model': { inputPerMTok: 10, outputPerMTok: 30, source: 'stub', checked: '2026-10-16' } },
      null,
      2
    )
  );

  /** @type {Record<number, { bodies: string[] }>} */
  const legs = {};
  for (const concurrency of [1, 4]) {
    const stub = await startMarkingStub();
    t.after(() => stub.close());
    const out = join(root, `run-c${concurrency}`);
    const run = await gauntlet(
      'run', '--suite', suiteFile,
      '--agent', 'model:openai-chat/stub-model',
      '--base-url', stub.url,
      '--prices', pricesFile,
      '--out', out,
      '--concurrency', String(concurrency)
    );
    assert.equal(run.status, 0, `the concurrency-${concurrency} run exits clean:\n${run.stdout}\n${run.stderr}`);
    legs[concurrency] = { bodies: stub.bodies };
  }

  // Sliding episodes forfeit after three consecutive invalid replies, so the
  // request stream is exactly three requests per episode, in episode order.
  const bodies1 = legs[1].bodies;
  assert.equal(bodies1.length, 3 * episodeCount, 'three stub calls per episode at concurrency 1');

  for (let k = 0; k < episodeCount; k++) {
    const first = bodies1[3 * k];
    assert.doesNotMatch(first, MARKER_RE, `episode ${k}'s first request carries no reply marker at all`);
    const second = bodies1[3 * k + 1];
    assert.match(second, new RegExp(markerFor(bodies1, 3 * k)), `episode ${k}'s second request carries its own turn-1 reply`);
    const third = bodies1[3 * k + 2];
    assert.match(third, new RegExp(markerFor(bodies1, 3 * k + 1)), `episode ${k}'s third request carries its own turn-2 reply`);
    // The official turn message legitimately shows an episode's own marker
    // twice (previous-reply section and the invalid-action feedback echo), so
    // the isolation invariant is not an exact count: no marker derived from
    // any other episode's request may appear anywhere in this episode's
    // requests.
    for (let j = 0; j < episodeCount; j++) {
      if (j === k) continue;
      for (let turn = 0; turn < 3; turn++) {
        const foreign = markerFor(bodies1, 3 * j + turn);
        assert.doesNotMatch(second, new RegExp(foreign), `episode ${k}'s second request carries no marker from episode ${j} turn ${turn + 1}`);
        assert.doesNotMatch(third, new RegExp(foreign), `episode ${k}'s third request carries no marker from episode ${j} turn ${turn + 1}`);
      }
    }
  }

  // At concurrency 4 the run must make exactly the same requests: a shared
  // agent would weave other episodes' replies into the request text.
  const bodies4 = legs[4].bodies;
  assert.equal(bodies4.length, 3 * episodeCount, 'three stub calls per episode at concurrency 4');
  const sorted = (/** @type {string[]} */ a) => a.map((b) => canonicalJson(JSON.parse(b))).sort();
  assert.deepEqual(sorted(bodies4), sorted(bodies1), 'the same requests are made at concurrency 4 as at concurrency 1');

  // And therefore the same trajectories, modulo timing.
  const trajectories1 = readTrajectories(join(root, 'run-c1'));
  const trajectories4 = readTrajectories(join(root, 'run-c4'));
  assert.equal(trajectories4.size, trajectories1.size);
  assert.equal(trajectories4.size, episodeCount, 'every episode wrote a trajectory');
  for (const [key, traj1] of trajectories1) {
    const traj4 = trajectories4.get(key);
    assert.ok(traj4, `the concurrency-4 run also wrote ${key}`);
    assert.equal(traj4, traj1, `${key} is identical across both runs apart from timing`);
  }
});
