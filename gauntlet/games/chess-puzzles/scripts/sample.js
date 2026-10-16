#!/usr/bin/env node
/**
 * Build the chess-puzzles data files from the CC0 Lichess puzzle database
 * dump (https://database.lichess.org/#puzzles). Node-only tooling: this
 * script may import `node:*` and shell out to zstd; the game module never
 * does. The dump itself lives outside the repository and is never committed.
 *
 * Public mode (the default) streams the dump, applies the quality filters
 * from ../selection.js, checks every candidate's line replays legally, and
 * deterministically selects PER_TIER puzzles per rating band by a seeded hash
 * of PuzzleId. Memory stays bounded: each tier keeps a bounded top-K heap of
 * the best-ranked candidates instead of retaining every candidate (a
 * full-sort selection needs gigabytes for the multi-million-row dump; the
 * bounded heap provably selects the same first K rows ordered by
 * (hash, PuzzleId)). It writes, under gauntlet/games/chess-puzzles/data/:
 *
 *   public.jsonl          the sample, one JSON puzzle record per line
 *   public.generated.js   the same records as an ES module (browser-safe
 *                         import path for puzzles.js; generated, do not edit)
 *   SOURCE.md             provenance: URL, Last-Modified, SHA-256, CC0
 *                         notice, filters, seed, per-tier counts
 *
 * Eval mode (--salt-file + --eval-out) selects the eval sample in the same
 * pass, with the salt from the file and the public sample excluded, and
 * writes ONLY the eval sample to --eval-out — a path outside the repository
 * by construction. The salt is never recorded; only its SHA-256 commitment
 * is printed. The eval heap keeps the top 2*PER_TIER by eval hash: at most
 * PER_TIER of those can be public members, so at least PER_TIER remain and
 * the result is exactly "the first PER_TIER by eval hash among non-public"
 * — identical to a full sort of all candidates.
 *
 * Sharded rescans split the decompressed dump into per-shard plain CSVs:
 * scripts/sample-shard.js runs the same scan phase per shard and emits its
 * bounded heap candidates, and scripts/sample-merge.js unions the heaps and
 * reuses the writers below. A globally top-ranked candidate is always within
 * its shard's bounded heap (public top-K, eval top-2K), so the merged
 * selection is byte-identical to this serial run.
 *
 * Usage:
 *   node scripts/sample.js --dump=/path/lichess_db_puzzle.csv.zst
 *   node scripts/sample.js --dump=... --salt-file=/path/salt.txt --eval-out=/path/eval.jsonl
 *
 * @module
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { replayUci } from '../../chess/engine.js';
import {
  PER_TIER,
  QUALITY,
  TIERS,
  passesQualityFilters,
  selectionHash,
  tierForRating,
  tierIds,
} from '../selection.js';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const GAME_DIR = path.resolve(SCRIPT_DIR, '..');
const DATA_DIR = path.resolve(GAME_DIR, 'data');
const REPO_ROOT = path.resolve(GAME_DIR, '..', '..', '..');
export const DUMP_URL = 'https://database.lichess.org/lichess_db_puzzle.csv.zst';
export const DEFAULT_SEED = 'burst5-public-v1';

/**
 * @typedef {object} Args
 * @property {string} dump
 * @property {string} seed
 * @property {string | null} saltFile
 * @property {string | null} evalOut
 * @property {string} dumpUrl
 * @property {string | null} dataDir
 */

/**
 * Parse --key=value arguments.
 *
 * @param {string[]} argv
 * @returns {Args}
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
  if (!map.dump) throw new Error('--dump=<path to lichess_db_puzzle.csv.zst> is required');
  if (map['salt-file'] && !map['eval-out']) throw new Error('--salt-file requires --eval-out');
  if (map['eval-out'] && !map['salt-file']) throw new Error('--eval-out requires --salt-file');
  return {
    dump: path.resolve(map.dump),
    seed: map.seed ?? DEFAULT_SEED,
    saltFile: map['salt-file'] ? path.resolve(map['salt-file']) : null,
    evalOut: map['eval-out'] ? path.resolve(map['eval-out']) : null,
    dumpUrl: map['dump-url'] ?? DUMP_URL,
    dataDir: map['data-dir'] ? path.resolve(map['data-dir']) : null,
  };
}

/**
 * RFC 4180 field splitter: quoted fields, doubled-quote escapes, commas
 * inside quotes.
 *
 * @param {string} line
 * @returns {string[]}
 */
function splitCsvLine(line) {
  /** @type {string[]} */
  const fields = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (inQuotes) {
      if (char === '"') {
        if (line[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      fields.push(field);
      field = '';
    } else {
      field += char;
    }
  }
  fields.push(field);
  return fields;
}

/**
 * Column indices resolved once from the dump header.
 *
 * @typedef {object} ColumnIndex
 * @property {number} puzzleId
 * @property {number} fen
 * @property {number} moves
 * @property {number} rating
 * @property {number} ratingDeviation
 * @property {number} popularity
 * @property {number} nbPlays
 * @property {number} themes
 * @property {number} gameUrl
 */

/**
 * Resolve column indices from the dump header.
 *
 * @param {string[]} header
 * @returns {ColumnIndex}
 */
function columnIndex(header) {
  /** @type {Record<string, number>} */
  const byName = {};
  header.forEach((name, position) => {
    byName[name] = position;
  });
  /** @type {Record<string, number>} */
  const index = {};
  for (const name of ['PuzzleId', 'FEN', 'Moves', 'Rating', 'RatingDeviation', 'Popularity', 'NbPlays', 'Themes', 'GameUrl']) {
    const position = byName[name];
    if (position === undefined) {
      throw new Error(`dump header is missing the ${name} column`);
    }
    index[name] = position;
  }
  return {
    puzzleId: index.PuzzleId,
    fen: index.FEN,
    moves: index.Moves,
    rating: index.Rating,
    ratingDeviation: index.RatingDeviation,
    popularity: index.Popularity,
    nbPlays: index.NbPlays,
    themes: index.Themes,
    gameUrl: index.GameUrl,
  };
}

/**
 * Stream-decompress the dump with zstd, hashing the raw bytes and parsing
 * rows, calling onRow for every data row with the resolved column index.
 *
 * @param {string} dumpPath
 * @param {(fields: string[], index: ColumnIndex) => void} onRow
 * @returns {Promise<{ sha256: string, bytes: number, rows: number }>}
 */
function streamDump(dumpPath, onRow) {
  return new Promise((resolve, reject) => {
    // A .zst dump streams through zstd; a plain-CSV dump (the sharded runner's
    // per-shard files) streams through cat. Both feed the same readline loop.
    const isZst = dumpPath.endsWith('.zst');
    const child = isZst
      ? spawn('zstd', ['-dc', dumpPath], { stdio: ['ignore', 'pipe', 'inherit'] })
      : spawn('cat', [dumpPath], { stdio: ['ignore', 'pipe', 'inherit'] });
    const zstd = child;
    const hash = createHash('sha256');
    let bytes = 0;
    let rows = 0;
    /** @type {ColumnIndex | null} */
    let index = null;

    const rl = readline.createInterface({ input: zstd.stdout, crlfDelay: Infinity });
    zstd.stdout.on('data', (chunk) => {
      hash.update(chunk);
      bytes += chunk.length;
    });
    // Completion needs BOTH the stream end and the child's exit: readline's
    // close can fire before zstd's exit event delivers the code, so waiting
    // on either alone races (a fast, small dump can exit with code null).
    let rlClosed = false;
    /** @type {number | null} */
    let childCode = null;
    let childClosed = false;
    const finish = () => {
      if (!rlClosed || !childClosed) return;
      if (childCode !== 0) {
        reject(new Error(`zstd exited with code ${childCode}`));
        return;
      }
      resolve({ sha256: hash.digest('hex'), bytes, rows });
    };
    rl.on('line', (line) => {
      if (line.trim().length === 0) return;
      const fields = splitCsvLine(line);
      if (!index) {
        index = columnIndex(fields.map((name) => name.trim()));
        return;
      }
      rows++;
      if (rows % 1000000 === 0) {
        process.stderr.write(`  ... ${rows} rows scanned\n`);
      }
      onRow(fields, index);
    });
    rl.on('close', () => {
      rlClosed = true;
      finish();
    });
    rl.on('error', reject);
    zstd.on('close', (code) => {
      childClosed = true;
      childCode = code;
      finish();
    });
    zstd.on('error', reject);
  });
}

/**
 * Build a puzzle record from CSV fields, or null when the row is malformed.
 *
 * @param {string[]} fields
 * @param {ColumnIndex} index
 * @returns {import('../selection.js').DumpRecord | null}
 */
function recordFromRow(fields, index) {
  const rating = Number(fields[index.rating]);
  const deviation = Number(fields[index.ratingDeviation]);
  const popularity = Number(fields[index.popularity]);
  const plays = Number(fields[index.nbPlays]);
  const puzzleId = fields[index.puzzleId];
  const fen = fields[index.fen];
  const moves = fields[index.moves];
  if (
    !puzzleId ||
    !fen ||
    !moves ||
    !Number.isFinite(rating) ||
    !Number.isFinite(deviation) ||
    !Number.isFinite(popularity) ||
    !Number.isFinite(plays)
  ) {
    return null;
  }
  return {
    PuzzleId: puzzleId,
    FEN: fen,
    Moves: moves,
    Rating: rating,
    RatingDeviation: deviation,
    Popularity: popularity,
    NbPlays: plays,
    Themes: fields[index.themes] ?? '',
    GameUrl: fields[index.gameUrl] ?? '',
  };
}

/**
 * Fetch the dump URL's Last-Modified header (provenance for SOURCE.md).
 *
 * @param {string} dumpUrl
 * @returns {Promise<string>}
 */
export async function fetchLastModified(dumpUrl) {
  try {
    const response = await fetch(dumpUrl, { method: 'HEAD' });
    const modified = response.headers.get('last-modified');
    return modified ?? 'unknown (no Last-Modified header)';
  } catch {
    return 'unknown (HEAD request failed; recorded from the run environment instead)';
  }
}

/**
 * Compare two heap entries by (hash, PuzzleId) ascending.
 *
 * @param {{ hash: string, id: string, record: import('../selection.js').PuzzleRecord }} a
 * @param {{ hash: string, id: string, record: import('../selection.js').PuzzleRecord }} b
 * @returns {number}
 */
export function compareEntries(a, b) {
  if (a.hash !== b.hash) return a.hash < b.hash ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Insert into a bounded top-K heap (a sorted array, smallest first): keeps
 * the `max` smallest entries by (hash, PuzzleId). Memory is capped at `max`
 * entries per heap regardless of how many candidates the dump holds.
 *
 * @param {{ hash: string, id: string, record: import('../selection.js').PuzzleRecord }[]} heap
 * @param {number} max
 * @param {{ hash: string, id: string, record: import('../selection.js').PuzzleRecord }} entry
 * @returns {void}
 */
function heapInsert(heap, max, entry) {
  if (heap.length >= max) {
    if (compareEntries(entry, heap[heap.length - 1]) >= 0) return;
    heap.pop();
  }
  let lo = 0;
  let hi = heap.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (compareEntries(heap[mid], entry) < 0) lo = mid + 1;
    else hi = mid;
  }
  heap.splice(lo, 0, entry);
}

/**
 * Per-tier selection state: a bounded top-K heap for the public seed, a
 * bounded top-2K heap for the eval salt (eval mode only), and the count of
 * quality-passing candidates seen for the tier.
 *
 * @typedef {object} TierState
 * @property {{ hash: string, id: string, record: import('../selection.js').PuzzleRecord }[]} publicHeap
 * @property {{ hash: string, id: string, record: import('../selection.js').PuzzleRecord }[]} evalHeap
 * @property {number} candidateCount
 */

/**
 * Scan a dump file (or one shard of a decompressed dump): apply the quality
 * filters, check line legality, and accumulate bounded per-tier heaps — a
 * public top-K heap by the seed hash, and (when a salt is given) a top-2K
 * eval buffer by the salt hash. No selection or validation happens here;
 * call finalizeSelection to turn the heaps into samples.
 *
 * @param {string} dumpPath
 * @param {string} seed
 * @param {string | null} evalSalt null in public mode.
 * @returns {Promise<ScanResult>}
 */
export async function scanDump(dumpPath, seed, evalSalt) {
  /** @type {Map<string, TierState>} */
  const tiers = new Map(TIERS.map((tier) => [tier.id, { publicHeap: [], evalHeap: [], candidateCount: 0 }]));
  /** @type {Record<string, number>} */
  const rejected = {};
  let scanned = 0;

  const dump = await streamDump(dumpPath, (fields, index) => {
    scanned++;
    const record = recordFromRow(fields, index);
    if (!record) {
      rejected['malformed row'] = (rejected['malformed row'] ?? 0) + 1;
      return;
    }
    const quality = passesQualityFilters(record);
    if (!quality.ok) {
      const reason = quality.reason ?? 'unknown';
      rejected[reason] = (rejected[reason] ?? 0) + 1;
      return;
    }
    let tier;
    try {
      tier = tierForRating(record.Rating);
    } catch {
      const reason = `rating below the lowest band (${TIERS[0].min})`;
      rejected[reason] = (rejected[reason] ?? 0) + 1;
      return;
    }
    try {
      replayUci(record.FEN, record.Moves.split(' '));
    } catch {
      rejected['line does not replay legally'] = (rejected['line does not replay legally'] ?? 0) + 1;
      return;
    }
    const state = /** @type {TierState} */ (tiers.get(tier.id));
    state.candidateCount++;
    heapInsert(state.publicHeap, PER_TIER, {
      hash: selectionHash(seed, record.PuzzleId),
      id: record.PuzzleId,
      record,
    });
    if (evalSalt !== null) {
      heapInsert(state.evalHeap, 2 * PER_TIER, {
        hash: selectionHash(evalSalt, record.PuzzleId),
        id: record.PuzzleId,
        record,
      });
    }
  });

  return { scanned, rejected, tiers, dump };
}

/**
 * Scan output: raw per-tier heap state plus counters and dump metadata. The
 * tiers map is shared with the sharded runner (sample-shard.js) and merger
 * (sample-merge.js), which reproduce the serial selection from it.
 *
 * @typedef {object} ScanResult
 * @property {number} scanned
 * @property {Record<string, number>} rejected
 * @property {Map<string, TierState>} tiers
 * @property {{ sha256: string, bytes: number, rows: number }} dump
 */

/**
 * Finalized selection: the selected records, per-tier candidate counts, and
 * the rejection counters.
 *
 * @typedef {object} FinalSelection
 * @property {number} scanned
 * @property {Record<string, number>} rejected
 * @property {Map<string, number>} candidatesPerTier
 * @property {Map<string, import('../selection.js').PuzzleRecord[]>} publicSelection
 * @property {Map<string, import('../selection.js').PuzzleRecord[]> | null} evalSelection
 * @property {{ sha256: string, bytes: number, rows: number }} dump
 */

/**
 * Turn scan state into the selected samples: the public top-K per tier and,
 * when a salt was used, the eval top-K after excluding the public sample.
 * Throws when a tier cannot fill PER_TIER.
 *
 * @param {ScanResult} scan
 * @param {string | null} evalSalt null in public mode.
 * @returns {FinalSelection}
 */
export function finalizeSelection(scan, evalSalt) {
  // Finalize the heaps into sample arrays, trimming the eval buffer.
  /** @type {Map<string, import('../selection.js').PuzzleRecord[]>} */
  const publicSelection = new Map();
  /** @type {Map<string, import('../selection.js').PuzzleRecord[]> | null} */
  const evalSelection = evalSalt !== null ? new Map() : null;
  /** @type {Map<string, number>} */
  const candidatesPerTier = new Map();
  /** @type {Set<string>} */
  const publicIds = new Set();
  for (const [tierId, state] of scan.tiers) {
    const publicGroup = state.publicHeap.map((entry) => entry.record);
    for (const record of publicGroup) publicIds.add(record.PuzzleId);
    if (publicGroup.length < PER_TIER) {
      throw new Error(
        `tier ${tierId}: only ${state.candidateCount} quality-passing candidates, need ${PER_TIER}; relax a filter or widen the band`
      );
    }
    publicSelection.set(tierId, publicGroup);
    candidatesPerTier.set(tierId, state.candidateCount);
    if (evalSelection !== null) {
      const evalGroup = state.evalHeap
        .map((entry) => entry.record)
        .filter((record) => !publicIds.has(record.PuzzleId))
        .slice(0, PER_TIER);
      if (evalGroup.length < PER_TIER) {
        throw new Error(
          `tier ${tierId}: only ${evalGroup.length} eval candidates after excluding the public sample, need ${PER_TIER}`
        );
      }
      evalSelection.set(tierId, evalGroup);
    }
  }

  const tierCounts = [...candidatesPerTier].map(([id, count]) => `${id}=${count}`).join(', ');
  process.stderr.write(
    `scanned ${scan.scanned} rows (${(scan.dump.bytes / 1e9).toFixed(2)} GB decompressed); candidates per tier: ${tierCounts}\n`
  );
  return {
    scanned: scan.scanned,
    rejected: scan.rejected,
    candidatesPerTier,
    publicSelection,
    evalSelection,
    dump: scan.dump,
  };
}

/**
 * @param {string} text
 * @returns {string}
 */
function escapeForJs(text) {
  return JSON.stringify(text);
}

/**
 * Write the eval sample (the hidden split) and print the salt commitment.
 * Shared by the serial sampler and the sharded merger.
 *
 * @param {string} evalOut absolute path; the caller enforces it is outside the repository.
 * @param {Map<string, import('../selection.js').PuzzleRecord[]>} evalSelection
 * @param {string} evalSalt
 * @returns {Promise<string>}
 */
export async function writeEvalSample(evalOut, evalSelection, evalSalt) {
  /** @type {string[]} */
  const lines = [];
  for (const tierId of tierIds()) {
    for (const record of /** @type {import('../selection.js').PuzzleRecord[]} */ (evalSelection.get(tierId))) {
      lines.push(serializeRecord(record));
    }
  }
  await mkdir(path.dirname(evalOut), { recursive: true });
  await writeFile(evalOut, lines.join('\n') + '\n', 'utf8');
  const commitment = createHash('sha256').update(evalSalt).digest('hex');
  process.stderr.write(
    `eval sample: ${lines.length} puzzles (${PER_TIER} per tier) written to ${evalOut}\n` +
      `salt commitment (SHA-256 of the salt; the salt itself is not stored): ${commitment}\n`
  );
  return 'eval sample written';
}

/**
 * Write the committed public data files — public.jsonl, public.generated.js,
 * and SOURCE.md — from a finalized selection. Shared by the serial sampler
 * and the sharded merger so their outputs are byte-identical.
 *
 * @param {string} dataDir
 * @param {Map<string, import('../selection.js').PuzzleRecord[]>} publicSelection
 * @param {{ seed: string, sha256: string, bytes: number, compressedBytes: number | null, scanned: number, rejected: Record<string, number>, candidatesPerTier: Map<string, number>, lastModified: string, runNote: string | null }} provenance
 * @returns {Promise<string>}
 */
export async function writePublicSample(dataDir, publicSelection, provenance) {
  /** @type {string[]} */
  const jsonl = [];
  /** @type {string[]} */
  const moduleEntries = [];
  for (const tierId of tierIds()) {
    for (const record of /** @type {import('../selection.js').PuzzleRecord[]} */ (publicSelection.get(tierId))) {
      jsonl.push(serializeRecord(record));
      moduleEntries.push(
        `  { "PuzzleId": ${escapeForJs(record.PuzzleId)}, "FEN": ${escapeForJs(record.FEN)}, ` +
          `"Moves": ${escapeForJs(record.Moves)}, "Rating": ${record.Rating}, ` +
          `"RatingDeviation": ${record.RatingDeviation}, "Themes": ${escapeForJs(record.Themes)}, ` +
          `"GameUrl": ${escapeForJs(record.GameUrl)} }`
      );
    }
  }
  await mkdir(dataDir, { recursive: true });
  await writeFile(path.join(dataDir, 'public.jsonl'), jsonl.join('\n') + '\n', 'utf8');
  const moduleSource = [
    '// Generated by ../scripts/sample.js from public.jsonl — do not edit by hand.',
    '// Re-run the sampler (it rewrites both files) instead. The fields match',
    '// public.jsonl exactly; a test asserts the two never drift apart.',
    '/** @type {import("../selection.js").PuzzleRecord[]} */',
    'export const PUZZLES = [',
    moduleEntries.join(',\n'),
    '];',
    '',
  ].join('\n');
  await writeFile(path.join(dataDir, 'public.generated.js'), moduleSource, 'utf8');
  const markdown = sourceMarkdown({
    seed: provenance.seed,
    sha256: provenance.sha256,
    bytes: provenance.bytes,
    compressedBytes: provenance.compressedBytes,
    scanned: provenance.scanned,
    rejected: provenance.rejected,
    candidatesPerTier: provenance.candidatesPerTier,
    lastModified: provenance.lastModified,
    runNote: provenance.runNote,
  });
  await writeFile(path.join(dataDir, 'SOURCE.md'), markdown, 'utf8');
  process.stderr.write(`public sample: ${jsonl.length} puzzles written to ${dataDir}\n`);
  return 'public sample written';
}

/**
 * Serialize a record with the canonical field order for the committed files.
 *
 * @param {import('../selection.js').PuzzleRecord} record
 * @returns {string}
 */
function serializeRecord(record) {
  return JSON.stringify({
    PuzzleId: record.PuzzleId,
    FEN: record.FEN,
    Moves: record.Moves,
    Rating: record.Rating,
    RatingDeviation: record.RatingDeviation,
    Themes: record.Themes,
    GameUrl: record.GameUrl,
  });
}

/**
 * Build SOURCE.md.
 *
 * @param {object} params
 * @param {string} params.seed
 * @param {string} params.sha256
 * @param {number} params.bytes decompressed dump size.
 * @param {number | null} params.compressedBytes .zst file size, when known.
 * @param {number} params.scanned
 * @param {Record<string, number>} params.rejected
 * @param {Map<string, number>} params.candidatesPerTier
 * @param {string} params.lastModified
 * @param {string | null} params.runNote how this sample was produced (sharded runs).
 * @returns {string}
 */
function sourceMarkdown({ seed, sha256, bytes, compressedBytes, scanned, rejected, candidatesPerTier, lastModified, runNote }) {
  const lines = [
    '# Data source: Lichess puzzle database',
    '',
    '## License',
    '',
    'The Lichess puzzle database is released under **CC0 1.0 (public domain dedication)**.',
    'Puzzles are used as data; no attribution is required, and this file records',
    'provenance anyway. <https://creativecommons.org/publicdomain/zero/1.0/>',
    '',
    '## Source',
    '',
    `- URL: <${DUMP_URL}> (format notes: <https://database.lichess.org/#puzzles>)`,
    `- Dump Last-Modified (HTTP header, fetched at sampling time): ${lastModified}`,
    `- Dump SHA-256: \`${sha256}\``,
    `- Dump size: ${bytes} bytes (${(bytes / 1e9).toFixed(2)} GB decompressed)`,
  ];
  if (compressedBytes !== null) {
    lines.push(`- Dump compressed size (.zst): ${compressedBytes} bytes (${(compressedBytes / 1e9).toFixed(2)} GB)`);
  }
  lines.push(
    `- Dump rows scanned: ${scanned}`,
    '- The dump itself is NOT committed; only the sample below is.',
    '',
    '## Sample',
    '',
    '- Sampler: `scripts/sample.js` (this directory), public mode'
  );
  if (runNote !== null) {
    lines.push(`- Run: ${runNote}`);
  }
  lines.push(
    `- Selection seed: \`${seed}\``,
    '- Selection rule: candidates are the rows passing the quality filters and',
    '  replaying legally; within each rating band they are ordered by',
    '  `fnv1a64("<seed>/<PuzzleId>")` (ties by PuzzleId) and the first',
    `  ${PER_TIER} taken. The same dump and seed always produce this exact sample.`,
    `- Quality filters: RatingDeviation <= ${QUALITY.maxRatingDeviation}; Popularity >= ${QUALITY.minPopularity} (Lichess community vote, 0-100);`,
    `  NbPlays >= ${QUALITY.minNbPlays}; solution line replays legally; at most ${QUALITY.maxPlayerMoves} player moves (bounds the episode: maxActions = player moves + 2).`,
    '  Justification: the rating is the human-calibration signal, so only converged',
    '  ratings (small deviation) with enough attempts (NbPlays) are used, and the',
    '  community vote drops puzzles players flagged as broken or dislikeable.',
    '',
    '| Tier | Rating band | Candidates after filters | Selected |',
    '|---|---|---|---|',
  );
  for (const tier of TIERS) {
    lines.push(
      `| ${tier.id} | [${tier.min}, ${tier.max ?? '∞'}) | ${candidatesPerTier.get(tier.id) ?? 0} | ${PER_TIER} |`
    );
  }
  lines.push('', '## Rejected rows (by reason)', '');
  for (const [reason, count] of Object.entries(rejected)) {
    lines.push(`- ${reason}: ${count}`);
  }
  lines.push('');
  return lines.join('\n');
}

/**
 * @returns {Promise<string>}
 */
async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dataDir = args.dataDir ?? DATA_DIR;
  process.stderr.write(`streaming ${args.dump}\n`);

  let evalSalt = null;
  if (args.saltFile && args.evalOut) {
    // Eval mode: secret salt, public sample excluded, output outside the repo.
    const evalOut = path.resolve(args.evalOut);
    if (evalOut.startsWith(REPO_ROOT + path.sep)) {
      throw new Error(
        `--eval-out must be OUTSIDE the repository (got ${evalOut}); the eval sample is the hidden split`
      );
    }
    evalSalt = (await readFile(args.saltFile, 'utf8')).trim();
  }

  const scan = await scanDump(args.dump, args.seed, evalSalt);
  const result = finalizeSelection(scan, evalSalt);

  if (evalSalt !== null) {
    const evalOut = path.resolve(/** @type {string} */ (args.evalOut));
    return writeEvalSample(
      evalOut,
      /** @type {Map<string, import('../selection.js').PuzzleRecord[]>} */ (result.evalSelection),
      evalSalt
    );
  }

  // Public mode: write the committed data files.
  const lastModified = await fetchLastModified(args.dumpUrl);
  const compressed = await stat(args.dump);
  return writePublicSample(dataDir, result.publicSelection, {
    seed: args.seed,
    sha256: result.dump.sha256,
    bytes: result.dump.bytes,
    compressedBytes: compressed.size,
    scanned: result.scanned,
    rejected: result.rejected,
    candidatesPerTier: result.candidatesPerTier,
    lastModified,
    runNote: null,
  });
}

// Run the CLI flow only when this file is the entry point; the shard and
// merge tools import this module for scanDump/finalizeSelection and the
// writers, and must not trigger a serial scan on import.
const entryHref = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (entryHref === import.meta.url) {
  main()
    .then((message) => {
      process.stderr.write(`${message}\n`);
    })
    .catch((err) => {
      process.stderr.write(`sample.js failed: ${err instanceof Error ? err.stack : String(err)}\n`);
      process.exitCode = 1;
    });
}
