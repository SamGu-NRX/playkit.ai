import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalJson, fnv1a64, hashObservation } from './canonical.js';

test('canonicalJson sorts keys at every depth', () => {
  assert.equal(canonicalJson({ b: 1, a: 2 }), '{"a":2,"b":1}');
  assert.equal(
    canonicalJson({ z: { y: 2, x: { w: 3, v: 4 } }, a: 1 }),
    '{"a":1,"z":{"x":{"v":4,"w":3},"y":2}}'
  );
  assert.equal(canonicalJson([3, { b: 1, a: 2 }]), '[3,{"a":2,"b":1}]');
});

test('canonicalJson distinguishes types and handles null, bool, string', () => {
  assert.equal(canonicalJson(null), 'null');
  assert.equal(canonicalJson(true), 'true');
  assert.equal(canonicalJson(1), '1');
  assert.equal(canonicalJson('1'), '"1"');
  assert.equal(canonicalJson([]), '[]');
  assert.equal(canonicalJson({}), '{}');
});

test('canonicalJson escapes strings and round trips through JSON.parse', () => {
  const value = { quote: '"back\\slash"\nnl', key2: [1, null] };
  const canonical = canonicalJson(value);
  assert.deepEqual(JSON.parse(canonical), value);
});

test('key order does not change the canonical form or the hash', () => {
  const a = { text: 'board', data: { toMove: 0, board: ['X', null] } };
  const b = { data: { board: ['X', null], toMove: 0 }, text: 'board' };
  assert.equal(canonicalJson(a), canonicalJson(b));
  assert.equal(hashObservation(a), hashObservation(b));
});

test('fnv1a64 matches known vectors and returns 16 lowercase hex digits', () => {
  assert.equal(fnv1a64(''), 'cbf29ce484222325');
  assert.equal(fnv1a64('a'), 'af63dc4c8601ec8c');
  for (const text of ['', 'hello', 'playkit-gauntlet-trajectory/1', 'x'.repeat(500)]) {
    const hash = fnv1a64(text);
    assert.match(hash, /^[0-9a-f]{16}$/);
  }
  assert.notEqual(fnv1a64('a'), fnv1a64('b'));
});
