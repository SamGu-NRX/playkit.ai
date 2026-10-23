/**
 * Run engine tests: whole-suite play, provenance, concurrency determinism,
 * budget and call caps, abort+resume, rate limiting, corrupt-file replay.
 *
 * Uses the bundled fixture games (a real engine game and a real one-shot
 * game) so every assertion runs against the actual core/scoring contracts —
 * no game stubs. Writes go to temp directories only.
 *
 * @module
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFile, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { verifyTrajectory } from '../core/trajectory.js';
import { canonicalJson } from '../core/canonical.js';
import { buildSuite } from '../scoring/suite.js';
import { countdown, takeOrPass } from '../scoring/fixtures.js';

import { createRateLimiter, runSuite, SPEND_LEDGER_FILENAME } from './run.js';
import { printRunSummary } from '../cli/run.js';
import { manifestSha256, planJobs } from './plan.js';
import { trajectoryPath } from './fsutil.js';

/** @import { Agent, Game, Trajectory } from '../core/types.js' */
/** @import { Job } from './plan.js' */

/** A two-game public suite: 2 one-shot episodes + 8 engine episodes. */
const SUITE = buildSuite([takeOrPass, countdown], { split: 'public' });
const GAMES = [takeOrPass, countdown];

/** A priced stand-in agent: always the first legal action, fixed cost.
 *
 * @param {{ costUsd?: number | null, onCall?: (job: Job, ctx: import('../core/types.js').TurnContext) => void }} [options]
 * @returns {(job: Job) => Agent}
 */
function pricedFactory({ costUsd = 0.001, onCall } = {}) {
  return (job) => /** @type {Agent} */ ({
    id: 'fake-priced',
    track: 'community',
    async act(ctx) {
      if (onCall) onCall(job, ctx);
      return {
        text: /** @type {string[]} */ (ctx.legalActions)[0],
        usage: { inputTokens: 50, outputTokens: 10, costUsd },
      };
    },
  });
}

/** Strip wall-clock fields so two runs of the same episode compare equal.
 *
 * @param {Trajectory} t
 */
function stripTiming(t) {
  return {
    ...t,
    startedAt: '',
    finishedAt: '',
    steps: t.steps.map((s) => ({ ...s, ms: 0 })),
  };
}

/** @param {string} label */
async function tempDir(label) {
  return mkdtemp(path.join(tmpdir(), `gauntlet-run-${label}-`));
}

/** Every trajectory JSON in the bundle, keyed by job key.
 *
 * Seeds carry slashes (`<game>/<tier>/public/<i>`), so trajectory files nest
 * several levels below the tier directory; walk recursively and take the job
 * key from each file's path relative to the run root.
 *
 * @param {string} outDir
 * @returns {Promise<Map<string, Trajectory>>}
 */
async function readTrajectories(outDir) {
  /** @type {Map<string, Trajectory>} */
  const out = new Map();
  /** @param {string} dir @param {number} depth */
  async function walk(dir, depth) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        await walk(path.join(dir, entry.name), depth + 1);
      } else if (depth > 0 && entry.name.endsWith('.json') && !entry.name.startsWith('.')) {
        const rel = path.relative(outDir, path.join(dir, entry.name)).split(path.sep).join('/');
        out.set(rel.replace(/\.json$/, ''), JSON.parse(await readFile(path.join(dir, entry.name), 'utf8')));
      }
    }
  }
  for (const entry of await readdir(outDir, { withFileTypes: true })) {
    // Top-level files (suite.json, run.json, prices.json) are not episodes.
    if (entry.isDirectory()) await walk(path.join(outDir, entry.name), 1);
  }
  return out;
}

test('a full run writes verifiable trajectories and honest provenance', async () => {
  const outDir = await tempDir('full');
  try {
    const pricesPath = path.join(outDir, 'prices.json');
    const pricesBytes = JSON.stringify(
      { 'acme/alpha': { inputPerMTok: 3, outputPerMTok: 15, source: 'test', checked: '2026-10-15' } },
      null,
      2
    );
    await writeFile(pricesPath, pricesBytes);

    const result = await runSuite({
      suite: SUITE,
      games: GAMES,
      agentFactory: pricedFactory(),
      outDir,
      pricesPath,
    });

    const jobs = planJobs(SUITE);
    assert.equal(result.stopped, null);
    assert.equal(result.run.format, 'playkit-gauntlet-run/1');
    assert.equal(result.run.suite.id, SUITE.id);
    assert.equal(result.run.suite.manifestSha256, manifestSha256(SUITE));
    assert.ok(result.run.agent, 'run record carries the agent identity');
    assert.equal(result.run.agent.id, 'fake-priced');
    assert.equal(result.run.agent.track, 'community');
    assert.equal(result.run.node.startsWith('v'), true);
    assert.equal(result.run.limits.maxUsd, null);
    assert.equal(result.run.limits.episodeTimeLimitMs, 15 * 60 * 1000);
    assert.equal(result.run.counts.jobs, jobs.length);
    assert.equal(result.run.counts.played, jobs.length);
    assert.equal(result.run.counts.unplayed, 0);
    assert.equal(result.run.prices.path, pricesPath);
    // Independent hash of the prices file bytes.
    assert.equal(result.run.prices.sha256, createHash('sha256').update(pricesBytes).digest('hex'));

    // Every planned episode has a trajectory file that re-verifies.
    const onDisk = await readTrajectories(outDir);
    assert.equal(onDisk.size, jobs.length);
    let agentCalls = 0;
    let spend = 0;
    for (const job of jobs) {
      const t = onDisk.get(job.key);
      assert.ok(t, `missing trajectory for ${job.key}`);
      assert.equal(t.agent.id, 'fake-priced');
      assert.equal(t.agent.model, undefined);
      const game = /** @type {Game<*>} */ (GAMES.find((g) => g.spec.id === job.gameId));
      const verdict = await verifyTrajectory(game, t);
      if (!verdict.ok) assert.fail(`${job.key}: step ${verdict.step}: ${verdict.reason}`);
      agentCalls += t.end.agentActions;
      for (const step of t.steps) {
        // Only agent steps carry usage; verification just asserted the shape,
        // including that this costUsd is a number rather than unknown.
        if (step.by === 'agent' && step.usage) spend += /** @type {number} */ (step.usage.costUsd);
      }
    }
    // spendUsd and calls mirror the trajectories' own accounting.
    assert.ok(Math.abs(result.spendUsd - spend) < 1e-9);
    assert.equal(result.calls, agentCalls);
    assert.equal(result.run.calls, agentCalls);
    // The whole-bundle total block sums every trajectory in the run
    // directory. One invocation played them all here, so it mirrors the
    // per-invocation fields and the independent on-disk accounting above.
    assert.equal(result.run.total.episodes, jobs.length);
    assert.equal(result.run.total.calls, agentCalls);
    assert.equal(result.run.total.tokens.input, agentCalls * 50);
    assert.equal(result.run.total.tokens.output, agentCalls * 10);
    assert.ok(Math.abs(result.run.total.spendUsd - spend) < 1e-9);
    assert.equal(result.run.total.unknownCostSteps, 0);
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});

test('a game deadline times out one game, cleans up, and continues to the next game', async () => {
  const outDir = await tempDir('episode-deadline');
  try {
    const suite = buildSuite([takeOrPass], { split: 'public' });
    const jobs = planJobs(suite);
    const state = { pending: 0, disposed: 0, calls: 0 };
    const result = await runSuite({
      suite,
      games: [takeOrPass],
      outDir,
      episodeTimeLimitMs: 25,
      agentFactory: (job) => /** @type {Agent} */ ({
        id: `deadline-agent-${job.key}`,
        track: 'community',
        async act(ctx) {
          state.calls += 1;
          if (job.key === jobs[0].key) {
            state.pending += 1;
            return new Promise((_resolve, reject) => {
              const abort = () => {
                state.pending -= 1;
                reject(new Error('stub model aborted'));
              };
              if (ctx.signal?.aborted) abort();
              else ctx.signal?.addEventListener('abort', abort, { once: true });
            });
          }
          return { text: /** @type {string[]} */ (ctx.legalActions)[0] };
        },
        async dispose() {
          state.disposed += 1;
        },
      }),
    });

    assert.equal(result.stopped, null, 'a timed-out game does not stop the suite');
    assert.equal(result.run.counts.played, 2, 'the timed-out game and the next game are recorded');
    assert.equal(result.run.counts.failed, 0);
    assert.equal(result.trajectories[0]?.end.reason, 'time-limit');
    assert.equal(result.trajectories[0]?.end.timeLimitMs, 25);
    assert.ok((result.trajectories[0]?.end.elapsedMs ?? 0) >= 25);
    assert.equal(result.trajectories[1]?.end.reason, 'terminal');
    assert.equal(state.calls, 2, 'the next game gets a normal model call');
    assert.equal(state.pending, 0, 'the timed-out model call settled on cancellation');
    assert.equal(state.disposed, 2, 'both episode agents were disposed before the suite returned');
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});

test('concurrency 1 and concurrency 4 produce identical trajectories apart from timing', async () => {
  const dirA = await tempDir('c1');
  const dirB = await tempDir('c4');
  try {
    await runSuite({ suite: SUITE, games: GAMES, agentFactory: pricedFactory(), outDir: dirA, concurrency: 1 });
    await runSuite({ suite: SUITE, games: GAMES, agentFactory: pricedFactory(), outDir: dirB, concurrency: 4 });
    const a = await readTrajectories(dirA);
    const b = await readTrajectories(dirB);
    assert.equal(a.size, b.size);
    for (const [key, ta] of a) {
      const tb = b.get(key);
      assert.ok(tb, `both runs wrote ${key}`);
      assert.deepEqual(canonicalJson(stripTiming(tb)), canonicalJson(stripTiming(ta)), key);
    }
  } finally {
    await rm(dirA, { recursive: true, force: true });
    await rm(dirB, { recursive: true, force: true });
  }
});

test('aborting mid-run stops after in-flight episodes; resume completes without replaying', async () => {
  const outDir = await tempDir('abort');
  try {
    let callsSeen = 0;
    const controller = new AbortController();
    const first = await runSuite({
      suite: SUITE,
      games: GAMES,
      agentFactory: pricedFactory({
        onCall() {
          callsSeen += 1;
          if (callsSeen === 5) controller.abort();
        },
      }),
      outDir,
      signal: controller.signal,
    });
    assert.equal(first.stopped, 'cancelled');
    // Calls 1-2 finish the two take-or-pass episodes; calls 3-5 go into the
    // first countdown episode, whose abort unwinds it unwritten.
    assert.equal(first.run.counts.played, 2);
    const afterAbort = await readTrajectories(outDir);
    assert.equal(afterAbort.size, first.run.counts.played);

    const second = await runSuite({
      suite: SUITE,
      games: GAMES,
      agentFactory: pricedFactory(),
      outDir,
      resume: true,
    });
    assert.equal(second.stopped, null);
    assert.equal(second.skipped.length, first.run.counts.played);
    assert.equal(second.replayed.length, 0);
    assert.equal(second.run.counts.unplayed, 0);

    const total = SUITE.games.reduce((a, g) => a + g.tiers.reduce((b, t) => b + t.seeds.length, 0), 0);
    const final = await readTrajectories(outDir);
    assert.equal(final.size, total); // exactly the planned episodes, no extras
    for (const [key, t] of final) {
      const game = /** @type {Game<*>} */ (GAMES.find((g) => g.spec.id === key.split('/')[0]));
      const verdict = await verifyTrajectory(game, t);
      if (!verdict.ok) assert.fail(`${key}: step ${verdict.step}: ${verdict.reason}`);
    }

    // Whole-bundle totals after resume: the resuming invocation's record
    // sums every trajectory in the directory — including the two episodes
    // the aborted first invocation played — while its per-invocation fields
    // (calls, spendUsd, counts.played) describe only this invocation. That
    // distinction is the whole point of the total block.
    let bundleCalls = 0;
    let bundleSpend = 0;
    for (const t of final.values()) {
      bundleCalls += t.end.agentActions;
      for (const step of t.steps) {
        if (step.usage && typeof step.usage.costUsd === 'number') bundleSpend += step.usage.costUsd;
      }
    }
    assert.equal(second.run.total.episodes, total);
    assert.equal(second.run.total.calls, bundleCalls);
    assert.ok(bundleCalls > second.run.calls, 'the bundle holds episodes an earlier invocation played');
    assert.ok(Math.abs(second.run.total.spendUsd - bundleSpend) < 1e-9);
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});

test('maxUsd stops at the cap, writes nothing partial, and resume with a higher cap finishes', async () => {
  const outDir = await tempDir('budget');
  try {
    const first = await runSuite({
      suite: SUITE,
      games: GAMES,
      agentFactory: pricedFactory({ costUsd: 0.001 }),
      outDir,
      maxUsd: 0.002,
    });
    assert.equal(first.stopped, 'budget');
    assert.ok(first.spendUsd <= 0.002 + 1e-12, `spend ${first.spendUsd} exceeded the cap`);
    // Deterministic at concurrency 1: both take-or-pass episodes (2 calls ×
    // $0.001) complete; the cap blocks the third call.
    assert.equal(first.run.counts.played, 2);
    assert.ok(Math.abs(first.spendUsd - 0.002) < 1e-12);
    assert.equal(first.run.limits.maxUsd, 0.002);
    assert.ok(first.run.counts.unplayed > 0);
    // Nothing half-written: every file on disk verifies.
    for (const t of (await readTrajectories(outDir)).values()) {
      const game = /** @type {Game<*>} */ (GAMES.find((g) => g.spec.id === t.game.id));
      const verdict = await verifyTrajectory(game, t);
      if (!verdict.ok) assert.fail(`${t.game.id}/${t.tier}/${t.seed}: ${verdict.reason}`);
    }

    const second = await runSuite({
      suite: SUITE,
      games: GAMES,
      agentFactory: pricedFactory({ costUsd: 0.001 }),
      outDir,
      resume: true,
      maxUsd: 100,
    });
    assert.equal(second.stopped, null);
    assert.equal(second.run.counts.unplayed, 0);
    assert.equal((await readTrajectories(outDir)).size, 10);
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});

test('a null costUsd with maxUsd set refuses the run instead of guessing spend', async () => {
  const outDir = await tempDir('unknown-cost');
  try {
    await assert.rejects(
      runSuite({
        suite: SUITE,
        games: GAMES,
        agentFactory: pricedFactory({ costUsd: null }),
        outDir,
        maxUsd: 5,
      }),
      /price entry|cannot be enforced/
    );
    const run = JSON.parse(await readFile(path.join(outDir, 'run.json'), 'utf8'));
    assert.equal(run.stopped, 'error');
    assert.equal(run.counts.played, 0);
    assert.equal(run.counts.unplayed, 10);
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});

test('an unpriced agent call without a cap set keeps spendUsd a finite sum of known costs', async () => {
  const outDir = await tempDir('no-usage');
  try {
    const jobs = planJobs(SUITE);
    const result = await runSuite({
      suite: SUITE,
      games: GAMES,
      agentFactory: () => {
        let called = 0;
        return /** @type {Agent} */ ({
          id: 'partially-priced',
          track: 'community',
          async act(ctx) {
            called += 1;
            return {
              text: /** @type {string[]} */ (ctx.legalActions)[0],
              // Usage on the episode's first call only; later calls return no
              // usage object at all. No cap is set, so the null-cost refusal
              // does not apply — the spend must still account sanely.
              ...(called === 1 ? { usage: { inputTokens: 10, outputTokens: 2, costUsd: 0.25 } } : {}),
            };
          },
        });
      },
      outDir,
    });
    // Exactly one priced call per episode: 0.25 each. Unpriced calls count as
    // zero rather than poisoning the sum into NaN (recorded as null).
    const expected = jobs.length * 0.25;
    assert.ok(Number.isFinite(result.spendUsd), `spendUsd ${result.spendUsd} should stay finite`);
    assert.ok(
      Math.abs(result.spendUsd - expected) < 1e-9,
      `spendUsd ${result.spendUsd} vs expected ${expected}`
    );
    assert.equal(result.run.spendUsd, result.spendUsd);
    const run = JSON.parse(await readFile(path.join(outDir, 'run.json'), 'utf8'));
    assert.equal(typeof run.spendUsd, 'number');
    assert.ok(Math.abs(run.spendUsd - expected) < 1e-9);
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});

test('maxCalls stops the run at the cap and resume continues with a fresh counter', async () => {
  const outDir = await tempDir('calls');
  try {
    const first = await runSuite({
      suite: SUITE,
      games: GAMES,
      agentFactory: pricedFactory(),
      outDir,
      maxCalls: 4,
    });
    assert.equal(first.stopped, 'calls');
    assert.equal(first.calls, 4);
    // Calls 1-2 completed the take-or-pass episodes; 3-4 sat inside the
    // first countdown episode, which unwinds unwritten.
    assert.equal(first.run.counts.played, 2);
    assert.ok(first.run.counts.unplayed > 0);

    const second = await runSuite({
      suite: SUITE,
      games: GAMES,
      agentFactory: pricedFactory(),
      outDir,
      resume: true,
      maxCalls: 1000,
    });
    assert.equal(second.stopped, null);
    assert.equal(second.run.counts.unplayed, 0);
    assert.equal((await readTrajectories(outDir)).size, 10);
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});

test('a corrupt trajectory file is re-run on resume and verifies afterwards', async () => {
  const outDir = await tempDir('corrupt');
  try {
    await runSuite({ suite: SUITE, games: GAMES, agentFactory: pricedFactory(), outDir });
    const jobs = planJobs(SUITE);
    const victim = trajectoryPath(outDir, jobs[3]);
    await writeFile(victim, '{"format": "playkit-gauntlet-trajectory/1", "steps": [');
    const second = await runSuite({
      suite: SUITE,
      games: GAMES,
      agentFactory: pricedFactory(),
      outDir,
      resume: true,
    });
    assert.equal(second.stopped, null);
    assert.deepEqual(second.replayed, [jobs[3].key]);
    assert.equal(second.skipped.length, jobs.length - 1);
    const t = JSON.parse(await readFile(victim, 'utf8'));
    assert.equal(t.game.id, jobs[3].gameId);
    const game = /** @type {Game<*>} */ (GAMES.find((g) => g.spec.id === jobs[3].gameId));
    const verdict = await verifyTrajectory(game, t);
    if (!verdict.ok) assert.fail(`${jobs[3].key}: step ${verdict.step}: ${verdict.reason}`);
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});

test('resume refuses to mix manifests in one bundle', async () => {
  const outDir = await tempDir('mismatch');
  try {
    await runSuite({
      suite: SUITE,
      games: GAMES,
      agentFactory: pricedFactory(),
      outDir,
    });
    // Same games, different split and salt: a genuinely different manifest.
    // (Public suites cannot carry a salt, so eval is the honest lever.)
    const other = buildSuite(GAMES, { split: 'eval', salt: 'different-salt' });
    await assert.rejects(
      runSuite({ suite: other, games: GAMES, agentFactory: pricedFactory(), outDir, resume: true }),
      /different suite manifest/
    );
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});

test('resume refuses an invocation whose agent differs from the recorded trajectories', async () => {
  const outDir = await tempDir('agent-mix');
  try {
    // The two one-shot episodes anchor the bundle's agent identity; the
    // call cap leaves the second one unplayed for the resume.
    const suite = buildSuite([takeOrPass], { split: 'public' });
    const games = [takeOrPass];
    const first = await runSuite({
      suite,
      games,
      agentFactory: pricedFactory(),
      outDir,
      maxCalls: 1,
    });
    assert.equal(first.stopped, 'calls');
    assert.equal(first.run.counts.played, 1);

    // Resuming with a different agent must refuse before it skips the other
    // agent's verified file or plays a single episode: skipping agent A's
    // files and writing agent B's beside them reports success over a bundle
    // scoring refuses.
    let calls = 0;
    await assert.rejects(
      runSuite({
        suite,
        games,
        outDir,
        resume: true,
        agentFactory: () => /** @type {Agent} */ ({
          id: 'fake-priced-b',
          track: 'community',
          async act(ctx) {
            calls += 1;
            return {
              text: /** @type {string[]} */ (ctx.legalActions)[0],
              usage: { inputTokens: 50, outputTokens: 10, costUsd: 0.001 },
            };
          },
        }),
      }),
      /holds trajectories from agent/
    );
    assert.equal(calls, 0, 'nothing was played before the refusal');

    // The bundle still belongs to the original agent: resuming with the
    // same agent id completes it.
    const third = await runSuite({
      suite,
      games,
      agentFactory: pricedFactory(),
      outDir,
      resume: true,
    });
    assert.equal(third.stopped, null);
    assert.equal(third.run.counts.unplayed, 0);
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});

test('a parseable but damaged trajectory (no agent record) is re-run on resume', async () => {
  const outDir = await tempDir('damaged');
  try {
    await runSuite({ suite: SUITE, games: GAMES, agentFactory: pricedFactory(), outDir });
    const jobs = planJobs(SUITE);
    const victim = trajectoryPath(outDir, jobs[3]);
    // Parseable JSON that matches the job's identity (format, game id AND
    // version, tier, seed, split — every field the resume classification and
    // the verifier's opening check look at) but is not a well-formed
    // trajectory: no agent record, no steps list. The verifier throws on the
    // missing shape; the resume must treat the file exactly like corrupt
    // JSON and re-run the episode.
    const victimGame = /** @type {Game<*>} */ (GAMES.find((g) => g.spec.id === jobs[3].gameId));
    await writeFile(
      victim,
      JSON.stringify({
        format: 'playkit-gauntlet-trajectory/1',
        game: { id: jobs[3].gameId, version: victimGame.spec.version },
        tier: jobs[3].tierId,
        seed: jobs[3].seed,
        split: jobs[3].split,
      })
    );
    const second = await runSuite({
      suite: SUITE,
      games: GAMES,
      agentFactory: pricedFactory(),
      outDir,
      resume: true,
    });
    assert.equal(second.stopped, null);
    assert.deepEqual(second.replayed, [jobs[3].key]);
    assert.equal(second.skipped.length, jobs.length - 1);
    const t = JSON.parse(await readFile(victim, 'utf8'));
    assert.equal(t.agent.id, 'fake-priced');
    const game = /** @type {Game<*>} */ (GAMES.find((g) => g.spec.id === jobs[3].gameId));
    const verdict = await verifyTrajectory(game, t);
    if (!verdict.ok) assert.fail(`${jobs[3].key}: step ${verdict.step}: ${verdict.reason}`);
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});

test('createRateLimiter spaces acquisitions by 60000/rpm under a fake clock', async () => {
  let t = 1000;
  const slept = [];
  const limiter = createRateLimiter({
    requestsPerMinute: 600, // one per 100 ms
    now: () => t,
    sleep: async (ms) => {
      slept.push(ms);
      t += ms;
    },
  });
  const stamps = [];
  for (let i = 0; i < 5; i++) {
    await limiter.acquire();
    stamps.push(t);
  }
  assert.equal(stamps[0], 1000); // first request never waits
  for (let i = 1; i < stamps.length; i++) {
    assert.equal(stamps[i] - stamps[i - 1], 100);
  }
});

test('usage reported without a priced cost stays unknown in the run record and summary', async () => {
  const outDir = await mkdtemp(path.join(tmpdir(), 'gauntlet-run-unknown-cost-'));
  try {
    // No maxUsd: the null-cost refusal must NOT fire, but the steps must not
    // read as free either — they are unknown, separately counted, and the
    // summary says unknown instead of printing the known-cost sum as spend.
    const result = await runSuite({
      suite: SUITE,
      games: GAMES,
      agentFactory: pricedFactory({ costUsd: null }),
      outDir,
    });
    const usageSteps = result.trajectories.reduce(
      (a, t) => a + t.steps.filter((s) => s.usage).length,
      0,
    );
    assert.ok(usageSteps > 0, 'the fixture suite produced usage-bearing steps');
    assert.equal(result.run.spendUsd, 0, 'the known-cost sum has nothing to sum');
    assert.equal(result.run.unknownCostSteps, usageSteps, 'every usage-bearing step with no cost is counted as unknown');

    let captured = '';
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk) => {
      captured += typeof chunk === 'string' ? chunk : String(chunk);
      return true;
    };
    try {
      printRunSummary(result);
    } finally {
      process.stdout.write = orig;
    }
    assert.match(captured, /spend    unknown \(/);
    assert.match(captured, /known-cost sum 0\.000000/);
    assert.doesNotMatch(captured, /spend    0\.000000/, 'unknown spend is never printed as a bare 0');
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});

/**
 * A deferred promise the test resolves manually.
 * @returns {{ promise: Promise<void>, resolve: () => void }}
 */
function deferred() {
  /** @type {() => void} */
  let resolve = () => {};
  const promise = new Promise((res) => {
    resolve = /** @type {() => void} */ (/** @type {unknown} */ (res));
  });
  return { promise, resolve };
}

/**
 * A one-seat fixture game where every episode takes exactly `calls` agent
 * calls: the agent replies 'go' until the counter runs out.
 *
 * @param {number} calls
 * @returns {Game<{ remaining: number }>}
 */
function makeGatedGame(calls) {
  return /** @type {Game<{ remaining: number }>} */ ({
    spec: {
      id: 'gated',
      version: '1.0.0',
      title: 'gated',
      seats: 1,
      information: 'perfect',
      stochastic: false,
      tags: [],
      benchmark: false,
      requires: [],
      rulesText: 'Say "go" until the counter reaches zero.',
      tiers: [
        { id: 'main', rank: 1, scoring: 'outcome', maxActions: 64, publicSeeds: 2, params: {} },
      ],
    },
    reset() {
      return { remaining: calls };
    },
    toAct(state) {
      return state.remaining <= 0 ? null : 0;
    },
    observe(state) {
      return { text: `remaining ${state.remaining}`, data: { remaining: state.remaining } };
    },
    legalActions() {
      return ['go'];
    },
    parseAction(_state, _seat, text) {
      return text.trim().toLowerCase() === 'go'
        ? { ok: true, action: 'go' }
        : { ok: false, error: 'the only action is "go"' };
    },
    step(state) {
      return { remaining: state.remaining - 1 };
    },
    outcome(state) {
      return { normalized: [1], raw: [state.remaining], reason: 'done' };
    },
    truncate() {
      return { normalized: [0], raw: null, reason: 'ran out of budget' };
    },
  });
}

test('a worker queued on the rate limiter re-checks maxCalls before calling', { timeout: 60 * 1000 }, async () => {
  const outDir = await tempDir('limiter-calls');
  try {
    const games = [makeGatedGame(2)];
    const suite = buildSuite(games, { split: 'public' });
    const jobs = planJobs(suite);
    let agentCalls = 0;
    let t = 0;
    let waits = 0;
    const bGate = deferred(); // worker B holds until worker A is queued
    const heldGate = deferred(); // worker A's limiter wait, held by the test
    const releaseGate = deferred(); // the test lets worker A proceed
    /** @returns {Agent} */
    const countingAgent = () =>
      /** @type {Agent} */ ({
        id: 'fake-priced',
        track: 'community',
        async act(ctx) {
          agentCalls += 1;
          return {
            text: /** @type {string[]} */ (ctx.legalActions)[0],
            usage: { inputTokens: 50, outputTokens: 10, costUsd: 0.001 },
          };
        },
      });

    const runPromise = runSuite({
      suite,
      games,
      outDir,
      concurrency: 2,
      maxCalls: 2,
      // One token immediately, then one per 1000 ms of fake time: the first
      // taker runs free, the next acquire queues on the limiter.
      requestsPerMinute: 60,
      now: () => t,
      sleep: async (ms) => {
        waits += 1;
        // The limiter serializes acquirers through a promise chain: the
        // first wait is worker A's queued second admission, and worker B,
        // chained behind it, is suspended before its own admission checks
        // ever run. Only A's wait is held under test control.
        if (waits === 1) {
          heldGate.resolve();
          await releaseGate.promise;
        }
        t += ms;
      },
      agentFactory: async (job) => {
        if (job.key === jobs[0].key) return countingAgent();
        // Worker B holds until worker A is queued on the limiter.
        await bGate.promise;
        return countingAgent();
      },
    });

    // Worker A took the free token, made call 1, and is now queued on the
    // limiter for call 2. Worker B is let in now and queues behind A on the
    // limiter's chain — suspended before its own admission checks run.
    await heldGate.promise;
    bGate.resolve();
    // Release A: its queued admission resolves, its checks re-run, it makes
    // call 2 and finishes its episode.
    releaseGate.resolve();
    let spins = 0;
    while (agentCalls < 2) {
      if (spins++ > 5000) throw new Error('worker A never made its second call');
      await new Promise((resolve) => setTimeout(resolve, 1));
    }

    const result = await runPromise;
    // Exactly maxCalls calls happened: B's admission ran only after its slot
    // on the chain, when the cap was already reached, and was refused.
    // Without the re-check B's queued position would not save it — its
    // checks would still see only calls=1 and the run would make
    // maxCalls + 1 calls.
    assert.equal(agentCalls, 2);
    assert.equal(result.run.calls, 2);
    assert.equal(result.stopped, 'calls');
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});

test('a worker queued on the rate limiter re-checks maxUsd before calling', { timeout: 60 * 1000 }, async () => {
  const outDir = await tempDir('limiter-usd');
  try {
    const games = [makeGatedGame(2)];
    const suite = buildSuite(games, { split: 'public' });
    const jobs = planJobs(suite);
    const state = { calls: 0, quotes: 0 };
    let t = 0;
    let waits = 0;
    const bGate = deferred(); // worker B holds until worker A is queued
    const heldGate = deferred(); // worker A's limiter wait, held by the test
    const releaseGate = deferred(); // the test lets worker A proceed
    /** @returns {Agent} */
    const quotingAgent = () =>
      /** @type {Agent} */ ({
        id: 'fake-priced',
        track: 'community',
        quoteWorstCaseUsd: () => {
          state.quotes += 1;
          return 1;
        },
        async act(ctx) {
          state.calls += 1;
          return {
            text: /** @type {string[]} */ (ctx.legalActions)[0],
            usage: { inputTokens: 1, outputTokens: 1, costUsd: 1 },
          };
        },
      });

    const runPromise = runSuite({
      suite,
      games,
      outDir,
      concurrency: 2,
      maxUsd: 2,
      requestsPerMinute: 60,
      now: () => t,
      sleep: async (ms) => {
        waits += 1;
        // As in the maxCalls test: the limiter's promise chain suspends
        // worker B before its own admission checks; only worker A's wait is
        // held under test control.
        if (waits === 1) {
          heldGate.resolve();
          await releaseGate.promise;
        }
        t += ms;
      },
      agentFactory: async (job) => {
        if (job.key === jobs[0].key) return quotingAgent();
        await bGate.promise;
        return quotingAgent();
      },
    });

    // Worker A took the free token, made call 1 ($1 settled), and is now
    // queued on the limiter for call 2. Worker B is let in now and queues
    // behind A on the limiter's chain — suspended before its own admission
    // checks run.
    await heldGate.promise;
    bGate.resolve();
    // Release A: its queued admission is re-checked ($1 settled + $1 quote =
    // $2, exactly at the cap — admitted), it makes call 2 and finishes its
    // episode with spend at exactly $2.
    releaseGate.resolve();
    let spins = 0;
    while (state.calls < 2) {
      if (spins++ > 5000) throw new Error('worker A never made its second call');
      await new Promise((resolve) => setTimeout(resolve, 1));
    }

    const result = await runPromise;
    // The cap held exactly: B's admission ran only after its slot on the
    // chain, saw $2 settled + $1 quote > $2, and was refused. Without the
    // re-check B's checks would see $1 settled and spend would land at $3 of
    // a $2 cap.
    assert.equal(state.calls, 2);
    assert.equal(state.quotes, 3, 'two admitted calls plus the refused one are quoted');
    assert.equal(result.run.calls, 2);
    assert.ok(Math.abs(result.run.spendUsd - 2) < 1e-9, `spend is exactly $2, got ${result.run.spendUsd}`);
    assert.equal(result.stopped, 'budget');
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});

test('concurrent worker ledger flushes keep the hash chain in file order', async () => {
  const outDir = await tempDir('ledger-order');
  try {
    const games = [makeGatedGame(1)];
    const suite = buildSuite(games, { split: 'public' });

    /** @returns {Agent} */
    const pricedAgent = () =>
      /** @type {Agent} */ ({
        id: 'fake-priced',
        track: 'community',
        async act(ctx) {
          return {
            text: /** @type {string[]} */ (ctx.legalActions)[0],
            usage: { inputTokens: 10, outputTokens: 2, costUsd: 0.01 },
          };
        },
      });

    // A writer that really appends the bytes, but resolves the first
    // call-record write long after the second: the runner computes each
    // chain link before the write, so an implementation that lets the two
    // workers' writes land out of order physically puts the second link's
    // bytes first. With serialization the second link is not even computed
    // until the first write has resolved, so file order matches the chain.
    let writes = 0;
    const appendLedgerFile = async (/** @type {string} */ filePath, /** @type {string} */ text) => {
      const delay = writes === 1 ? 60 : 10;
      writes += 1;
      await new Promise((resolve) => setTimeout(resolve, delay));
      await appendFile(filePath, text, 'utf8');
    };

    const result = await runSuite({
      suite,
      games,
      outDir,
      concurrency: 2,
      agentFactory: async () => pricedAgent(),
      appendLedgerFile,
    });

    // The end-of-run ledger re-read verifies the chain; a reorder would
    // surface as a problem here.
    assert.deepEqual(result.ledger.problems, [], JSON.stringify(result.ledger.problems));
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});

test('the worst-case quote hook is consulted only when a dollar cap needs it', async () => {
  const games = [takeOrPass];
  const suite = buildSuite(games, { split: 'public' });

  /** @returns {Agent} */
  const quoteCountingAgent = (/** @type {{ quotes: number }} */ state) =>
    /** @type {Agent} */ ({
      id: 'fake-priced',
      track: 'community',
      quoteWorstCaseUsd: () => {
        state.quotes += 1;
        return 0.01;
      },
      async act(ctx) {
        return {
          text: /** @type {string[]} */ (ctx.legalActions)[0],
          usage: { inputTokens: 50, outputTokens: 10, costUsd: 0.001 },
        };
      },
    });

  // Uncapped: the hook is never consulted — there is nothing to protect.
  {
    const outDir = await tempDir('quote-uncapped');
    try {
      const state = { quotes: 0 };
      const result = await runSuite({ suite, games, outDir, agentFactory: () => quoteCountingAgent(state) });
      assert.equal(result.stopped, null);
      assert.equal(state.quotes, 0, 'no cap set: the quote hook was not consulted');
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  }
  // Capped: every admitted call is quoted for admission.
  {
    const outDir = await tempDir('quote-capped');
    try {
      const state = { quotes: 0 };
      const result = await runSuite({
        suite,
        games,
        outDir,
        maxUsd: 1,
        agentFactory: () => quoteCountingAgent(state),
      });
      assert.equal(result.stopped, null);
      assert.equal(state.quotes, 2, 'a cap set: every admitted call is quoted');
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  }
});

test('the identity probe does not consume an episode from the factory', async () => {
  const outDir = await tempDir('probe-reuse');
  try {
    const suite = buildSuite([takeOrPass], { split: 'public' }); // 2 one-shot jobs
    let created = 0;
    /** @type {number[]} */
    const actedWith = [];
    const factory = () => {
      const n = created++;
      return /** @type {Agent} */ ({
        id: 'fake-priced',
        track: 'community',
        async act(ctx) {
          actedWith.push(n);
          return {
            text: /** @type {string[]} */ (ctx.legalActions)[0],
            usage: { inputTokens: 50, outputTokens: 10, costUsd: 0.001 },
          };
        },
      });
    };
    const result = await runSuite({
      suite,
      games: [takeOrPass],
      agentFactory: factory,
      outDir,
      maxCalls: 1,
    });
    assert.equal(result.stopped, 'calls');
    // codex r4304962689: the probe's instance must be the one that plays its
    // episode. The factory contract is one instance per episode, so a
    // sequential factory must not see an episode consumed by a probe the run
    // discards: instance 0 acts (the probe), instance 1 is built for the
    // aborted job and never acts.
    assert.deepEqual(actedWith, [0]);
    assert.equal(created, 2);
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});

test('resume refuses when the invocation agent identity cannot be established', async () => {
  const outDir = await tempDir('identity-unknown');
  try {
    const suite = buildSuite([takeOrPass], { split: 'public' });
    const games = [takeOrPass];
    const first = await runSuite({
      suite,
      games,
      agentFactory: pricedFactory(),
      outDir,
      maxCalls: 1,
    });
    assert.equal(first.stopped, 'calls');
    assert.equal(first.run.counts.played, 1);

    // greptile r4305577240: a failed probe used to null the incoming identity
    // and skip the mixed-agent refusal entirely. Identity must be
    // established to add to a played bundle: a later factory call could
    // succeed with a different agent and mix the bundle.
    await assert.rejects(
      runSuite({
        suite,
        games,
        outDir,
        resume: true,
        agentFactory: () => {
          throw new Error('probe factory explodes');
        },
      }),
      /identity could not be established/
    );
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});

test('resume refuses a factory that varies agent identity across jobs before it plays', async () => {
  const outDir = await tempDir('identity-varies');
  try {
    const suite = buildSuite([takeOrPass], { split: 'public' });
    const games = [takeOrPass];
    const jobs = planJobs(suite);
    const first = await runSuite({
      suite,
      games,
      agentFactory: pricedFactory(),
      outDir,
      maxCalls: 1,
    });
    assert.equal(first.stopped, 'calls');
    assert.equal(first.run.counts.played, 1);

    // codex r4304962694: the resume's factory returns the recorded agent for
    // jobs[0] (skipped as verified) and a different agent for the remaining
    // job. The refusal must fire before the different agent plays a single
    // move: writing its episode beside the recorded ones mixes two agents
    // into one bundle, which bundle scoring refuses.
    let bActs = 0;
    const makeB = () =>
      /** @type {Agent} */ ({
        id: 'fake-priced-b',
        track: 'community',
        async act(ctx) {
          bActs += 1;
          return {
            text: /** @type {string[]} */ (ctx.legalActions)[0],
            usage: { inputTokens: 50, outputTokens: 10, costUsd: 0.001 },
          };
        },
      });
    await assert.rejects(
      runSuite({
        suite,
        games,
        outDir,
        resume: true,
        agentFactory: (job) => (job.key === jobs[0].key ? pricedFactory()(job) : makeB()),
      }),
      /refusing to mix two agents/
    );
    assert.equal(bActs, 0, 'the different agent must not play a single move');

    // The bundle still belongs to the original agent only.
    const trajectories = await readTrajectories(outDir);
    assert.equal(trajectories.size, 1);
    for (const t of trajectories.values()) {
      assert.equal(t.agent?.id, 'fake-priced');
    }
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});

test('a refused resume does not touch the spend ledger', async () => {
  const outDir = await tempDir('ledger-refusal');
  try {
    const suite = buildSuite([takeOrPass], { split: 'public' });
    const games = [takeOrPass];
    const first = await runSuite({
      suite,
      games,
      agentFactory: pricedFactory(),
      outDir,
      maxCalls: 1,
      maxUsdTotal: 1,
    });
    assert.equal(first.stopped, 'calls');
    assert.equal(first.run.counts.played, 1);

    // greptile r4305577245: the invocation and cap lines reached the ledger
    // before the resume refusals, so a resume rejected for mixing agents
    // could still raise the bundle's recorded maxUsdTotal as a side effect.
    await assert.rejects(
      runSuite({
        suite,
        games,
        outDir,
        resume: true,
        maxUsdTotal: 100,
        agentFactory: () =>
          /** @type {Agent} */ ({
            id: 'fake-priced-b',
            track: 'community',
            async act(ctx) {
              return {
                text: /** @type {string[]} */ (ctx.legalActions)[0],
                usage: { inputTokens: 50, outputTokens: 10, costUsd: 0.001 },
              };
            },
          }),
      }),
      /holds trajectories from agent/
    );
    const ledgerText = await readFile(path.join(outDir, SPEND_LEDGER_FILENAME), 'utf8');
    const lines = ledgerText
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l));
    const invocationLines = lines.filter((l) => l.kind === 'invocation');
    const capLines = lines.filter((l) => l.kind === 'cap');
    assert.equal(invocationLines.length, 1, 'the refused resume must not append an invocation line');
    assert.equal(capLines.length, 1, 'the refused resume must not append a cap line');
    assert.equal(capLines[0].maxUsdTotal, 1);
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});

test('an already-stopped run refuses before waiting on the rate limiter', { timeout: 15_000 }, async () => {
  const outDir = await tempDir('stop-before-limiter');
  try {
    const games = [makeGatedGame(2)]; // each episode takes two agent calls
    const suite = buildSuite(games, { split: 'public' });
    /** @type {number[]} */
    const limiterWaits = [];
    let agentCalls = 0;
    const result = await runSuite({
      suite,
      games,
      outDir,
      maxCalls: 1,
      // One token immediately, then one per 1000 ms of real time: an
      // admission that reaches the limiter waits here, and this test's sleep
      // never resolves. The second call of the first episode must be refused
      // at the pre-limiter stop check instead of queueing on the limiter just
      // to rediscover the cap (codex r4304962691, greptile r4305577252).
      requestsPerMinute: 60,
      sleep: async (ms) => {
        limiterWaits.push(ms);
        await new Promise(() => {});
      },
      agentFactory: () =>
        /** @type {Agent} */ ({
          id: 'fake-priced',
          track: 'community',
          async act(ctx) {
            agentCalls += 1;
            return {
              text: /** @type {string[]} */ (ctx.legalActions)[0],
              usage: { inputTokens: 50, outputTokens: 10, costUsd: 0.001 },
            };
          },
        }),
    });
    assert.equal(result.stopped, 'calls');
    assert.equal(agentCalls, 1);
    assert.deepEqual(limiterWaits, [], 'the capped admission must refuse before waiting on the limiter');
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});


test('resume refuses an agent whose identity is missing once identity is established', async () => {
  const outDir = await tempDir('identity-missing');
  try {
    const suite = buildSuite([takeOrPass], { split: 'public' });
    const games = [takeOrPass];
    const jobs = planJobs(suite);
    const first = await runSuite({
      suite,
      games,
      agentFactory: pricedFactory(),
      outDir,
      maxCalls: 1,
    });
    assert.equal(first.stopped, 'calls');
    assert.equal(first.run.counts.played, 1);

    // codex r4309389116: the probe establishes agent A, but a later factory
    // call returns an object with act() and no string id. A null live
    // identity used to skip the worker's check entirely, so the identityless
    // agent played and wrote a trajectory with an undefined agent id — the
    // run reported success over a bundle scoring refuses. A missing live
    // identity is fatal during resume, exactly like a mismatched one.
    let noIdActs = 0;
    await assert.rejects(
      runSuite({
        suite,
        games,
        outDir,
        resume: true,
        agentFactory: (job) =>
          job.key === jobs[0].key
            ? pricedFactory()(job)
            : /** @type {Agent} */ ({
                track: 'community',
                async act(ctx) {
                  noIdActs += 1;
                  return {
                    text: /** @type {string[]} */ (ctx.legalActions)[0],
                    usage: { inputTokens: 50, outputTokens: 10, costUsd: 0.001 },
                  };
                },
              }),
      }),
      /no usable identity/
    );
    assert.equal(noIdActs, 0, 'the identityless agent must not play a single move');

    // The bundle still holds only the original agent's trajectory.
    const trajectories = await readTrajectories(outDir);
    assert.equal(trajectories.size, 1);
    for (const t of trajectories.values()) {
      assert.equal(t.agent?.id, 'fake-priced');
    }
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});

test('a worker-refused resume leaves the spend ledger untouched until an agent plays', async () => {
  const outDir = await tempDir('ledger-worker-refusal');
  try {
    const suite = buildSuite([takeOrPass], { split: 'public' });
    const games = [takeOrPass];
    const jobs = planJobs(suite);
    const first = await runSuite({
      suite,
      games,
      agentFactory: pricedFactory(),
      outDir,
      maxCalls: 1,
      maxUsdTotal: 1,
    });
    assert.equal(first.stopped, 'calls');
    assert.equal(first.run.counts.played, 1);

    // codex r4309389123: the probe matches the recorded agent, but a later
    // factory call returns a different one — the ResumeIdentityError fires
    // in the worker, after the invocation and cap lines used to be written.
    // Admission lines must land only once an agent has passed the identity
    // check and plays, so a worker-refused resume leaves the ledger
    // byte-identical and a later resume cannot inherit its raised cap.
    await assert.rejects(
      runSuite({
        suite,
        games,
        outDir,
        resume: true,
        maxUsdTotal: 100,
        agentFactory: (job) =>
          job.key === jobs[0].key
            ? pricedFactory()(job)
            : /** @type {Agent} */ ({
                id: 'fake-priced-b',
                track: 'community',
                async act(ctx) {
                  return {
                    text: /** @type {string[]} */ (ctx.legalActions)[0],
                    usage: { inputTokens: 50, outputTokens: 10, costUsd: 0.001 },
                  };
                },
              }),
      }),
      /refusing to mix two agents/
    );
    const readLedger = async () => {
      const text = await readFile(path.join(outDir, SPEND_LEDGER_FILENAME), 'utf8');
      return text
        .split('\n')
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l));
    };
    let lines = await readLedger();
    assert.equal(
      lines.filter((l) => l.kind === 'invocation').length,
      1,
      'the worker-refused resume must not append an invocation line'
    );
    assert.equal(lines.filter((l) => l.kind === 'cap').length, 1, 'the worker-refused resume must not append a cap line');
    assert.equal(lines.find((l) => l.kind === 'cap')?.maxUsdTotal, 1);

    // A later valid resume plays and DOES commit its admission lines: the
    // deferral defers, it does not drop.
    const second = await runSuite({
      suite,
      games,
      outDir,
      resume: true,
      maxUsdTotal: 100,
      agentFactory: pricedFactory(),
    });
    assert.equal(second.run.counts.played, 1);
    lines = await readLedger();
    const invocationLines = lines.filter((l) => l.kind === 'invocation');
    const capLines = lines.filter((l) => l.kind === 'cap');
    assert.equal(invocationLines.length, 2, 'the valid resume commits its invocation line');
    assert.equal(capLines.length, 2, 'the valid resume commits its raised cap');
    assert.equal(capLines[1].maxUsdTotal, 100);
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});

test('an already-exhausted dollar cap refuses before the rate-limiter wait', async () => {
  const outDir = await tempDir('pre-limiter-cap');
  try {
    const suite = buildSuite([takeOrPass], { split: 'public' });
    const games = [takeOrPass];

    // codex r4309389121: the pre-limiter checks covered maxCalls only, so a
    // call that settled exactly on maxUsd left the next call queueing a full
    // rate-limit interval before the post-limiter check refused it. With a
    // one-request-per-minute limiter that wait is 60s; the refusal must land
    // before the wait. The settled-cap checks stay authoritative after the
    // limiter (reservations and this call's quote are only decided there).
    /** @type {number[]} */
    const sleeps = [];
    const result = await runSuite({
      suite,
      games,
      agentFactory: pricedFactory({ costUsd: 0.001 }),
      outDir,
      concurrency: 1,
      maxUsd: 0.001,
      requestsPerMinute: 1,
      sleep: async (/** @type {number} */ ms) => {
        sleeps.push(ms);
      },
    });
    assert.equal(result.stopped, 'budget');
    const limiterWaits = sleeps.filter((/** @type {number} */ ms) => ms >= 30_000);
    assert.equal(
      limiterWaits.length,
      0,
      `a call waited on the rate limiter after the settled cap was already exhausted: ${JSON.stringify(sleeps)}`
    );
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});

test('resume disposes a refused factory agent before rejecting it', async () => {
  const outDir = await tempDir('dispose-refused');
  try {
    const suite = buildSuite([takeOrPass], { split: 'public' });
    const games = [takeOrPass];
    const jobs = planJobs(suite);
    const first = await runSuite({
      suite,
      games,
      agentFactory: pricedFactory(),
      outDir,
      maxCalls: 1,
    });
    assert.equal(first.stopped, 'calls');
    assert.equal(first.run.counts.played, 1);

    // codex r4309389127: an agent refused on resume-identity grounds never
    // reaches runEpisode(), whose disposeActors() owns agent cleanup — an
    // eagerly started subprocess or stdin subscription the agent holds leaks
    // until process exit. The refusal must dispose the agent first, both at
    // the entry check (the probe) and in the worker.
    /** @type {string[]} */
    const disposed = [];

    // Entry refusal: the probe itself returns a mismatched agent.
    await assert.rejects(
      runSuite({
        suite,
        games,
        outDir,
        resume: true,
        agentFactory: () =>
          /** @type {Agent} */ ({
            id: 'fake-other',
            track: 'community',
            dispose: async () => {
              disposed.push('entry');
            },
            async act(/** @type {import('../core/types.js').TurnContext} */ ctx) {
              return { text: /** @type {string[]} */ (ctx.legalActions)[0] };
            },
          }),
      }),
      /first mismatch/
    );
    assert.ok(disposed.includes('entry'), 'the refused probe agent must be disposed before the entry refusal surfaces');

    // Worker refusal: the probe establishes agent A (jobs[0] reuses it), a
    // later factory call returns agent B with a live dispose.
    await assert.rejects(
      runSuite({
        suite,
        games,
        outDir,
        resume: true,
        agentFactory: (/** @type {Job} */ job) =>
          job.key === jobs[0].key
            ? pricedFactory()(job)
            : /** @type {Agent} */ ({
                id: 'fake-other',
                track: 'community',
                dispose: async () => {
                  disposed.push('worker');
                },
                async act(/** @type {import('../core/types.js').TurnContext} */ ctx) {
                  return { text: /** @type {string[]} */ (ctx.legalActions)[0] };
                },
              }),
      }),
      /mix two agents/
    );
    assert.ok(disposed.includes('worker'), 'the refused factory agent must be disposed before the rejection surfaces');

    // The bundle still holds only the original agent's trajectory.
    const trajectories = await readTrajectories(outDir);
    assert.equal(trajectories.size, 1);
    for (const t of trajectories.values()) {
      assert.equal(t.agent?.id, 'fake-priced');
    }
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});
