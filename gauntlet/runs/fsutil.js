/**
 * Node-only filesystem and hashing helpers for the run layer. Everything here
 * imports `node:*` — game and core code must never import this module.
 *
 * @module
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { canonicalJson } from '../core/canonical.js';

/** Monotonic counter so concurrent temp names never collide within a process. */
let tmpSeq = 0;

/**
 * SHA-256 of a string, lowercase hex.
 *
 * @param {string} text
 * @returns {string}
 */
export function sha256Hex(text) {
  return createHash('sha256').update(text).digest('hex');
}

/**
 * SHA-256 of a value's canonical JSON (core/canonical.js ordering), so the
 * hash does not depend on key order or whitespace.
 *
 * @param {*} value
 * @returns {string}
 */
export function canonicalSha256(value) {
  return sha256Hex(canonicalJson(value));
}

/**
 * Where a job's trajectory lives inside a run directory:
 * `<outDir>/<game>/<tier>/<seed>.json`. Seeds are strings like
 * `<game>/<tier>/public/<i>`, so the path nests below the tier directory;
 * `planJobs` refuses seeds that could escape it.
 *
 * @param {string} outDir
 * @param {import('./plan.js').Job} job
 * @returns {string}
 */
export function trajectoryPath(outDir, job) {
  return path.join(outDir, job.gameId, job.tierId, `${job.seed}.json`);
}

/**
 * Write a file atomically: bytes land in a temp file in the same directory,
 * then a rename puts them at the final path. A reader never sees a half
 * written trajectory or run.json, so a crashed run leaves either the old file
 * or the new one, never a torn write.
 *
 * @param {string} filePath
 * @param {string | Uint8Array} data
 * @returns {Promise<void>}
 */
export async function atomicWriteFile(filePath, data) {
  const dir = path.dirname(filePath);
  await mkdir(dir, { recursive: true });
  tmpSeq += 1;
  const tmp = path.join(dir, `.${path.basename(filePath)}.tmp-${process.pid}-${tmpSeq}`);
  await writeFile(tmp, data);
  await rename(tmp, filePath);
}

/**
 * Read and parse a JSON file.
 *
 * @param {string} filePath
 * @returns {Promise<{ ok: true, value: * } | { ok: false, missing: boolean, error: string }>}
 *   `missing` is true only when the file does not exist; a parse failure is
 *   reported but is not "missing".
 */
export async function readJsonFile(filePath) {
  let text;
  try {
    text = await readFile(filePath, 'utf8');
  } catch (err) {
    const code = /** @type {NodeJS.ErrnoException} */ (err)?.code;
    if (code === 'ENOENT') return { ok: false, missing: true, error: 'file does not exist' };
    return { ok: false, missing: false, error: err instanceof Error ? err.message : String(err) };
  }
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (err) {
    return {
      ok: false,
      missing: false,
      error: `invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
