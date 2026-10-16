/**
 * Wordle reference machinery: the per-letter feedback scoring, candidate
 * consistency filtering, the hard-mode constraint, and the entropy-greedy
 * reference strategy that sets par.
 *
 * The reference strategy is entropy-greedy over the remaining consistent
 * candidates: every turn it evaluates every legal guess, partitions the
 * remaining candidates by the feedback each would receive, and picks the
 * guess whose feedback partition has the highest Shannon entropy — the
 * expected remaining candidate count is minimized in the information sense.
 * Ties break toward guesses that are themselves consistent candidates, then
 * lexicographically (the guess lists are sorted, so a strict comparison keeps
 * the first optimum).
 *
 * Everything here is pure and deterministic in (wordLength, hardMode,
 * history): no `Math.random`, no clock reads, no `node:*` imports, so the
 * module loads in the browser overlay too.
 *
 * @module
 */

import { ANSWER_WORDS as ANSWERS_4, GUESS_WORDS as GUESSES_4 } from './data/words-4.js';
import { ANSWER_WORDS as ANSWERS_5, GUESS_WORDS as GUESSES_5 } from './data/words-5.js';


/**
 * One recorded guess and its per-letter feedback.
 *
 * @typedef {object} WordleHistoryEntry
 * @property {string} guess The guessed word, e.g. "SPEED".
 * @property {string} pattern Per-letter feedback, `G`/`Y`/`.` per position,
 *   e.g. "..Y.Y": G = right letter right place, Y = right letter wrong
 *   place, . = letter absent (or exhausted by an earlier duplicate).
 */

/**
 * Tier word lists, cached: { wordLength -> { guesses, answers } }.
 *
 * @type {Map<number, { guesses: string[], answers: string[] }>}
 */
const LISTS = new Map([
  [
    4,
    {
      guesses: GUESSES_4.slice(),
      answers: ANSWERS_4.slice(),
    },
  ],
  [
    5,
    {
      guesses: GUESSES_5.slice(),
      answers: ANSWERS_5.slice(),
    },
  ],
]);

/**
 * The guess list for a word length.
 *
 * @param {number} wordLength 4 or 5.
 * @returns {string[]} Sorted uppercase guess list; callers must not mutate.
 */
export function guessesFor(wordLength) {
  const lists = LISTS.get(wordLength);
  if (!lists) throw new Error(`guessesFor: unsupported word length ${wordLength}`);
  return lists.guesses;
}

/**
 * The answer list for a word length.
 *
 * @param {number} wordLength 4 or 5.
 * @returns {string[]} Sorted uppercase answer list; callers must not mutate.
 */
export function answersFor(wordLength) {
  const lists = LISTS.get(wordLength);
  if (!lists) throw new Error(`answersFor: unsupported word length ${wordLength}`);
  return lists.answers;
}

/** Powers of 3 for pattern-code packing, up to 9 positions. */
const POW3 = [1, 3, 9, 27, 81, 243, 729, 2187, 6561];

const CODE_DOT = 0;
const CODE_YELLOW = 1;
const CODE_GREEN = 2;

/** Reused letter-count scratch (26 letters), reset via the touched stack. */
const COUNT = new Int32Array(26);
/** Letters touched in the current call, for O(touched) reset. */
const TOUCHED = new Int32Array(13);

/**
 * Pack the feedback pattern of `guess` against `answer` into an integer:
 * base-3 digits, position i weighted by 3^i, values CODE_DOT/CODE_YELLOW/
 * CODE_GREEN. Allocation-free: the consistency filters call this millions of
 * times per turn-0 entropy search.
 *
 * @param {string} guess
 * @param {string} answer
 * @returns {number}
 */
export function patternCode(guess, answer) {
  const len = answer.length;
  let greens = 0;
  let touched = 0;
  for (let i = 0; i < len; i++) {
    const g = guess.charCodeAt(i);
    const a = answer.charCodeAt(i);
    if (g === a) {
      greens |= 1 << i;
    } else {
      if (COUNT[a - 65] === 0) TOUCHED[touched++] = a - 65;
      COUNT[a - 65]++;
    }
  }
  let code = 0;
  for (let i = 0; i < len; i++) {
    if (greens & (1 << i)) {
      code += CODE_GREEN * POW3[i];
    } else {
      const letter = guess.charCodeAt(i) - 65;
      if (COUNT[letter] > 0) {
        COUNT[letter]--;
        code += CODE_YELLOW * POW3[i];
      }
    }
  }
  for (let k = 0; k < touched; k++) COUNT[TOUCHED[k]] = 0;
  return code;
}

/**
 * Human feedback text for one guess against the answer: one of `G`, `Y` or
 * `.` per position. Duplicates follow standard Wordle counting: a letter is
 * green on exact matches first; remaining occurrences match answer letters
 * left to right, at most once each.
 *
 * @param {string} guess
 * @param {string} answer
 * @returns {string}
 */
export function feedbackFor(guess, answer) {
  const code = patternCode(guess, answer);
  let text = '';
  for (let i = 0; i < answer.length; i++) {
    const digit = Math.floor(code / POW3[i]) % 3;
    text += digit === CODE_GREEN ? 'G' : digit === CODE_YELLOW ? 'Y' : '.';
  }
  return text;
}

/**
 * The answers in `answers` consistent with every recorded (guess, pattern)
 * pair: an answer is consistent when replaying each recorded guess against it
 * reproduces the recorded feedback exactly.
 *
 * @param {string[]} answers Candidate answers.
 * @param {WordleHistoryEntry[]} history Guesses with their feedback.
 * @returns {string[]}
 */
export function consistentAnswers(answers, history) {
  if (history.length === 0) return answers;
  const codes = history.map((entry) => patternCodeOf(entry.guess, entry.pattern));
  return answers.filter((answer) =>
    history.every((entry, i) => patternCode(entry.guess, answer) === codes[i])
  );
}

/**
 * Decode a recorded pattern text back into its packed integer.
 *
 * @param {string} guess Unused; kept for symmetry with patternCode.
 * @param {string} pattern `G`/`Y`/`.` text.
 * @returns {number}
 */
function patternCodeOf(guess, pattern) {
  void guess;
  let code = 0;
  for (let i = 0; i < pattern.length; i++) {
    const digit = pattern[i] === 'G' ? CODE_GREEN : pattern[i] === 'Y' ? CODE_YELLOW : CODE_DOT;
    code += digit * POW3[i];
  }
  return code;
}

/**
 * Whether `guess` reuses every hint revealed by the most recent feedback
 * (hard mode): each green position must repeat its letter, and each letter
 * revealed green-or-yellow must appear at least as many times as it was
 * revealed. Checking only the latest feedback is equivalent to checking all
 * accumulated hints: a letter forced into a later guess reappears in that
 * guess's own feedback (green where it is pinned, yellow or green otherwise),
 * so the latest pattern always carries every still-binding hint.
 *
 * @param {string} guess
 * @param {WordleHistoryEntry[]} history Guesses with their feedback so far.
 * @returns {string | null} A helpful violation message, or null when legal.
 */
export function hardModeViolation(guess, history) {
  if (history.length === 0) return null;
  const latest = history[history.length - 1];
  for (let i = 0; i < latest.pattern.length; i++) {
    if (latest.pattern[i] === 'G' && guess[i] !== latest.guess[i]) {
      return `hard mode: position ${i + 1} is revealed as ${latest.guess[i]} and must stay ${latest.guess[i]}`;
    }
  }
  /** @type {Record<string, number>} */
  const needed = {};
  for (let i = 0; i < latest.pattern.length; i++) {
    if (latest.pattern[i] !== '.') {
      needed[latest.guess[i]] = (needed[latest.guess[i]] ?? 0) + 1;
    }
  }
  /** @type {Record<string, number>} */
  const present = {};
  for (const letter of guess) present[letter] = (present[letter] ?? 0) + 1;
  for (const [letter, count] of Object.entries(needed)) {
    if ((present[letter] ?? 0) < count) {
      return `hard mode: ${letter} is revealed in ${latest.guess} (${latest.pattern}) and must appear ${count === 1 ? 'once' : `${count} times`} in every later guess`;
    }
  }
  return null;
}

/**
 * The next guess of the entropy-greedy reference strategy, given the guesses
 * and feedback so far. Pure and deterministic in (wordLength, hardMode,
 * history). The engine baseline and the par computation both call this, so
 * they play identical games.
 *
 * @param {number} wordLength
 * @param {boolean} hardMode
 * @param {WordleHistoryEntry[]} history
 * @returns {string}
 */
export function nextGuess(wordLength, hardMode, history) {
  const cached = NEXT_GUESS_CACHE.get(cacheKey(wordLength, hardMode, history));
  if (cached) return cached;

  const guesses = guessesFor(wordLength);
  const candidates = consistentAnswers(answersFor(wordLength), history);
  if (candidates.length === 1) {
    NEXT_GUESS_CACHE.set(cacheKey(wordLength, hardMode, history), candidates[0]);
    return candidates[0];
  }
  if (candidates.length === 0) {
    // Unreachable with correct feedback scoring; fall back to the
    // lexicographically first hard-mode-legal guess rather than crash.
    const fallback = guesses.find((g) => hardModeViolation(g, history) === null) ?? guesses[0];
    NEXT_GUESS_CACHE.set(cacheKey(wordLength, hardMode, history), fallback);
    return fallback;
  }

  // Hard mode restricts the legal guess space; plain tiers use every guess.
  const candidateSet = new Set(candidates);
  const searchSpace =
    hardMode && history.length > 0 ? guesses.filter((g) => hardModeViolation(g, history) === null) : guesses;

  const total = candidates.length;
  const buckets = new Int32Array(POW3[wordLength]);
  let best = '';
  let bestEntropy = -1;
  let bestInCandidates = 1;
  for (const guess of searchSpace) {
    buckets.fill(0);
    for (const answer of candidates) {
      buckets[patternCode(guess, answer)]++;
    }
    let entropy = 0;
    for (let b = 0; b < buckets.length; b++) {
      const size = buckets[b];
      if (size > 0) entropy -= size * Math.log2(size / total);
    }
    // divide by total: -sum p log2 p, in bits
    entropy /= total;
    const inCandidates = candidateSet.has(guess) ? 0 : 1;
    // searchSpace preserves the sorted guess order, so strict ">" keeps the
    // lexicographically first optimum; candidates beat non-candidates on ties.
    if (entropy > bestEntropy || (entropy === bestEntropy && inCandidates < bestInCandidates)) {
      best = guess;
      bestEntropy = entropy;
      bestInCandidates = inCandidates;
    }
  }
  NEXT_GUESS_CACHE.set(cacheKey(wordLength, hardMode, history), best);
  return best;
}

/**
 * Memoized next-guess decisions keyed by (wordLength, hardMode, history).
 * The first turn is shared across every episode of a tier, so the expensive
 * full-space entropy search runs once per process; later turns shrink fast.
 *
 * @type {Map<string, string>}
 */
const NEXT_GUESS_CACHE = new Map();

/**
 * @param {number} wordLength
 * @param {boolean} hardMode
 * @param {WordleHistoryEntry[]} history
 * @returns {string}
 */
function cacheKey(wordLength, hardMode, history) {
  return `${wordLength}/${hardMode ? 1 : 0}|${history.map((entry) => `${entry.guess}:${entry.pattern}`).join(',')}`;
}

/** Hard bound on reference turns; a pure safeguard against runaway loops. */
const MAX_REFERENCE_TURNS = 32;

/**
 * Par for one episode: the number of guesses the entropy-greedy reference
 * needs to find `answer` under the tier's rules. Memoized per
 * (wordLength, hardMode, answer) — many agents measure the same seeds.
 *
 * @param {number} wordLength
 * @param {boolean} hardMode
 * @param {string} answer
 * @returns {number}
 */
export function referenceGuessCount(wordLength, hardMode, answer) {
  const key = `${wordLength}/${hardMode ? 1 : 0}/${answer}`;
  const cached = PAR_CACHE.get(key);
  if (cached !== undefined) return cached;
  /** @type {WordleHistoryEntry[]} */
  const history = [];
  let turns = 0;
  for (;;) {
    turns++;
    if (turns > MAX_REFERENCE_TURNS) {
      throw new Error(`referenceGuessCount: reference did not converge for ${answer} (${wordLength}-letter, hard mode ${hardMode})`);
    }
    const guess = nextGuess(wordLength, hardMode, history);
    const pattern = feedbackFor(guess, answer);
    if (pattern === 'G'.repeat(wordLength)) break;
    history.push({ guess, pattern });
  }
  PAR_CACHE.set(key, turns);
  return turns;
}

/** @type {Map<string, number>} */
const PAR_CACHE = new Map();
