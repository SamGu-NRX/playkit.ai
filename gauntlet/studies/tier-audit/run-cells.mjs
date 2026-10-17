#!/usr/bin/env node
/**
 * Run tier-audit cells.
 *
 *   node run-cells.mjs --games=go --tiers=ladder-1 [--cells=dial-0,copy-example] [--timeout=540]
 *
 * Cells:
 *   dial-0 / dial-05 / dial-1  the skill dial through the real CLI
 *                              (`gauntlet run --agent skill:<p>:baseline:<game>:engine`)
 *                              — one subprocess per cell with a wall-clock
 *                              bound, because the dial drops its expert's
 *                              dispose() (fixed on burst15-playkit-dispose-and-abort)
 *                              and an engine expert's process would otherwise
 *                              outlive its episode.
 *   copy-example / first-legal the no-skill agents, through runs/run.js
 *                              in-process (no external engine state).
 *
 * Bundles land in bundles/<game>/<tier>/<cell>/ and are resumable; a cell
 * whose bundle already carries run.json and every planned seed is skipped.
 * Tiers whose dial cells are covered by the committed skill-dial solo study
 * (version-current, verified here) skip the dial runs and read reuse instead.
 *
 * @module
 */

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { GAMES } from '../../games/index.js';
import { manifestSha256 } from '../../runs/plan.js';
import { runSuite } from '../../runs/run.js';
import { seedsForTier, tierSuite, loadSoloReuse, soloVersionAtStudyHead, soloReuseCurrent, cellBundleVerdict as cellComplete, auditDir, repoRoot, CELL_KINDS } from './audit-lib.mjs';
import { extractExampleToken, createCopyExampleAgent, createFirstLegalAgent } from './no-skill.mjs';
import { NA_CELLS } from './audit-lib.mjs';

/**
 * The structural not-applicable reason for a (tier, cell), or undefined.
 *
 * @param {string} gameId
 * @param {string} tierId
 * @param {string} cell
 */
function naReason(gameId, tierId, cell) {
  return NA_CELLS.get(`${gameId}/${tierId}|${cell}`) ?? NA_CELLS.get(`${gameId}|${cell}`);
}

const root = auditDir();

const gameFilter = opt('games') ? opt('games').split(',') : undefined;
const tierFilter = opt('tiers');
const cellFilter = opt('cells') ? opt('cells').split(',') : [...CELL_KINDS];
const timeoutSec = Number(opt('timeout') ?? 540);
const concurrency = Number(opt('concurrency') ?? 2);

function opt(name) {
  const prefix = `--${name}=`;
  const arg = process.argv.find((a) => a.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : undefined;
}

/** @param {string} msg */
function log(msg) {
  process.stderr.write(`[run-cells] ${msg}\n`);
}

const reuse = await loadSoloReuse();
const reuseVersions = new Map();

for (const gameId of Object.keys(GAMES)) {
  if (gameFilter && !gameFilter.includes(gameId)) continue;
  const game = /** @type {*} */ (GAMES[gameId]);
  const soloVersion = await soloVersionAtStudyHead(gameId);
  for (const tier of game.spec.tiers) {
    if (tierFilter && !tierFilter.split(',').includes(tier.id)) continue;
    const seeds = seedsForTier(gameId, tier);
    await mkdir(join(root, 'bundles', gameId, tier.id), { recursive: true });

    // Reuse currency: the solo study's dial rows are valid only while the
    // game version matches the one it measured.
    const coveredBySolo = ['2048', 'cube', 'mastermind', 'minesweeper', 'sliding', 'sokoban'].includes(gameId);

    for (const cell of cellFilter) {
      const na = naReason(gameId, tier.id, cell);
      if (na) {
        log(`na   ${gameId}/${tier.id} ${cell}: ${na}`);
        continue;
      }
      if (['dial-0', 'dial-05', 'dial-1'].includes(cell)) {
        const p = cell === 'dial-0' ? 0 : cell === 'dial-05' ? 0.5 : 1;
        // Reuse currency: the solo study's dial rows are valid only while the
        // game version matches the one it measured (#108 bumped mastermind
        // and wordle; stale solo rows must not stand in for fresh dial cells).
        const soloCurrent = coveredBySolo && (await soloReuseCurrent(gameId));
        if (coveredBySolo && !soloCurrent) {
          log(
            `reuse STALE ${gameId}/${tier.id} ${cell}: solo study measured game version ${soloVersion ?? 'unknown'}, ` +
              `registry is at ${game.spec.version}; running the cell`
          );
        }
        if (soloCurrent) {
          const missing = seeds.filter((s) => !reuse.has(`${gameId}|${tier.id}|${p}|${s}`));
          if (missing.length === 0) {
            log(`reuse ${gameId}/${tier.id} ${cell} (${seeds.length} seeds, solo v${soloVersion ?? '?'})`);
            continue;
          }
          log(`reuse INCOMPLETE ${gameId}/${tier.id} ${cell}: ${missing.length} missing, running the cell`);
        }
        const bundle = join(root, 'bundles', gameId, tier.id, cell);
        const dialVerdict = await cellComplete(bundle, gameId, tier.id, seeds);
        if (dialVerdict.complete) {
          log(`done ${gameId}/${tier.id} ${cell} (${dialVerdict.reason})`);
          continue;
        }
        log(`re-run ${gameId}/${tier.id} ${cell}: ${dialVerdict.reason}`);
        const { suite } = tierSuite(gameId, tier.id);
        const suitePath = join(root, 'suites', `${gameId}--${tier.id}.json`);
        await mkdir(join(root, 'suites'), { recursive: true });
        await writeFile(suitePath, JSON.stringify(suite, null, 2) + '\n');
        await clearStaleBundle(bundle, suite, `${gameId}/${tier.id} ${cell}`);
        // A prior aborted or timed-out attempt leaves its run.json behind
        // (the CLI's abort path writes it). The wrapper below kills the CLI
        // once run.json EXISTS, so a stale record would kill the resumed run
        // seconds in and the cell could never complete. Remove it: resume
        // replays only the missing seeds, and this attempt writes its own
        // record when it finishes.
        await rm(join(bundle, 'run.json'), { force: true });
        const spec = `skill:${p}:baseline:${gameId}:engine`;
        log(`run  ${gameId}/${tier.id} ${cell} agent=${spec} timeout=${timeoutSec}s`);
        const { spawnSync } = await import('node:child_process');
        // The CLI writes run.json after its last episode, then may hang on
        // leaked engine GTP connections (alpha's engine-dispose gap). Watch
        // for run.json, then kill — the bundle is already complete on disk.
        // The stale record from any earlier attempt was removed above, so
        // the only run.json this poll can see is this attempt's own.
        const outDir = bundle;
        const wrap = [
          'node cli/gauntlet.js run --suite', JSON.stringify(suitePath),
          '--agent', JSON.stringify(spec), '--out', JSON.stringify(outDir),
          '--resume', '--concurrency', String(concurrency), '&',
          'pid=$!;',
          `for i in $(seq 1 ${Math.floor(timeoutSec)}); do`,
          `[ -f ${JSON.stringify(join(outDir, 'run.json'))} ] && sleep 2 && kill $pid 2>/dev/null && break;`,
          'kill -0 $pid 2>/dev/null || break; sleep 1; done;',
          'kill -0 $pid 2>/dev/null && { sleep 60; kill -9 $pid 2>/dev/null; };',
          'wait $pid; exit 0',
        ].join(' ');
        const res = spawnSync('sh', ['-c', wrap], {
          stdio: ['ignore', 'pipe', 'pipe'],
          cwd: resolve(root, '..', '..'),
          timeout: (timeoutSec + 90) * 1000,
        });
        if (res.status !== 0) {
          log(`cell ${gameId}/${tier.id} ${cell} exited ${res.status} (timeout or error); partial bundle kept`);
          const tail = String(res.stderr ?? '').split('\n').filter(Boolean).slice(-8).join('\n');
          process.stderr.write(tail + '\n');
        }
      } else if (cell === 'copy-example' || cell === 'first-legal') {
        const bundle = join(root, 'bundles', gameId, tier.id, cell);
        const noSkillVerdict = await cellComplete(bundle, gameId, tier.id, seeds);
        if (noSkillVerdict.complete) {
          log(`done ${gameId}/${tier.id} ${cell} (${noSkillVerdict.reason})`);
          continue;
        }
        log(`re-run ${gameId}/${tier.id} ${cell}: ${noSkillVerdict.reason}`);
        const { suite } = tierSuite(gameId, tier.id);
        await clearStaleBundle(bundle, suite, `${gameId}/${tier.id} ${cell}`);
        const example = extractExampleToken(game.spec.rulesText);
        const exampleInfo =
          cell === 'copy-example'
            ? { token: example?.token ?? null, source: example ? example.source : 'none' }
            : { token: null, source: 'none' };
        log(`run  ${gameId}/${tier.id} ${cell} (${seeds.length} seeds)`);
        await runSuite({
          suite,
          games: GAMES,
          agentFactory: () =>
            cell === 'copy-example' ? createCopyExampleAgent(exampleInfo) : createFirstLegalAgent(),
          outDir: resolve(bundle),
          concurrency: 2,
          resume: true,
        });
      }
    }
  }
}

log('cells complete for the selection');

/**
 * A cell whose game version changed carries a bundle built from an older
 * suite manifest; resuming into it either refuses (run.js refuses to mix
 * manifests in one bundle) or would strand the stale trajectories inside a
 * bundle claiming the new manifest. Clear the stale bundle when its recorded
 * manifest differs from the incoming one; a fresh or partial bundle of the
 * CURRENT suite is kept and filled by --resume.
 *
 * @param {string} bundle
 * @param {*} suite
 * @param {string} label
 */
async function clearStaleBundle(bundle, suite, label) {
  try {
    const recorded = JSON.parse(await readFile(join(bundle, 'suite.json'), 'utf8'));
    if (manifestSha256(recorded) !== manifestSha256(suite)) {
      log(`clear ${label}: bundle suite manifest differs from the current suite; removing the stale bundle`);
      await rm(bundle, { recursive: true, force: true });
    }
  } catch {
    /* no readable suite.json: nothing committed to compare — resume fills gaps */
  }
}
