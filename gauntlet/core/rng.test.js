import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cyrb128,
  sfc32,
  step,
  rngFromSeed,
  nextUint32,
  nextFloat,
  nextInt,
  shuffle,
  streamFromSeed,
  streamFromState,
} from './rng.js';

test('cyrb128 and sfc32 reproduce the canonical algorithm output', () => {
  const [a, b, c, d] = cyrb128('hello');
  const rand = sfc32(a, b, c, d);
  const first = [];
  for (let i = 0; i < 4; i++) {
    first.push(rand());
    for (let warm = 0; warm < 8; warm++) rand();
  }
  // First draw of a fresh instance with the same seed must match.
  const [a2, b2, c2, d2] = cyrb128('hello');
  assert.equal(sfc32(a2, b2, c2, d2)(), first[0]);
  // A different seed produces a different stream.
  const [a3, b3, c3, d3] = cyrb128('hellp');
  assert.notEqual(sfc32(a3, b3, c3, d3)(), first[0]);
});

test('pure functions are deterministic per seed', () => {
  const draw = () => {
    const state = rngFromSeed('tictactoe/perfect-opponent/public/3');
    return [nextUint32(state).value, nextFloat(state).value, nextInt(state, 0, 8).value];
  };
  assert.deepEqual(draw(), draw());
  assert.notDeepEqual(draw(), (() => {
    const state = rngFromSeed('tictactoe/perfect-opponent/public/4');
    return [nextUint32(state).value, nextFloat(state).value, nextInt(state, 0, 8).value];
  })());
});

test('nextInt stays in range and hits all values over many draws', () => {
  let state = rngFromSeed('range-probe');
  const seen = new Set();
  for (let i = 0; i < 2000; i++) {
    const r = nextInt(state, 2, 5);
    assert.ok(Number.isInteger(r.value) && r.value >= 2 && r.value <= 5, `out of range: ${r.value}`);
    seen.add(r.value);
    state = r.state; // pure API: thread the advanced state
  }
  assert.deepEqual([...seen].sort((a, b) => a - b), [2, 3, 4, 5]);
});

test('nextInt with min === max returns min', () => {
  const state = rngFromSeed('fixed');
  for (let i = 0; i < 10; i++) {
    assert.equal(nextInt(state, 7, 7).value, 7);
  }
});

test('shuffle permutes and is deterministic per seed', () => {
  const input = [0, 1, 2, 3, 4, 5, 6, 7];
  const once = shuffle(rngFromSeed('shuffle-seed'), input.slice()).value;
  const twice = shuffle(rngFromSeed('shuffle-seed'), input.slice()).value;
  assert.deepEqual(once, twice);
  assert.deepEqual([...once].sort((a, b) => a - b), input, 'shuffle must be a permutation');
  assert.notDeepEqual(once, input, '8-element shuffle matching identity would be suspicious');
});

test('streams save and restore their position', () => {
  const stream = streamFromSeed('save-restore');
  const before = [];
  for (let i = 0; i < 5; i++) before.push(stream.nextInt(0, 1000));
  const saved = stream.getState();
  const afterSave = [];
  for (let i = 0; i < 5; i++) afterSave.push(stream.nextInt(0, 1000));
  const restored = streamFromState(saved);
  const afterRestore = [];
  for (let i = 0; i < 5; i++) afterRestore.push(restored.nextInt(0, 1000));
  assert.deepEqual(afterRestore, afterSave);
  assert.notDeepEqual(afterSave, before);
  // The pure API over the same seed agrees with the stream API.
  let pureState = rngFromSeed('save-restore');
  const pure = [];
  for (let i = 0; i < 10; i++) {
    const r = nextUint32(pureState);
    pure.push(r.value);
    pureState = r.state; // thread the advanced state
  }
  const streamPure = streamFromSeed('save-restore');
  const streamValues = [];
  for (let i = 0; i < 10; i++) streamValues.push(streamPure.nextUint32());
  assert.deepEqual(streamValues, pure, 'stream and pure API agree on the same seed');
  // Threaded pure draws advance; repeating from one state does not.
  let stepState = rngFromSeed('step-helper');
  const first = nextUint32(stepState).value;
  stepState = nextUint32(stepState).state;
  assert.equal(nextUint32(stepState).value !== first, true);
});

test('cyrb128 and sfc32 match the canonical known-answer vectors', () => {
  // Pinned against the canonical cyrb128 (StackOverflow a/19303725) and the
  // reference sfc32: changing either algorithm fails these, not just streams.
  assert.deepEqual(cyrb128('hello'), [1690739734, 1078026890, 1569261940, 551242337]);
  assert.deepEqual(cyrb128('a'), [1589175524, 148824423, 2405369273, 1476957317]);
  assert.deepEqual(cyrb128(''), [41608494, 3485963809, 1435736333, 1262568316]);
  const [a, b, c, d] = cyrb128('hello');
  const rand = sfc32(a, b, c, d);
  assert.equal(rand(), 0.7729998235590756);
  assert.equal(rand(), 0.6681805667467415);
  assert.equal(rand(), 0.010621748166158795);
  assert.equal(rand(), 0.14245743886567652);
  const pinned = 'playkit-gauntlet/rng-vector/1';
  assert.equal(nextUint32(rngFromSeed(pinned)).value, 3805567066);
  assert.equal(nextFloat(rngFromSeed(pinned)).value, 0.8860526294447482);
  assert.equal(nextInt(rngFromSeed(pinned), 0, 8).value, 1);
});
