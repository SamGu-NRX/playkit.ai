#!/usr/bin/env node
/**
 * Merge sharded scan outputs (scripts/sample-shard.js) into the exact data
 * files the serial sampler would have written. Per tier, the global public
 * sample is the top-K of the union of the shard top-K heaps: every globally
 * top-K candidate is within its own shard's top-K (there are at most K-1
 * candidates ranked above it worldwide), so the union contains the serial
 * selection exactly and re-ranking it reproduces the serial order. The eval
 * sample works the same way over the top-2K buffers, then excludes the
 * public sample — at most PER_TIER of the buffer can be public members, so
 * the trimmed selection is exactly "the first PER_TIER by eval hash among
 * non-public", identical to the serial run.
 *
 * Provenance (SHA-256 and sizes) is recomputed from the full decompressed
 * dump and the .zst file, because SHA-256 does not compose across shard
 * segments. Counters (rows scanned, rejections, per-tier candidates) sum
 * across shards.
 *
 * Usage:
 *   node scripts/sample-merge.js --shards=a.json,b.json,... \
 *     --csv=/path/lichess_db_puzzle.csv --zst=/path/lichess_db_puzzle.csv.zst \
 *     [--seed=burst5-public-v1] [--data-dir=...] [--dump-url=...] \
 *     [--salt-file=/path/salt.txt --eval-out=/path/outside/repo.jsonl] [--run-note="..."]
 *
 * @module
 */

import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PER_TIER, TIERS } from '../selection.js';
import {
  compareEntries,
  finalizeSelection,
  fetchLastModified,
  writeEvalSample,
  writePublicSample,
  DEFAULT_SEED,
} from './sample.js';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const GAME_DIR = path.resolve(SCRIPT_DIR, '..');
const DATA_DIR = path.resolve(GAME_DIR, 'data');
const REPO_ROOT = path.resolve(GAME_DIR, '..', '..', '..');

/**
 * Parse --key=value arguments.
 *
 * @param {string[]} argv
 * @returns {{ shards: string[], csv: string, zst: string, seed: string, dataDir: string, dumpUrl: string, saltFile: string | null, evalOut: string | null, runNote: string | null }}
 */
function parseArgs(argv) {
  /** @type {Record<string, string>} */
  const map = {};
  for (const arg of argv) {
    const match = /^--([a-zA-Z-]+)=(.*)$/.exec(arg);
    if (!match) {
      throw new Error(`unrecognized argument ${JSON.stringify(arg)} (expected --key=value)`);
    }
    map[match[1]] = match[2];
  }
  if (!map.shards) throw new Error('--shards=<comma-separated shard JSON paths> is required');
  if (!map.csv) throw new Error('--csv=<path to the full decompressed dump> is required');
  if (!map.zst) throw new Error('--zst=<path to the compressed dump .zst> is required');
  if (map['salt-file'] && !map['eval-out']) throw new Error('--salt-file requires --eval-out');
  if (map['eval-out'] && !map['salt-file']) throw new Error('--eval-out requires --salt-file');
  return {
    shards: map.shards.split(',').map((entry) => path.resolve(entry.trim())),
    csv: path.resolve(map.csv),
    zst: path.resolve(map.zst),
    seed: map.seed ?? DEFAULT_SEED,
    dataDir: map['data-dir'] ? path.resolve(map['data-dir']) : DATA_DIR,
    dumpUrl: map['dump-url'] ?? 'https://database.lichess.org/lichess_db_puzzle.csv.zst',
    saltFile: map['salt-file'] ? path.resolve(map['salt-file']) : null,
    evalOut: map['eval-out'] ? path.resolve(map['eval-out']) : null,
    runNote: map['run-note'] ?? null,
  };
}

/**
 * Hash a file's bytes (the decompressed dump) without loading it whole.
 *
 * @param {string} filePath
 * @returns {Promise<{ sha256: string, bytes: number }>}
 */
function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    let bytes = 0;
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => {
      hash.update(chunk);
      bytes += chunk.length;
    });
    stream.on('end', () => resolve({ sha256: hash.digest('hex'), bytes }));
    stream.on('error', reject);
  });
}

/**
 * A merged heap entry, as emitted by sample-shard.js.
 *
 * @typedef {object} HeapEntry
 * @property {string} hash
 * @property {string} id
 * @property {import('../selection.js').PuzzleRecord} record
 */

/**
 * @param {Record<string, unknown> | null} heaps
 * @param {string} tierId
 * @returns {HeapEntry[]}
 */
function tierHeap(heaps, tierId) {
  if (!heaps) return [];
  const group = /** @type {HeapEntry[] | undefined} */ (heaps[tierId]);
  if (!group) throw new Error(`shard output is missing the ${tierId} heap`);
  return group;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.shards.length === 0) throw new Error('at least one shard output is required');

  if (args.evalOut !== null) {
    const evalOut = path.resolve(args.evalOut);
    if (evalOut.startsWith(REPO_ROOT + path.sep)) {
      throw new Error(
        `--eval-out must be OUTSIDE the repository (got ${evalOut}); the eval sample is the hidden split`
      );
    }
  }

  // Union the shard heaps per tier; count and reject maps sum across shards.
  /** @type {Map<string, HeapEntry[]>} */
  const publicUnions = new Map(TIERS.map((tier) => [tier.id, []]));
  /** @type {Map<string, HeapEntry[]>} */
  const evalUnions = new Map(TIERS.map((tier) => [tier.id, []]));
  /** @type {Map<string, number>} */
  const candidatesPerTier = new Map(TIERS.map((tier) => [tier.id, 0]));
  /** @type {Record<string, number>} */
  const rejected = {};
  let scanned = 0;
  let shardsWithEval = 0;

  for (const shardPath of args.shards) {
    const shard = JSON.parse(await readFile(shardPath, 'utf8'));
    scanned += shard.scanned ?? 0;
    for (const [reason, count] of Object.entries(shard.rejected ?? {})) {
      rejected[reason] = (rejected[reason] ?? 0) + Number(count);
    }
    for (const tier of TIERS) {
      candidatesPerTier.set(tier.id, (candidatesPerTier.get(tier.id) ?? 0) + (shard.candidatesPerTier?.[tier.id] ?? 0));
      publicUnions.get(tier.id)?.push(...tierHeap(shard.publicHeaps, tier.id));
      const evalHeap = tierHeap(shard.evalHeaps, tier.id);
      if (evalHeap.length > 0) evalUnions.get(tier.id)?.push(...evalHeap);
    }
    if (shard.evalHeaps !== null && shard.evalHeaps !== undefined) shardsWithEval++;
  }

  // Rebuild scan state: each tier's union, already globally correct, feeds
  // finalizeSelection, which applies the exact serial trimming rules.
  /** @type {Map<string, { publicHeap: HeapEntry[], evalHeap: HeapEntry[], candidateCount: number }>} */
  const tiers = new Map();
  for (const tier of TIERS) {
    const publicHeap = /** @type {HeapEntry[]} */ (publicUnions.get(tier.id)).sort(compareEntries).slice(0, PER_TIER);
    const evalHeap = /** @type {HeapEntry[]} */ (evalUnions.get(tier.id)).sort(compareEntries);
    tiers.set(tier.id, { publicHeap, evalHeap, candidateCount: candidatesPerTier.get(tier.id) ?? 0 });
  }

  const wantsEval = args.saltFile !== null && args.evalOut !== null;
  if (wantsEval && shardsWithEval !== args.shards.length) {
    throw new Error(
      `eval mode requires every shard to carry an eval heap (got ${shardsWithEval}/${args.shards.length}); re-run the shards with --salt-file`
    );
  }
  const evalSalt = wantsEval ? (await readFile(/** @type {string} */ (args.saltFile), 'utf8')).trim() : null;

  const scan = { scanned, rejected, tiers, dump: { sha256: '', bytes: 0, rows: scanned } };
  const result = finalizeSelection(scan, evalSalt);

  if (wantsEval) {
    const evalOut = path.resolve(/** @type {string} */ (args.evalOut));
    process.stderr.write(`eval sample: sharded merge of ${args.shards.length} shards\n`);
    const salt = /** @type {string} */ (evalSalt);
    return writeEvalSample(
      evalOut,
      /** @type {Map<string, import('../selection.js').PuzzleRecord[]>} */ (result.evalSelection),
      salt
    );
  }

  process.stderr.write('hashing the full decompressed dump for provenance...\n');
  const { sha256, bytes } = await hashFile(args.csv);
  const compressed = await stat(args.zst);
  const lastModified = await fetchLastModified(args.dumpUrl);
  return writePublicSample(args.dataDir, result.publicSelection, {
    seed: args.seed,
    sha256,
    bytes,
    compressedBytes: compressed.size,
    scanned: result.scanned,
    rejected: result.rejected,
    candidatesPerTier: result.candidatesPerTier,
    lastModified,
    runNote: args.runNote ?? `sharded rescan: ${args.shards.length} shards via scripts/sample-shard.js, merged by scripts/sample-merge.js`,
  });
}

main().catch((err) => {
  process.stderr.write(`sample-merge.js failed: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exitCode = 1;
});
