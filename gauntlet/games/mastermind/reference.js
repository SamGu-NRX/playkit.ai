/**
 * Mastermind reference strategy and feedback scoring.
 *
 * Classic (4 pegs, 6 colors) uses Knuth's minimax: evaluate every code in the
 * space as a candidate guess, partition the remaining consistent candidates by
 * the feedback each would receive, and pick the guess whose largest partition
 * is smallest — the five-guess-worst-case strategy (Knuth 1977). Ties break
 * toward guesses that are themselves consistent, then lexicographically.
 *
 * The larger tiers (5 pegs / 8 colors, 6 pegs / 9 colors) cannot run the full
 * quadratic minimax, so they use a deterministic sampled variant: take a
 * seeded sample of the consistent candidates and pick the sample member whose
 * largest feedback partition (over the sample) is smallest. The first guess of
 * the larger tiers is a fixed paired-color opener, which needs no search.
 *
 * Everything here is pure and deterministic in (pegs, colors, history, seed):
 * random choices come from the core RNG seeded by the episode seed, never
 * `Math.random`, and there are no clock reads. No `node:*` imports.
 *
 * @module
 */

import { rngFromSeed, shuffle } from '../../core/rng.js';

/** @import { MastermindHistoryEntry } from './index.js' */

/**
 * Number of candidate codes the sampled minimax evaluates per turn for the
 * larger tiers.
 */
const SAMPLE_SIZE = 256;

/** Full code space for (pegs, colors), in lexicographic order, cached. */

/**
 * @type {Map<string, string[]>}
 */
const ALL_CODES_CACHE = new Map();

/**
 * All `colors^pegs` codes as strings over A-I, lexicographically sorted.
 *
 * @param {number} pegs
 * @param {number} colors
 * @returns {string[]}
 */
export function allCodes(pegs, colors) {
  const key = `${pegs}/${colors}`;
  const cached = ALL_CODES_CACHE.get(key);
  if (cached) return cached;
  const letters = alphabetFor(colors);
  let codes = [''];
  for (let i = 0; i < pegs; i++) {
    codes = codes.flatMap((prefix) => letters.split('').map((letter) => prefix + letter));
  }
  // Generation order (letters in order, rightmost position cycling fastest)
  // is exactly lexicographic order.
  ALL_CODES_CACHE.set(key, codes);
  return codes;
}

/**
 * The color letters for a tier: "A" up to `colors` letters.
 *
 * @param {number} colors
 * @returns {string}
 */
export function alphabetFor(colors) {
  if (!Number.isInteger(colors) || colors < 2 || colors > 9) {
    throw new Error(`alphabetFor: unsupported color count ${colors}`);
  }
  return 'ABCDEFGHI'.slice(0, colors);
}

/**
 * Score one guess against the secret: black pegs (right color, right place)
 * and white pegs (right color, wrong place). Handles repeated colors.
 *
 * @param {string} guess
 * @param {string} secret
 * @returns {{ blacks: number, whites: number }}
 */
export function feedbackFor(guess, secret) {
  if (guess.length !== secret.length) {
    throw new Error(`feedbackFor: length mismatch ${guess.length} vs ${secret.length}`);
  }
  let blacks = 0;
  // Per-letter counts indexed by charCode - 65 (colors are A-I). Small fixed
  // arrays instead of Maps: the consistency filters call this millions of
  // times on the larger tiers.
  const guessRest = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  const secretRest = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (let i = 0; i < guess.length; i++) {
    const g = guess.charCodeAt(i) - 65;
    const s = secret.charCodeAt(i) - 65;
    if (g === s) {
      blacks++;
    } else {
      guessRest[g]++;
      secretRest[s]++;
    }
  }
  let whites = 0;
  for (let c = 0; c < 9; c++) {
    const g = guessRest[c];
    if (g > 0) whites += Math.min(g, secretRest[c]);
  }
  return { blacks, whites };
}

/**
 * The codes in `codes` consistent with every recorded guess.
 *
 * @param {string[]} codes Candidate secrets.
 * @param {MastermindHistoryEntry[]} history Guesses with their feedback.
 * @returns {string[]}
 */
export function consistentCodes(codes, history) {
  if (history.length === 0) return codes;
  return codes.filter((code) =>
    history.every((entry) => {
      const fb = feedbackFor(entry.guess, code);
      return fb.blacks === entry.blacks && fb.whites === entry.whites;
    })
  );
}

/**
 * The codes in `codes` consistent with one (guess, blacks, whites) triple.
 * Exported so agents can filter their candidate pool incrementally, one
 * history entry at a time, instead of re-scanning the whole history.
 *
 * @param {string[]} codes
 * @param {MastermindHistoryEntry} entry
 * @returns {string[]}
 */
export function filterConsistent(codes, entry) {
  return codes.filter((code) => {
    const fb = feedbackFor(entry.guess, code);
    return fb.blacks === entry.blacks && fb.whites === entry.whites;
  });
}

/**
 * Partition-bucket key for a feedback pair: distinct integers per (blacks,
 * whites) pair for pegs <= 9.
 *
 * @param {{ blacks: number, whites: number }} fb
 * @returns {number}
 */
function bucketKey(fb) {
  return fb.blacks * 16 + fb.whites;
}

/**
 * @type {Map<string, string>}
 */
const MINIMAX_CACHE = new Map();

/**
 * Knuth minimax over the full code space: the guess whose worst-case feedback
 * bucket over `candidates` is smallest, tie-breaking toward consistent
 * guesses, then lexicographic order. `guessSpace` must be sorted. Memoized on
 * (pegs, colors, historyKey) — the first two turns are shared across secrets.
 *
 * @param {number} pegs
 * @param {number} colors
 * @param {string[]} guessSpace All codes, sorted.
 * @param {string[]} candidates Consistent codes.
 * @param {string} cacheKey History-derived cache key.
 * @returns {string}
 */
function minimaxGuess(pegs, colors, guessSpace, candidates, cacheKey) {
  const cacheFullKey = `${pegs}/${colors}/${cacheKey}`;
  const cached = MINIMAX_CACHE.get(cacheFullKey);
  if (cached) return cached;
  const candidateSet = new Set(candidates);
  /** @type {string} */
  let best = '';
  let bestWorst = Number.POSITIVE_INFINITY;
  let bestInCandidates = 0;
  for (const guess of guessSpace) {
    /** @type {Map<number, number>} */
    const buckets = new Map();
    let worst = 0;
    for (const code of candidates) {
      const key = bucketKey(feedbackFor(guess, code));
      const size = (buckets.get(key) ?? 0) + 1;
      buckets.set(key, size);
      if (size > worst) worst = size;
    }
    const inCandidates = candidateSet.has(guess) ? 0 : 1;
    // guessSpace is sorted, so strict "<" keeps the lexicographically first
    // optimum.
    if (worst < bestWorst || (worst === bestWorst && inCandidates < bestInCandidates)) {
      best = guess;
      bestWorst = worst;
      bestInCandidates = inCandidates;
    }
  }
  MINIMAX_CACHE.set(cacheFullKey, best);
  return best;
}

/**
 * Seeded sampled minimax over the consistent candidates: sample
 * `SAMPLE_SIZE` of them (all of them when there are fewer), pick the sample
 * member whose largest feedback bucket over the sample is smallest,
 * lexicographic-first on ties.
 *
 * @param {string[]} candidates Consistent codes, any order.
 * @param {number} pegs
 * @param {string} rngSeed Seed for the sample draw.
 * @returns {string}
 */
function sampledMinimaxGuess(candidates, pegs, rngSeed) {
  /** @type {string[]} */
  let sample;
  if (candidates.length <= SAMPLE_SIZE) {
    sample = candidates.slice().sort();
  } else {
    sample = shuffle(rngFromSeed(rngSeed), candidates)
      .value.slice(0, SAMPLE_SIZE)
      .sort();
  }
  /** @type {string} */
  let best = '';
  let bestWorst = Number.POSITIVE_INFINITY;
  for (const guess of sample) {
    /** @type {Map<number, number>} */
    const buckets = new Map();
    let worst = 0;
    for (const code of sample) {
      const key = bucketKey(feedbackFor(guess, code));
      const size = (buckets.get(key) ?? 0) + 1;
      buckets.set(key, size);
      if (size > worst) worst = size;
    }
    if (worst < bestWorst) {
      best = guess;
      bestWorst = worst;
    }
  }
  void pegs;
  return best;
}

/**
 * The fixed first guess of the larger tiers: paired colors, e.g. "AABBC" for
 * 5 pegs and "AABBCC" for 6. A strong structured opener with no search cost.
 *
 * @param {number} pegs
 * @returns {string}
 */
export function openerFor(pegs) {
  let code = '';
  for (let i = 0; i < pegs; i++) {
    code += 'ABCDEFGHI'[Math.floor(i / 2)];
  }
  return code;
}

/**
 * Cache key for a history.
 *
 * @param {MastermindHistoryEntry[]} history
 * @returns {string}
 */
function historyKey(history) {
  return history
    .map((entry) => `${entry.guess}:${entry.blacks},${entry.whites}`)
    .join('|');
}

/**
 * The reference strategy's next guess given the guesses so far. Pure and
 * deterministic in (pegs, colors, history, seed). The engine baseline and the
 * par computation both call this, so they play identical games.
 *
 * @param {number} pegs
 * @param {number} colors
 * @param {MastermindHistoryEntry[]} history
 * @param {string} seed Episode seed.
 * @returns {string}
 */
export function referenceNextGuess(pegs, colors, history, seed) {
  if (history.length === 0) {
    // Classic opens with Knuth's own minimax result ("AABB" for 4/6); the
    // larger tiers open with the fixed paired-color opener.
    if (pegs === 4 && colors === 6) {
      return minimaxGuess(pegs, colors, allCodes(pegs, colors), allCodes(pegs, colors), '');
    }
    return openerFor(pegs);
  }
  const codes = allCodes(pegs, colors);
  let consistent = codes;
  for (const entry of history) {
    consistent = filterConsistent(consistent, entry);
    if (consistent.length === 0) {
      throw new Error('referenceNextGuess: no code is consistent with the recorded history');
    }
  }
  if (consistent.length === 1) {
    return consistent[0];
  }
  if (pegs === 4 && colors === 6) {
    return minimaxGuess(pegs, colors, codes, consistent, historyKey(history));
  }
  return sampledMinimaxGuess(consistent, pegs, `${seed}/reference/turn${history.length}`);
}

/**
 * @type {Map<string, number>}
 */
const PAR_CACHE = new Map();

/**
 * How many guesses the reference strategy needs for one secret. Memoized:
 * par is the tier's efficiency yardstick and both the game outcome and the
 * engine baseline ask for it. Deterministic in (pegs, colors, seed).
 *
 * @param {number} pegs
 * @param {number} colors
 * @param {string} seed
 * @param {string} secret
 * @returns {number}
 */
export function referenceGuessCount(pegs, colors, seed, secret) {
  const key = `${pegs}/${colors}/${seed}`;
  const cached = PAR_CACHE.get(key);
  if (cached !== undefined) return cached;
  /** @type {MastermindHistoryEntry[]} */
  const history = [];
  let guesses = 0;
  for (;;) {
    const guess = referenceNextGuess(pegs, colors, history, seed);
    guesses++;
    const fb = feedbackFor(guess, secret);
    if (fb.blacks === pegs) break;
    history.push({ guess, blacks: fb.blacks, whites: fb.whites });
  }
  PAR_CACHE.set(key, guesses);
  return guesses;
}
