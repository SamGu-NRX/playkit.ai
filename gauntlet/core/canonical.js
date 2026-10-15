/**
 * Canonical JSON and the FNV-1a 64-bit observation hash used by
 * trajectories. Pure JS (no `node:*`) so the browser overlay can reuse it.
 *
 * @module
 */

/**
 * Serialize a JSON-able value with recursively sorted object keys. `undefined`
 * values and non-finite numbers are rejected so hashes are stable across
 * engines (JSON.stringify alone silently drops `undefined` in objects and
 * turns NaN into null).
 *
 * @param {*} value
 * @returns {string}
 * @throws {TypeError} on undefined, non-finite numbers, bigint, symbols,
 *   functions, or other non-JSON values.
 */
export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value, 'root'));
}

/**
 * @param {*} value
 * @param {string} path
 * @returns {*}
 */
function canonicalize(value, path) {
  if (value === undefined) {
    throw new TypeError(`canonicalJson: undefined at ${path}`);
  }
  if (value === null) return null;
  switch (typeof value) {
    case 'boolean':
    case 'string':
      return value;
    case 'number':
      if (!Number.isFinite(value)) {
        throw new TypeError(`canonicalJson: non-finite number at ${path}`);
      }
      return value;
    case 'bigint':
    case 'symbol':
    case 'function':
      throw new TypeError(`canonicalJson: ${typeof value} at ${path} is not JSON`);
    case 'object':
      break;
    default:
      throw new TypeError(`canonicalJson: unsupported value at ${path}`);
  }
  if (Array.isArray(value)) {
    return value.map((item, i) => canonicalize(item, `${path}[${i}]`));
  }
  /** @type {Record<string, *>} */
  const out = {};
  for (const key of Object.keys(value).sort()) {
    out[key] = canonicalize(value[key], `${path}.${key}`);
  }
  return out;
}

const FNV_BASIS = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const FNV_MASK = 0xffffffffffffffffn;

/**
 * FNV-1a 64-bit over the UTF-8 bytes of `text`, as 16 lowercase hex digits.
 *
 * @param {string} text
 * @returns {string}
 */
export function fnv1a64(text) {
  const bytes = new TextEncoder().encode(text);
  let hash = FNV_BASIS;
  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = (hash * FNV_PRIME) & FNV_MASK;
  }
  return hash.toString(16).padStart(16, '0');
}

/**
 * Hash an Observation: FNV-1a 64 over its canonical JSON (sorted keys).
 *
 * @param {{ text: string, data: * }} observation
 * @returns {string} 16 hex digits.
 */
export function hashObservation(observation) {
  return fnv1a64(canonicalJson(observation));
}
