#!/usr/bin/env node
/**
 * Run every episode of the solo skill-dial study: all tiers of the six solo
 * games, all six pinned p values, public and study-local eval seeds.
 *
 * Orchestrator mode (default):
 *   node run-study.mjs --out /tmp/skill-dial-solo-runs --workers 6 [--fresh]
 * Worker mode (spawned by the orchestrator):
 *   node run-study.mjs --worker --index K --of N --out DIR
 *
 * Jobs are deterministic (study-lib.allJobs); worker K takes jobs i % N === K.
 * Each episode runs through `core/runner.js` with a fixed wall clock, so the
 * trajectory files are byte-stable across runs. A job whose output already
 * parses as JSON is skipped, which makes interrupted runs resumable. Episodes
 * whose expert throws (cube's optimal solver refuses scrambles beyond its
 * proven range once noise kicks in) are recorded as error records, not
 * trajectories, and counted by the scorer.
 *
 * @module
 */

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runEpisode } from '../../../core/runner.js';
import { GAMES } from '../../../games/index.js';
import { skillDial } from '../../../agents/skill-dial.js';
import { allJobs, expertFor, NOW } from './study-lib.mjs';

const here = dirname(fileURLToPath(import.meta.url));

// Worker entry point: this script itself in production. The seam exists so
// the orchestrator's concurrency can be tested against a stub worker without
// running real episodes.
const WORKER_SCRIPT = process.env.SKILL_DIAL_WORKER_SCRIPT || fileURLToPath(import.meta.url);

/** Parse the CLI args this script understands. */
function parseArgs(argv) {
  const out = { worker: false, index: 0, of: 1, out: null, workers: 1, fresh: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--worker') out.worker = true;
    else if (a === '--fresh') out.fresh = true;
    else if (a === '--index') out.index = Number(argv[++i]);
    else if (a === '--of') out.of = Number(argv[++i]);
    else if (a === '--out') out.out = resolve(argv[++i]);
    else if (a === '--workers') out.workers = Number(argv[++i]);
    else throw new Error(`unknown argument ${a}`);
  }
  if (!out.out) throw new Error('--out is required');
  return out;
}

/**
 * Run one episode and write its record. A trajectory JSON, or — when the
 * expert throws mid-episode — an error record with the same key fields.
 *
 * @param {{ gameId: string, tierId: string, split: 'public' | 'eval', seed: string, p: number, file: string }} job
 * @param {string} outDir
 */
async function runOne(job, outDir) {
  const game = /** @type {*} */ (GAMES[job.gameId]);
  const tier = game.spec.tiers.find((t) => t.id === job.tierId);
  const expert = expertFor(job.gameId, tier, job.seed);
  const dial = skillDial(expert, job.p, { episodeSeed: job.seed });
  const file = join(outDir, job.file);
  mkdirSync(dirname(file), { recursive: true });
  try {
    const trajectory = await runEpisode({
      game,
      tierId: job.tierId,
      seed: job.seed,
      split: job.split,
      agent: dial,
      now: NOW,
    });
    writeFileSync(file, JSON.stringify(trajectory) + '\n');
    return 'ok';
  } catch (err) {
    const record = {
      error: err instanceof Error ? err.message : String(err),
      game: { id: job.gameId, version: game.spec.version },
      tier: job.tierId,
      seed: job.seed,
      split: job.split,
      p: job.p,
      agentId: dial.id,
    };
    writeFileSync(file, JSON.stringify(record) + '\n');
    return 'error';
  }
}

/** Skippable when the file exists and parses (an interrupted run may leave partials). */
function done(file) {
  if (!existsSync(file)) return false;
  try {
    JSON.parse(readFileSync(file, 'utf8'));
    return true;
  } catch {
    return false;
  }
}

const args = parseArgs(process.argv.slice(2));

if (args.worker) {
  const jobs = allJobs().filter((_, i) => i % args.of === args.index);
  let ok = 0;
  let errors = 0;
  let skipped = 0;
  for (const job of jobs) {
    const file = join(args.out, job.file);
    if (done(file)) {
      skipped++;
      continue;
    }
    const verdict = await runOne(job, args.out);
    if (verdict === 'ok') ok++;
    else errors++;
  }
  process.stdout.write(`worker ${args.index}/${args.of}: ${ok} ran, ${errors} errored, ${skipped} skipped\n`);
  process.exit(0);
}

// Orchestrator.
if (args.fresh) {
  await import('node:fs').then((fs) => fs.rmSync(args.out, { recursive: true, force: true }));
}
mkdirSync(args.out, { recursive: true });
const jobs = allJobs();
process.stdout.write(`${jobs.length} episodes across ${args.workers} workers\n`);
/** @type {import('node:child_process').ChildProcess[]} */
const children = [];
// Spawn EVERY worker first, then wait: awaiting inside the loop serialized the
// workers - `--workers 6` ran one episode at a time in six passes.
const workerExits = [];
for (let k = 0; k < args.workers; k++) {
  workerExits.push(
    new Promise((res, rej) => {
      const child = spawn(
        process.execPath,
        [WORKER_SCRIPT, '--worker', '--index', String(k), '--of', String(args.workers), '--out', args.out],
        { stdio: ['ignore', 'pipe', 'inherit'] }
      );
      children.push(child);
      child.stdout.on('data', (d) => process.stdout.write(`  ${d}`));
      child.on('exit', (code) => (code === 0 ? res(code) : rej(new Error(`worker ${k} exited ${code}`))));
    })
  );
}
await Promise.all(workerExits);
const missing = jobs.filter((j) => !done(join(args.out, j.file)));
const errored = jobs.filter((j) => {
  if (missing.includes(j)) return false;
  try {
    return JSON.parse(readFileSync(join(args.out, j.file), 'utf8')).error !== undefined;
  } catch {
    return false;
  }
});
const manifest = {
  jobs: jobs.length,
  ran: jobs.length - missing.length - errored.length,
  errors: errored.length,
  missing: missing.length,
  errorFiles: errored.map((j) => j.file),
};
writeFileSync(join(args.out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
process.stdout.write(
  `bundle: ${manifest.ran} trajectories, ${manifest.errors} error records, ${manifest.missing} missing -> ${args.out}\n`
);
if (manifest.missing > 0) process.exit(1);
