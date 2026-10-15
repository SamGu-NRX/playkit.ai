/**
 * Gauntlet's seeded RNG: cyrb128 string hashing feeding an sfc32 core, exposed
 * both as pure state-transition functions over a state of four uint32s and as
 * a small mutable stream whose state can be saved back into a game state.
 * Pure JS (no `node:*`). The algorithms are pinned by known-answer tests in
 * `rng.test.js`; do not change them without a version bump of every game.
 *
 * @module
 */

/**
 * cyrb128 string hash: 32-bit xmur3-style avalanche producing four uint32s.
 *
 * @param {string} str
 * @returns {[number, number, number, number]} Four uint32s.
 */
export function cyrb128(str) {
  /** @type {number} */ let h1 = 1779033703;
  /** @type {number} */ let h2 = 3144134277;
  /** @type {number} */ let h3 = 1013904242;
  /** @type {number} */ let h4 = 2773480762;
  for (let i = 0; i < str.length; i++) {
    const k = str.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  h1 ^= h2 ^ h3 ^ h4;
  h2 ^= h1;
  h3 ^= h1;
  h4 ^= h1;
  return [h1 >>> 0, h2 >>> 0, h3 >>> 0, h4 >>> 0];
}

/**
 * The sfc32 core as a closure over four uint32s, returning floats in [0, 1).
 * This is the reference form the pure functions below must match exactly.
 *
 * @param {number} a
 * @param {number} b
 * @param {number} c
 * @param {number} d
 * @returns {() => number}
 */
export function sfc32(a, b, c, d) {
  return function () {
    a >>>= 0;
    b >>>= 0;
    c >>>= 0;
    d >>>= 0;
    let t = (a + b) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    d = (d + 1) | 0;
    t = (t + d) | 0;
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
}

/**
 * An RNG state: four uint32s. Plain JSON so it can be saved inside a game
 * state.
 *
 * @typedef {object} RngState
 * @property {number} a
 * @property {number} b
 * @property {number} c
 * @property {number} d
 */

/**
 * Advance sfc32 by one step, purely. The output word is `t + d` (the same
 * word the sfc32 closure returns).
 *
 * @param {RngState} state
 * @returns {{ value: number, state: RngState }} value is a uint32.
 */
export function step(state) {
  const { a, b, c, d } = state;
  const t = (a + b) | 0;
  const a2 = (b ^ (b >>> 9)) >>> 0;
  const b2 = ((c + (c << 3)) | 0) >>> 0;
  const c2 = ((c << 21) | (c >>> 11)) >>> 0;
  const d2 = (d + 1) | 0;
  const t2 = (t + d2) | 0;
  const c3 = ((c2 + t2) | 0) >>> 0;
  return {
    value: t2 >>> 0,
    state: { a: a2, b: b2, c: c3, d: d2 >>> 0 },
  };
}

const SFC32_WARMUP_STEPS = 10;

/**
 * Normalize a value to a uint32.
 *
 * @param {number} n
 * @returns {number}
 */
function uint32(n) {
  return n >>> 0;
}

/**
 * Seed the generator from a string: cyrb128, then 10 warm-up draws so early
 * output is well mixed.
 *
 * @param {string} seed
 * @returns {RngState}
 */
export function rngFromSeed(seed) {
  const [a, b, c, d] = cyrb128(seed);
  let state = { a: uint32(a), b: uint32(b), c: uint32(c), d: uint32(d) };
  for (let i = 0; i < SFC32_WARMUP_STEPS; i++) {
    state = step(state).state;
  }
  return state;
}

/**
 * Draw a uint32, purely.
 *
 * @param {RngState} state
 * @returns {{ value: number, state: RngState }}
 */
export function nextUint32(state) {
  return step(state);
}

/**
 * Draw a float in [0, 1), purely.
 *
 * @param {RngState} state
 * @returns {{ value: number, state: RngState }}
 */
export function nextFloat(state) {
  const r = step(state);
  return { value: r.value / 4294967296, state: r.state };
}

/**
 * Draw an integer in [min, max] inclusive, purely, using rejection sampling
 * so there is no modulo bias.
 *
 * @param {RngState} state
 * @param {number} min
 * @param {number} max
 * @returns {{ value: number, state: RngState }}
 * @throws {Error} when max < min.
 */
export function nextInt(state, min, max) {
  if (!Number.isInteger(min) || !Number.isInteger(max) || max < min) {
    throw new Error(`nextInt: invalid range [${min}, ${max}]`);
  }
  const range = max - min + 1;
  const limit = Math.floor(4294967296 / range) * range;
  let s = state;
  for (;;) {
    const r = step(s);
    if (r.value < limit) {
      return { value: min + (r.value % range), state: r.state };
    }
    s = r.state;
  }
}

/**
 * Shuffle an array (Fisher-Yates over a copy), purely: the input array is
 * never mutated.
 *
 * @template T
 * @param {RngState} state
 * @param {readonly T[]} array
 * @returns {{ value: T[], state: RngState }}
 */
export function shuffle(state, array) {
  let s = state;
  const out = Array.from(array);
  for (let i = out.length - 1; i > 0; i--) {
    const r = nextInt(s, 0, i);
    s = r.state;
    const j = r.value;
    const tmp = out[i];
    out[i] = out[j];
    out[j] = tmp;
  }
  return { value: out, state: s };
}

/**
 * A small mutable stream over an RNG state, for game/opponent code that
 * wants convenience. `getState()` returns the four uint32s so callers can
 * save the stream back into a game state and resume it exactly.
 *
 * @typedef {object} RngStream
 * @property {() => number} nextUint32
 * @property {(min: number, max: number) => number} nextInt
 * @property {() => number} nextFloat
 * @property {<T>(array: readonly T[]) => T[]} shuffle
 * @property {() => RngState} getState
 * @property {(state: RngState) => void} setState
 */

/**
 * Build a mutable stream from a state.
 *
 * @param {RngState} initialState
 * @returns {RngStream}
 */
export function streamFromState(initialState) {
  let s = {
    a: uint32(initialState.a),
    b: uint32(initialState.b),
    c: uint32(initialState.c),
    d: uint32(initialState.d),
  };
  return {
    nextUint32() {
      const r = step(s);
      s = r.state;
      return r.value;
    },
    nextInt(min, max) {
      const r = nextInt(s, min, max);
      s = r.state;
      return r.value;
    },
    nextFloat() {
      const r = nextFloat(s);
      s = r.state;
      return r.value;
    },
    shuffle(array) {
      const r = shuffle(s, array);
      s = r.state;
      return r.value;
    },
    getState() {
      return { ...s };
    },
    setState(next) {
      s = {
        a: uint32(next.a),
        b: uint32(next.b),
        c: uint32(next.c),
        d: uint32(next.d),
      };
    },
  };
}

/**
 * Build a mutable stream straight from a seed string (cyrb128 + warm-up).
 *
 * @param {string} seed
 * @returns {RngStream}
 */
export function streamFromSeed(seed) {
  return streamFromState(rngFromSeed(seed));
}
