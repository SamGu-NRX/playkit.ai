#!/usr/bin/env node
/**
 * One worker of a sharded dump rescan. Runs the SAME scan phase as
 * scripts/sample.js (quality filters, legal replay, bounded per-tier heaps)
 * over one plain-CSV shard of the decompressed Lichess dump and writes the
 * raw heap state plus counters to --shard-out as JSON. The merger
 * (scripts/sample-merge.js) reproduces the exact global top-K selection from
 * the shard heaps: a globally top-ranked candidate is always within its
 * shard's bounded heap (public top-K, eval top-2K), so the union of shard
 * heaps contains the serial result exactly.
 *
 * Usage:
 *   node scripts/sample-shard.js --dump=shard.csv --shard-out=shard.json \
 *     [--seed=burst5-public-v1] [--salt-file=/path/salt.txt]
 *
 * The shard file must be plain CSV (already decompressed) and start with the
 * dump header line, so the column index resolves exactly as in the serial
 * run. The salt is never written to the shard JSON; only per-entry hashes
 * computed with it leave the process.
 *
 * @module
 */

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { scanDump, DEFAULT_SEED } from './sample.js';
import { tierIds } from '../selection.js';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

/**
 * Parse --key=value arguments.
 *
 * @param {string[]} argv
 * @returns {{ dump: string, shardOut: string, seed: string, saltFile: string | null }}
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
  if (!map.dump) throw new Error('--dump=<path to one plain-CSV shard> is required');
  if (!map['shard-out']) throw new Error('--shard-out=<path to the shard JSON output> is required');
  return {
    dump: path.resolve(map.dump),
    shardOut: path.resolve(map['shard-out']),
    seed: map.seed ?? DEFAULT_SEED,
    saltFile: map['salt-file'] ? path.resolve(map['salt-file']) : null,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  process.stderr.write(`scanning shard ${args.dump}\n`);

  const evalSalt = args.saltFile !== null ? (await readFile(args.saltFile, 'utf8')).trim() : null;
  const scan = await scanDump(args.dump, args.seed, evalSalt);

  /** @type {Record<string, number>} */
  const candidatesPerTier = {};
  /** @type {Record<string, unknown>} */
  const publicHeaps = {};
  /** @type {Record<string, unknown> | null} */
  const evalHeaps = evalSalt !== null ? {} : null;
  for (const [tierId, state] of scan.tiers) {
    candidatesPerTier[tierId] = state.candidateCount;
    publicHeaps[tierId] = state.publicHeap;
    if (evalHeaps !== null) evalHeaps[tierId] = state.evalHeap;
  }

  const payload = {
    scanned: scan.scanned,
    rejected: scan.rejected,
    candidatesPerTier,
    publicHeaps,
    evalHeaps,
    // Segment-local dump metadata, informational only: the merger hashes the
    // full decompressed dump itself because SHA-256 does not compose across
    // independently initialized segments.
    shard: { path: args.dump, decompressedBytes: scan.dump.bytes },
  };
  await writeFile(args.shardOut, JSON.stringify(payload), 'utf8');
  const tierCounts = tierIds()
    .map((tierId) => `${tierId}=${candidatesPerTier[tierId] ?? 0}`)
    .join(', ');
  process.stderr.write(
    `shard done: scanned ${scan.scanned} rows; candidates per tier: ${tierCounts}\n` +
      `shard state written to ${args.shardOut}\n`
  );
}

main().catch((err) => {
  process.stderr.write(`sample-shard.js failed: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exitCode = 1;
});
