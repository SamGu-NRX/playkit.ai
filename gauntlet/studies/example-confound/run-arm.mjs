#!/usr/bin/env node
/**
 * Run ONE example-confound arm against an already-serving llama.cpp server
 * (pinned method, identical to model-separation-v2's serve-and-run.sh:
 * b11662, ctx 4096, temp 0, seed 42, threads 8, one warm-up call, concurrency
 * 1, 256-token reply cap, 60 s call timeout).
 *
 * The study's agentFactory wraps the standard model agent in the preregistered
 * example-patch stack and nothing else:
 *
 * - corrected-official / corrected-7b: patch(model)          [arm 1 / arm 3]
 * - corrected-assisted:                patch(assisted(model)) [arm 2]
 * - connect4-neutral:                  patch(model)          [arm 4]
 *
 * Everything downstream (runner, referee, scoring, bundle layout, run.json)
 * is the standard gauntlet path, so every bundle verifies with
 * `node cli/gauntlet.js bundle verify <outDir>`.
 *
 * Usage:
 *   node run-arm.mjs --arm corrected-official --model qwen2.5-0.5b-instruct-q4_k_m \
 *     --out runs/qwen2.5-0.5b-instruct-q4_k_m/mastermind-mini-corrected \
 *     [--game mastermind --tier mini --seeds 8] [--base-url http://127.0.0.1:8080] \
 *     [--dry-run] [--resume]
 *
 * Arm defaults the game/tier/seeds (pinned in PREREGISTRATION.md): the three
 * mastermind arms are mastermind/mini with 8 public seeds; connect4-neutral is
 * connect4/ladder-1 with 12 public seeds.
 *
 * @module
 */

import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GAMES, listGames } from '../../games/index.js';
import { publicSeed } from '../../core/seeds.js';
import { runSuite } from '../../runs/run.js';
import { findTier } from '../../core/runner.js';
import { parseAgentSpec } from '../../cli/agents.js';
import { createAssistedAgent } from '../../community/assisted-agent.js';
import { createExamplePatchAgent } from './patch-example-agent.js';
import {
  MASTERMIND_MINI_CORRECTED,
  CONNECT4_LADDER_1_NEUTRAL,
} from './patches.js';

const ARMS = /** @type {const} */ ({
  'corrected-official': { patchSet: MASTERMIND_MINI_CORRECTED, assisted: false },
  'corrected-7b': { patchSet: MASTERMIND_MINI_CORRECTED, assisted: false },
  'corrected-assisted': { patchSet: MASTERMIND_MINI_CORRECTED, assisted: true },
  'connect4-neutral': { patchSet: CONNECT4_LADDER_1_NEUTRAL, assisted: false },
});

/** @type {Record<string, { gameId: string, tierId: string, seeds: number }>} */
const ARM_DEFAULTS = {
  'corrected-official': { gameId: 'mastermind', tierId: 'mini', seeds: 8 },
  'corrected-7b': { gameId: 'mastermind', tierId: 'mini', seeds: 8 },
  'corrected-assisted': { gameId: 'mastermind', tierId: 'mini', seeds: 8 },
  'connect4-neutral': { gameId: 'connect4', tierId: 'ladder-1', seeds: 12 },
};

function parseArgs(argv) {
  /** @type {Record<string, string | boolean>} */
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) throw new Error(`unexpected positional argument: ${arg}`);
    const eq = arg.indexOf('=');
    if (eq < 0) {
      // --key value (next argv) when a value follows and is not a flag;
      // otherwise a bare boolean flag.
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        out[arg.slice(2)] = next;
        i++;
      } else {
        out[arg.slice(2)] = true;
      }
    } else {
      out[arg.slice(2, eq)] = arg.slice(eq + 1);
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const arm = /** @type {keyof typeof ARMS} */ (String(args.arm ?? ''));
const armSpec = ARMS[arm];
if (!armSpec) {
  console.error(`unknown arm "${arm}" (have: ${Object.keys(ARMS).join(', ')})`);
  process.exit(2);
}
const defaults = ARM_DEFAULTS[arm];
const gameId = String(args.game ?? defaults.gameId);
const tierId = String(args.tier ?? defaults.tierId);
const seedCount = Number(args.seeds ?? defaults.seeds);
const model = String(args.model ?? 'qwen2.5-0.5b-instruct-q4_k_m');
const baseUrl = String(args['base-url'] ?? 'http://127.0.0.1:8080');
const outDir = String(args.out ?? '');
const dryRun = args['dry-run'] === true;
const resume = args.resume === true;

if (!outDir) {
  console.error('--out=<dir> is required (the run output directory)');
  process.exit(2);
}
if (!Number.isInteger(seedCount) || seedCount < 1) {
  console.error('--seeds must be a positive integer');
  process.exit(2);
}
// Guard the preregistration's game/tier pairing: a patch set applied to a game
// it was not preregistered for throws at the first turn anyway; failing here
// names the mistake before any episode starts.
if (
  (arm === 'connect4-neutral' && gameId !== 'connect4') ||
  (arm !== 'connect4-neutral' && gameId !== 'mastermind')
) {
  console.error(`arm "${arm}" is preregistered for ${arm === 'connect4-neutral' ? 'connect4' : 'mastermind'}, not "${gameId}"`);
  process.exit(2);
}

const game = GAMES[gameId];
if (!game) {
  console.error(`unknown game "${gameId}"`);
  process.exit(2);
}
const spec = game.spec;
const def = spec.tiers.find((t) => t.id === tierId);
if (!def) {
  console.error(`game "${gameId}" has no tier "${tierId}" (has: ${spec.tiers.map((t) => t.id).join(', ')})`);
  process.exit(2);
}

/** @type {import('../scoring/suite.js').SuiteManifest} */
const suite = {
  format: 'playkit-gauntlet-suite/1',
  id: `gauntlet-public-example-confound-${arm}-${gameId}-${tierId}-${seedCount}`,
  split: 'public',
  saltCommitment: null,
  games: [
    {
      id: spec.id,
      version: spec.version,
      requires: spec.requires ?? [],
      tiers: [
        {
          id: def.id,
          rank: def.rank,
          scoring: def.scoring,
          ...(def.parKind ? { parKind: def.parKind } : {}),
          seeds: Array.from({ length: seedCount }, (_, i) => publicSeed(spec.id, def.id, i)),
        },
      ],
    },
  ],
};

// A --dry-run rehearsal replays scripted replies (no server is dialed). When
// no script is given, synthesize one from the arm's game: a function of the
// turn context that always emits a legal-shaped reply, so the rehearsal
// exercises the full path — wrapper stacks, runner, bundle write, verify —
// without spending anything.
let scriptPath = args.script ? String(args.script) : null;
if (dryRun && !scriptPath) {
  scriptPath = join(tmpdir(), `example-confound-dry-run-${gameId}.mjs`);
  writeFileSync(
    scriptPath,
    `// synthesized by studies/example-confound/run-arm.mjs for a --dry-run rehearsal\n` +
    `export default function reply(ctx) {\n` +
    `  return ctx.spec.id === 'connect4' ? '4' : 'guess ABA';\n` +
    `}\n`
  );
}

const agentSpec = await parseAgentSpec(`model:openai-chat/${model}`, {
  ...(dryRun ? { dryRun: true, script: scriptPath } : {}),
  ...(dryRun ? {} : { baseUrl }),
  maxOutputTokens: 256,
  callTimeoutMs: 60000,
});

const result = await runSuite({
  suite,
  games: listGames(),
  outDir,
  concurrency: 1,
  maxCalls: 2500,
  maxOutputTokens: 256,
  callTimeoutMs: 60000,
  ...(resume ? { resume: true } : {}),
  agentFactory: async (job) => {
    const jobGame = GAMES[job.gameId];
    const tier = findTier(jobGame, job.tierId);
    const agentSeat =
      typeof jobGame.agentSeat === 'function' ? jobGame.agentSeat(tier, job.seed) : 0;
    const base = agentSpec.createForEpisode({ game: jobGame, tier, seed: job.seed, agentSeat });
    if (!armSpec.assisted) {
      return createExamplePatchAgent({ inner: base, patchSet: armSpec.patchSet });
    }
    return createExamplePatchAgent({
      inner: createAssistedAgent({ inner: base, retries: 2 }),
      patchSet: armSpec.patchSet,
    });
  },
});

console.log(
  `ARM-COMPLETE arm=${arm} model=${model} game=${gameId}/${tierId} seeds=${seedCount} ` +
    `played=${result.run.counts.played}/${result.run.counts.jobs} replayed=${result.replayed.length} unplayed=${result.unplayed.length} ` +
    `failed=${result.failed.length} stopped=${result.stopped ?? 'null'}` +
    `${result.stopReason ? ` (${result.stopReason})` : ''}`
);
if (result.stopped && result.stopped !== 'completed') process.exit(1);
if (result.failed && result.failed.length > 0) process.exit(1);
