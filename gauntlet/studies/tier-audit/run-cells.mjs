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

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { GAMES } from '../../games/index.js';
import { runSuite } from '../../runs/run.js';
import { seedsForTier, tierSuite, loadSoloReuse, soloVersionAtStudyHead, auditDir, repoRoot, CELL_KINDS } from './audit-lib.mjs';
import { extractExampleToken, createCopyExampleAgent, createFirstLegalAgent } from './no-skill.mjs';

const root = auditDir();

const gameFilter = opt('games');
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
  if (gameFilter && gameId !== gameFilter) continue;
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
      if (['dial-0', 'dial-05', 'dial-1'].includes(cell)) {
        const p = cell === 'dial-0' ? 0 : cell === 'dial-05' ? 0.5 : 1;
        if (coveredBySolo) {
          const missing = seeds.filter((s) => !reuse.has(`${gameId}|${tier.id}|${p}|${s}`));
          if (missing.length === 0) {
            log(`reuse ${gameId}/${tier.id} ${cell} (${seeds.length} seeds, solo v${soloVersion ?? '?'})`);
            continue;
          }
          log(`reuse INCOMPLETE ${gameId}/${tier.id} ${cell}: ${missing.length} missing, running the cell`);
        }
        const bundle = join(root, 'bundles', gameId, tier.id, cell);
        if (await cellComplete(bundle, gameId, tier.id, seeds)) {
          log(`done ${gameId}/${tier.id} ${cell}`);
          continue;
        }
        const { suite } = tierSuite(gameId, tier.id);
        const suitePath = join(root, 'suites', `${gameId}--${tier.id}.json`);
        await mkdir(join(root, 'suites'), { recursive: true });
        await writeFile(suitePath, JSON.stringify(suite, null, 2) + '\n');
        const spec = `skill:${p}:baseline:${gameId}:engine`;
        log(`run  ${gameId}/${tier.id} ${cell} agent=${spec} timeout=${timeoutSec}s`);
        const { spawnSync } = await import('node:child_process');
        const res = spawnSync(
          'timeout',
          ['-k', '30', String(timeoutSec), 'node', 'cli/gauntlet.js', 'run', '--suite', suitePath, '--agent', spec, '--out', bundle, '--resume', '--concurrency', String(concurrency)],
          { stdio: ['ignore', 'pipe', 'pipe'], cwd: repoRoot() }
        );
        if (res.status !== 0) {
          log(`cell ${gameId}/${tier.id} ${cell} exited ${res.status} (timeout or error); partial bundle kept`);
        }
      } else if (cell === 'copy-example' || cell === 'first-legal') {
        const bundle = join(root, 'bundles', gameId, tier.id, cell);
        if (await cellComplete(bundle, gameId, tier.id, seeds)) {
          log(`done ${gameId}/${tier.id} ${cell}`);
          continue;
        }
        const { suite } = tierSuite(gameId, tier.id);
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

/**
 * True when the bundle has run.json and a trajectory for every seed.
 *
 * @param {string} bundle
 * @param {string[]} seeds
 */
async function cellComplete(bundle, gameId, tierId, seeds) {
  if (!existsSync(join(bundle, 'run.json'))) return false;
  try {
    const run = JSON.parse(await readFile(join(bundle, 'run.json'), 'utf8'));
    const count = Number(run?.total?.episodes ?? 0);
    if (count >= seeds.length) return true;
  } catch {
    /* fall through to file listing */
  }
  return seeds.every((s) => existsSync(join(bundle, gameId, tierId, `${s}.json`)));
}

log('cells complete for the selection');
