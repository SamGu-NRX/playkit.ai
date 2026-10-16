/**
 * Wordle: one seat, hidden information, pure deduction with words. The
 * episode seed fixes a hidden answer word; every guess receives per-letter
 * feedback — `G` right letter right place, `Y` right letter wrong place, `.`
 * letter absent or exhausted — following standard duplicate-letter counting.
 * Invalid guesses (not in the tier's word list, or in hard mode not reusing
 * the revealed hints) are invalid actions with a helpful error.
 *
 * Efficiency-scored: par is the guess count of the bundled entropy-greedy
 * reference strategy (`reference.js`) for this answer, capped like every
 * reference-par tier at 1.15 in the scoring layer.
 *
 * Tiers:
 * - `four-letter-10` — on-ramp: a 4-letter word list, 10 guesses.
 * - `classic` — 5-letter word list, 6 guesses.
 * - `hard-mode` — 6 guesses on the same 5-letter list, and every revealed
 *   hint must be reused in every later guess.
 *
 * @module
 */

import { GauntletRuleError } from '../../core/errors.js';
import { nextInt, rngFromSeed } from '../../core/rng.js';
import {
  answersFor,
  feedbackFor,
  guessesFor,
  hardModeViolation,
  referenceGuessCount,
} from './reference.js';

/** @import { Game, GameTag, InformationMode, Observation, Outcome, ParseResult, TierSpec } from '../../core/types.js' */
/** @import { WordleHistoryEntry } from './reference.js' */

/**
 * Tier definitions. Budgets: maxActions covers 4x the word-game guess limit,
 * so invalid attempts (each consumes an action, none consumes a guess) have
 * generous headroom before the runner's budget-exhausted end.
 */
const TIER_DEFS = [
  { id: 'four-letter-10', wordLength: 4, maxGuesses: 10, hardMode: false },
  { id: 'classic', wordLength: 5, maxGuesses: 6, hardMode: false },
  { id: 'hard-mode', wordLength: 5, maxGuesses: 6, hardMode: true },
];

/**
 * Canonical action for a guess word.
 *
 * @param {string} word
 * @returns {string}
 */
function canonicalAction(word) {
  return `guess ${word}`;
}

/**
 * All letters of `word` are A-Z.
 *
 * @param {unknown} word
 * @returns {boolean}
 */
function isUppercaseWord(word) {
  if (typeof word !== 'string') return false;
  for (let i = 0; i < word.length; i++) {
    const unit = word.charCodeAt(i);
    if (unit < 65 || unit > 90) return false;
  }
  return true;
}

/**
 * @param {string} word
 * @param {number} wordLength
 * @returns {boolean}
 */
function isListedGuess(word, wordLength) {
  return isUppercaseWord(word) && word.length === wordLength;
}

/**
 * The canonical legal actions for a playing state, in sorted order (the word
 * lists are sorted, and the hard-mode filter preserves that order).
 *
 * @param {WordleState} state
 * @returns {string[]}
 */
function legalActionsFor(state) {
  const guesses = guessesFor(state.wordLength);
  if (!state.hardMode || state.guesses.length === 0) {
    return guesses.map((guess) => `guess ${guess}`);
  }
  return guesses
    .filter((guess) => hardModeViolation(guess, state.guesses) === null)
    .map((guess) => `guess ${guess}`);
}

export const wordle = {
  spec: {
    id: 'wordle',
    version: '1.0.0',
    title: 'Wordle',
    seats: /** @type {1 | 2} */ (1),
    information: /** @type {InformationMode} */ ('hidden'),
    stochastic: false,
    tags: /** @type {GameTag[]} */ (['deduction']),
    benchmark: true,
    requires: [],
    rulesText: [
      'Wordle: deduce a hidden answer word. Tiers:',
      'tier four-letter-10: 4-letter words, 10 guesses;',
      'tier classic: 5-letter words, 6 guesses;',
      'tier hard-mode: 5-letter words, 6 guesses, hard mode.',
      'After each guess you learn one feedback symbol per letter position:',
      'G = right letter in the right place, Y = right letter in the wrong place, . = the letter does not occur there.',
      'Duplicate letters follow standard Wordle counting: exact matches are marked G first; each remaining occurrence of a letter can match at most one unanswered occurrence of that letter in the answer, left to right; surplus duplicates are marked .',
      'Every guess must be a real word from the tier\'s word list; the list is not revealed in full.',
      'You win by guessing the exact answer. The episode is scored on efficiency: par is the number of guesses a strong reference strategy needs for this answer, so fewer guesses score higher.',
      'Action grammar: "guess" followed by the word in capital letters, e.g. "guess CRANE" on a 5-letter tier.',
      'Documented alternates: the bare word ("CRANE"), lowercase letters, a verb ("try CRANE", "play CRANE"), spaces between letters ("C R A N E"), and surrounding quotes or backticks are all accepted.',
      'A guess with the wrong length, or a word not in the tier\'s word list, is invalid and consumes an action attempt.',
      'On tier hard-mode only: every revealed hint must be reused in every later guess — letters marked G must stay in their revealed positions, and every letter marked G or Y must appear as many times as it was revealed in that feedback.',
    ].join(' '),
    tiers: /** @type {TierSpec[]} */ (
      TIER_DEFS.map((def, index) => ({
        id: def.id,
        rank: index + 1,
        scoring: /** @type {'efficiency'} */ ('efficiency'),
        maxActions: 4 * def.maxGuesses,
        publicSeeds: 25,
        parKind: /** @type {'reference'} */ ('reference'),
        params: { wordLength: def.wordLength, maxGuesses: def.maxGuesses, hardMode: def.hardMode },
      }))
    ),
  },

  /**
   * @param {TierSpec} tier
   * @param {string} seed
   * @returns {WordleState}
   */
  reset(tier, seed) {
    const { wordLength, maxGuesses, hardMode } = /** @type {{ wordLength: number, maxGuesses: number, hardMode: boolean }} */ (tier.params);
    const answers = answersFor(wordLength);
    const pick = nextInt(rngFromSeed(`${seed}/answer`), 0, answers.length - 1).value;
    return {
      seed,
      wordLength,
      maxGuesses,
      hardMode,
      answer: answers[pick],
      guesses: [],
      status: 'playing',
    };
  },

  /**
   * @param {WordleState} state
   * @returns {number | null}
   */
  toAct(state) {
    return state.status === 'playing' ? 0 : null;
  },

  /**
   * The observation never contains the answer or the seed: two episodes with
   * different answers are observationally identical until the first guess.
   *
   * @param {WordleState} state
   * @param {number} seat
   * @returns {Observation}
   */
  observe(state, seat) {
    void seat;
    const remaining = state.maxGuesses - state.guesses.length;
    /** @type {string[]} */
    const lines = [
      `Wordle. Guess the hidden ${state.wordLength}-letter word.`,
      'Feedback per guess, one symbol per letter position: G = right letter right place, Y = right letter wrong place, . = letter absent (or exhausted by an earlier duplicate).',
      'Action format: "guess" followed by the word in capital letters, e.g. "guess CRANE".',
    ];
    if (state.hardMode) {
      lines.push(
        'Hard mode: every revealed hint must be reused — letters marked G stay in their positions, and every letter marked G or Y must appear as many times as it was revealed.'
      );
    }
    if (state.guesses.length === 0) {
      lines.push('No guesses yet.');
    } else {
      lines.push('Guesses so far:');
      state.guesses.forEach((entry, index) => {
        lines.push(`${index + 1}. guess ${entry.guess} -> ${entry.pattern}`);
      });
    }
    lines.push(`Guesses remaining: ${remaining}.`);
    if (state.status === 'won') {
      lines.push('Game over: the answer is solved.');
    } else if (state.status === 'lost') {
      lines.push('Game over: the guess budget ran out unsolved.');
    } else {
      lines.push(`Make guess ${state.guesses.length + 1} of ${state.maxGuesses}.`);
    }
    if (state.status === 'playing') {
      const legal = legalActionsFor(state);
      if (legal.length > 0 && legal.length <= 64) {
        lines.push(`Legal actions (${legal.length}): ${legal.join(', ')}.`);
      }
    }
    return {
      text: lines.join('\n'),
      data: {
        wordLength: state.wordLength,
        hardMode: state.hardMode,
        guesses: state.guesses.map((entry) => ({ ...entry })),
        guessesRemaining: remaining,
        status: state.status,
      },
    };
  },

  /**
   * Every word on the tier's guess list that respects the hard-mode
   * constraint is always legal. The list is far larger than 64 entries, so
   * observations do not list it.
   *
   * @param {WordleState} state
   * @param {number} seat
   * @returns {string[]}
   */
  legalActions(state, seat) {
    if (state.status !== 'playing' || seat !== 0) return [];
    return legalActionsFor(state);
  },

  /**
   * @param {WordleState} state
   * @param {number} seat
   * @param {string} text
   * @returns {ParseResult}
   */
  parseAction(state, seat, text) {
    if (state.status !== 'playing') {
      return { ok: false, error: 'the game is over' };
    }
    if (seat !== 0) {
      return { ok: false, error: `unknown seat ${seat}` };
    }
    // Fast path: already-canonical action. State-dependent legality
    // (hard-mode constraints) applies here exactly as on the slow path.
    const word = text.slice(6);
    if (
      text.length === 6 + state.wordLength &&
      text.startsWith('guess ') &&
      isListedGuess(word, state.wordLength) &&
      guessesFor(state.wordLength).includes(word) &&
      !(state.hardMode && hardModeViolation(word, state.guesses) !== null)
    ) {
      return { ok: true, action: canonicalAction(word) };
    }
    let s = String(text).trim();
    if (
      s.length >= 2 &&
      ((s.startsWith('`') && s.endsWith('`')) ||
        (s.startsWith('"') && s.endsWith('"')) ||
        (s.startsWith("'") && s.endsWith("'")))
    ) {
      s = s.slice(1, -1).trim();
    }
    s = s.replace(/^(guess|try|play|solve)\s+/i, '');
    s = s.replace(/\s+/g, '').toUpperCase();
    if (s.length === 0) {
      return {
        ok: false,
        error: `empty action; use "guess" followed by a ${state.wordLength}-letter word, e.g. "guess ${'CRANE'.slice(0, state.wordLength)}"`,
      };
    }
    if (s.length !== state.wordLength || !isUppercaseWord(s)) {
      return {
        ok: false,
        error: `cannot parse ${JSON.stringify(String(text))} as a ${state.wordLength}-letter word; use "guess" followed by the word in capital letters, e.g. "guess ${'CRANE'.slice(0, state.wordLength)}"`,
      };
    }
    if (!guessesFor(state.wordLength).includes(s)) {
      return {
        ok: false,
        error: `"${s}" is not in the ${state.wordLength}-letter word list`,
      };
    }
    const violation = state.hardMode ? hardModeViolation(s, state.guesses) : null;
    if (violation) {
      return { ok: false, error: violation };
    }
    return { ok: true, action: canonicalAction(s) };
  },

  /**
   * @param {WordleState} state
   * @param {number} seat
   * @param {string} action
   * @returns {WordleState}
   */
  step(state, seat, action) {
    if (state.status !== 'playing') {
      throw new GauntletRuleError('the game is over');
    }
    if (seat !== 0) {
      throw new GauntletRuleError(`unknown seat ${seat}`);
    }
    if (
      typeof action !== 'string' ||
      action.length !== 6 + state.wordLength ||
      !action.startsWith('guess ') ||
      !guessesFor(state.wordLength).includes(action.slice(6)) ||
      (state.hardMode && hardModeViolation(action.slice(6), state.guesses) !== null)
    ) {
      throw new GauntletRuleError(`unknown action ${JSON.stringify(action)}`);
    }
    const guess = action.slice(6);
    const pattern = feedbackFor(guess, state.answer);
    const guesses = state.guesses.concat([{ guess, pattern }]);
    let status = /** @type {WordleState['status']} */ ('playing');
    if (pattern === 'G'.repeat(state.wordLength)) {
      status = 'won';
    } else if (guesses.length >= state.maxGuesses) {
      status = 'lost';
    }
    return { ...state, guesses, status };
  },

  /**
   * @param {WordleState} state
   * @returns {Outcome | null}
   */
  outcome(state) {
    if (state.status === 'playing') return null;
    return terminalOutcome(state);
  },

  /**
   * Budget truncation on an efficiency tier: unsolved. (The runner also ends
   * exhausted episodes itself; this covers direct calls and is required by
   * the Game shape.)
   *
   * @param {WordleState} state
   * @returns {Outcome}
   */
  truncate(state) {
    return {
      normalized: [0],
      raw: null,
      reason: 'budget exhausted before the answer was found',
      solved: false,
      par: parOf(state),
    };
  },
};

/**
 * Par for an episode: the entropy-greedy reference strategy's guess count for
 * this answer.
 *
 * @param {WordleState} state
 * @returns {number}
 */
function parOf(state) {
  return referenceGuessCount(state.wordLength, state.hardMode, state.answer);
}

/**
 * The terminal outcome, shared by outcome() for won and lost states.
 *
 * @param {WordleState} state
 * @returns {Outcome}
 */
function terminalOutcome(state) {
  const par = parOf(state);
  const actions = state.guesses.length;
  if (state.status === 'won') {
    // In-range view of the efficiency score min(1.15, (par/actions)^2); the
    // scoring layer computes the capped episode score from solved, par and
    // the agent's action count.
    return {
      normalized: [Math.min(1, (par / actions) ** 2)],
      raw: [actions],
      reason: `solved: the answer was found in ${actions} guess(es), reference par ${par}`,
      solved: true,
      par,
    };
  }
  return {
    normalized: [0],
    raw: null,
    reason: `unsolved: the ${actions}-guess budget ran out without finding the answer, reference par ${par}`,
    solved: false,
    par,
  };
}

/**
 * Game state: plain JSON, so it survives a round trip unchanged. The answer
 * lives in the state but is never exposed through `observe`.
 *
 * @typedef {object} WordleState
 * @property {string} seed Episode seed (par derivation); never observed.
 * @property {number} wordLength Word length for the tier.
 * @property {number} maxGuesses Guess budget for this tier.
 * @property {boolean} hardMode Whether revealed hints must be reused.
 * @property {string} answer The hidden answer; never observed.
 * @property {WordleHistoryEntry[]} guesses Guesses so far, in order.
 * @property {'playing' | 'won' | 'lost'} status
 */

/** @type {Game<WordleState>} */
export default wordle;
