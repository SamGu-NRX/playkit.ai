import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCliArgs } from '../../evidence/phone-evidence-args.mjs';

const DEF = '/default/out';

test('accepts the documented --name=value forms', () => {
  assert.deepEqual(parseCliArgs(['--label=before', `--out=${DEF}`, '--only=iPhone15:portrait'], DEF), {
    label: 'before',
    outDir: DEF,
    only: ['iPhone15:portrait'],
  });
});

test('keeps the --name value space forms working', () => {
  assert.deepEqual(parseCliArgs(['--label', 'before', '--out', '/x'], DEF), {
    label: 'before',
    outDir: '/x',
    only: [],
  });
});

test('defaults when no flags are passed', () => {
  assert.deepEqual(parseCliArgs([], DEF), { label: 'after', outDir: DEF, only: [] });
});

test('repeated --only accumulates targets', () => {
  const got = parseCliArgs(['--only=iPhone15:portrait', '--only=iPhone15:landscape'], DEF);
  assert.deepEqual(got.only, ['iPhone15:portrait', 'iPhone15:landscape']);
});

test('an empty --label= value falls back to the default rather than clobbering names', () => {
  assert.equal(parseCliArgs(['--label='], DEF).label, 'after');
});
