/**
 * The study runner: enumerates every (game, tier, p) cell in the plan,
 * runs them as bounded child processes (`run-cell.mjs`), and waits for all
 * of them. Trajectory ndjson lands under `runs/<game>/<tier>/p<pp>.ndjson`.
 * Deterministic per cell — every agent is seeded — so any rerun produces
 * byte-identical trajectories given the same code.
 *
 * @module
 */

import { spawn } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

import { PS, planCells } from './config.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const runsDir = resolve(here, 'runs');

const argv = process.argv.slice(2);
const concurrency = Math.max(1, Math.min(8, Number((argv.find((a) => a.startsWith('--concurrency=')) ?? '--concurrency=7').split('=')[1]) || 7));
const only = argv.find((a) => a.startsWith('--only='))?.split('=')[1] ?? '';

rmSync(runsDir, { recursive: true, force: true });
mkdirSync(runsDir, { recursive: true });

/** @type {{ gameId: string, tierId: string, p: number, out: string }[]} */
const jobs = [];
for (const { gameId, tierId } of planCells()) {
  for (const p of PS) {
    const pTag = `p${Math.round(p * 100)}`;
    if (only && `${gameId}/${tierId}/${pTag}` !== only) continue;
    jobs.push({ gameId, tierId, p, out: join(runsDir, gameId, tierId, `${pTag}.ndjson`) });
  }
}

const totalJobs = jobs.length;
console.log(`run-study: ${totalJobs} cells, concurrency ${concurrency}, runs in ${runsDir}`);

/** @type {{ job: string, code: number | null, signal: string | null, stderr: string }[]} */
const failures = [];
let startedCount = 0;
let finishedCount = 0;
const startedAt = Date.now();

async function runCell(job) {
  const tag = `${job.gameId}/${job.tierId}/${Math.round(job.p * 100)}`;
  const child = spawn(
    process.execPath,
    [join(here, 'run-cell.mjs'), `--game=${job.gameId}`, `--tier=${job.tierId}`, `--p=${job.p}`, `--out=${job.out}`],
    { stdio: ['ignore', 'inherit', 'pipe'] }
  );
  /** @type {string[]} */
  const errChunks = [];
  child.stderr.on('data', (chunk) => errChunks.push(String(chunk)));
  await new Promise((resolvePromise) => {
    child.on('close', (code, signal) => resolvePromise({ code, signal }));
  }).then((close) => {
    finishedCount++;
    if (close.code !== 0) {
      failures.push({ job: tag, code: close.code, signal: close.signal, stderr: errChunks.join('').slice(-2000) });
      console.error(`[FAIL] ${tag} (exit ${close.code ?? close.signal}) — ${finishedCount}/${totalJobs}`);
    } else {
      console.log(`[ok] ${tag} — ${finishedCount}/${totalJobs} (${Math.round((Date.now() - startedAt) / 1000)}s)`);
    }
  });
}

/** @type {Promise<void>[]} */
const workers = [];
const queue = jobs.slice();
startedCount = queue.length;
for (let w = 0; w < concurrency; w++) {
  workers.push(
    (async () => {
      for (;;) {
        const job = queue.shift();
        if (!job) return;
        await runCell(job);
      }
    })()
  );
}
await Promise.all(workers);

const seconds = Math.round((Date.now() - startedAt) / 1000);
if (failures.length > 0) {
  console.error(`run-study: ${failures.length}/${totalJobs} cells FAILED after ${seconds}s`);
  for (const failure of failures) {
    console.error(`--- ${failure.job} ---\n${failure.stderr}`);
  }
  process.exit(1);
}
console.log(`run-study: all ${totalJobs} cells done in ${seconds}s -> ${runsDir}`);
