import { test } from 'node:test';
import assert from 'node:assert/strict';
import { publicSeed } from './seeds.js';
import { evalSeed, saltCommitment } from './seeds-node.js';
import { createHmac, createHash } from 'node:crypto';

test('publicSeed follows the <game>/<tier>/public/<i> format', () => {
  assert.equal(publicSeed('tictactoe', 'perfect-opponent', 0), 'tictactoe/perfect-opponent/public/0');
  assert.equal(publicSeed('chess', 'engine-1200', 7), 'chess/engine-1200/public/7');
});

test('publicSeed is deterministic and index-sensitive', () => {
  assert.equal(publicSeed('g', 't', 2), publicSeed('g', 't', 2));
  assert.notEqual(publicSeed('g', 't', 1), publicSeed('g', 't', 2));
  assert.notEqual(publicSeed('g', 't1', 0), publicSeed('g', 't2', 0));
});

test('evalSeed is keyed by the salt and saltCommitment hides it', () => {
  const salt = 'test-salt-abcdef';
  const a = evalSeed('tictactoe', 'perfect-opponent', 0, salt);
  const b = evalSeed('tictactoe', 'perfect-opponent', 0, salt);
  const c = evalSeed('tictactoe', 'perfect-opponent', 0, 'other-salt');
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.notEqual(a.includes(salt), true, 'eval seed must not embed the raw salt');

  const commitment = saltCommitment(salt);
  assert.equal(commitment, saltCommitment(salt));
  assert.notEqual(commitment, saltCommitment('other-salt'));
  assert.notEqual(commitment.includes(salt), true, 'commitment must not reveal the salt');
});

test('evalSeed and saltCommitment match their documented HMAC/SHA-256 construction', () => {
  const salt = 'vector-salt';
  // evalSeed i = <game>/<tier>/eval/ + first 16 hex digits of HMAC-SHA256(salt, <game>/<tier>/<i>).
  const mac = createHmac('sha256', salt).update('tictactoe/perfect-opponent/3').digest('hex');
  assert.equal(
    evalSeed('tictactoe', 'perfect-opponent', 3, salt),
    `tictactoe/perfect-opponent/eval/${mac.slice(0, 16)}`
  );
  // The commitment is plain SHA-256 of the salt, lowercase hex.
  assert.equal(saltCommitment(salt), createHash('sha256').update(salt).digest('hex'));
});
