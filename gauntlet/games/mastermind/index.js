/**
 * Mastermind: one seat, hidden information, pure deduction. The episode seed
 * fixes a secret code (repeated colors allowed); every guess scores black
 * pegs (right color, right place) and white pegs (right color, wrong place).
 * The observation never reveals the secret — only the guess history, its
 * feedback, and the guesses remaining. Efficiency-scored: par is the guess
 * count of the bundled reference strategy (`reference.js`) for this secret.
 * The `mini` tier (3 pegs, 4 colors) is the on-ramp: a 64-code space a weak
 * agent can deduce within budget, while random guessing still floors out.
 *
 * @module
 */

import { GauntletRuleError } from '../../core/errors.js';
import { nextInt, rngFromSeed } from '../../core/rng.js';
import {
  allCodes,
  alphabetFor,
  feedbackFor,
  referenceGuessCount,
} from './reference.js';

/** @import { Game, InformationMode, GameTag, Observation, Outcome, ParseResult, TierSpec } from '../../core/types.js' */

/**
 * One recorded guess and its feedback.
 *
 * @typedef {object} MastermindHistoryEntry
 * @property {string} guess The guessed code, e.g. "AABB".
 * @property {number} blacks Right color, right place.
 * @property {number} whites Right color, wrong place.
 */

/**
 * Game state: plain JSON, so it survives a round trip unchanged. The secret
 * lives in the state but is never exposed through `observe`.
 *
 * @typedef {object} MastermindState
 * @property {string} seed Episode seed (par derivation); never observed.
 * @property {number} pegs Code length.
 * @property {number} colors Size of the color alphabet.
 * @property {string} secret The hidden code; never observed.
 * @property {MastermindHistoryEntry[]} guesses Guesses so far, in order.
 * @property {number} maxGuesses Guess budget for this tier.
 * @property {'playing' | 'won' | 'lost'} status
 */

const TIER_DEFS = [
  // maxPar values: mini 5 is the largest par measured over 300 seeds
  // (distribution 1:6, 2:35, 3:152, 4:86, 5:21, mean 3.27); classic 5 is
  // Knuth's proven worst case; wide 8 and deep 9 are the largest par values
  // measured over 120 seeds each (wide mean 5.71 max 8; deep mean 6.53 max 8,
  // seen on ~9% of seeds, so one step of headroom) — the static budget is
  // 5 × maxPar.
  { id: 'mini', pegs: 3, colors: 4, maxPar: 5 },
  { id: 'classic', pegs: 4, colors: 6, maxPar: 5 },
  { id: 'wide', pegs: 5, colors: 8, maxPar: 8 },
  { id: 'deep', pegs: 6, colors: 9, maxPar: 9 },
];

/**
 * Tier budget: max(10, 5 × par). The static tier budget is sized from the
 * largest par the reference strategy produces (measured over 100 seeds for
 * `wide` and `deep`; Knuth's worst case of 5 is proven for `classic`), so
 * every episode keeps the full 5×-par allowance the design gives.
 *
 * @param {number} maxPar
 * @returns {number}
 */
function budgetFor(maxPar) {
  return Math.max(10, 5 * maxPar);
}

/**
 * The secret for an episode: pegs independent draws from the episode RNG
 * (a sub-stream of the episode seed), repeated colors allowed.
 *
 * @param {number} pegs
 * @param {number} colors
 * @param {string} seed
 * @returns {string}
 */
function secretFor(pegs, colors, seed) {
  let state = rngFromSeed(`${seed}/secret`);
  let code = '';
  for (let i = 0; i < pegs; i++) {
    const draw = nextInt(state, 0, colors - 1);
    code += 'ABCDEFGHI'[draw.value];
    state = draw.state;
  }
  return code;
}

/**
 * Canonical action for a code.
 *
 * @param {string} code
 * @returns {string}
 */
function canonicalAction(code) {
  return `guess ${code}`;
}

/**
 * Canonical actions per tier shape, cached: the full code space is far larger
 * than 64 entries and `legalActions` runs every ply.
 *
 * @type {Map<string, string[]>}
 */
const CANONICAL_ACTIONS_CACHE = new Map();

/**
 * @param {number} pegs
 * @param {number} colors
 * @returns {string[]} Sorted canonical actions; callers must not mutate.
 */
function canonicalActionsFor(pegs, colors) {
  const key = `${pegs}/${colors}`;
  const cached = CANONICAL_ACTIONS_CACHE.get(key);
  if (cached) return cached;
  const actions = allCodes(pegs, colors).map(canonicalAction);
  CANONICAL_ACTIONS_CACHE.set(key, actions);
  return actions;
}

export const mastermind = {
  spec: {
    id: 'mastermind',
    version: '1.0.0',
    title: 'Mastermind',
    seats: /** @type {1 | 2} */ (1),
    information: /** @type {InformationMode} */ ('hidden'),
    stochastic: false,
    tags: /** @type {GameTag[]} */ (['deduction']),
    benchmark: true,
    requires: [],
    rulesText: [
      'Mastermind: deduce a hidden secret code. Each tier fixes the code length (pegs) and the color alphabet:',
      'tier mini: 3 pegs over 4 colors (A, B, C, D);',
      'tier classic: 4 pegs over 6 colors (A, B, C, D, E, F);',
      'tier wide: 5 pegs over 8 colors (A through H);',
      'tier deep: 6 pegs over 9 colors (A through I).',
      'Colors may repeat within a code, and every position of the secret is one of the tier\'s colors.',
      'After each guess you learn two counts: black pegs = positions where your guess has the right color in the right place; white pegs = positions where your guess has a right color in the wrong place (a color is counted at most once per secret position; repeated colors follow standard Mastermind counting).',
      'You win by guessing the exact secret. The episode is scored on efficiency: par is the number of guesses a strong reference strategy needs for this secret, so fewer guesses score higher.',
      'Action grammar: "guess" followed by the code in color letters, e.g. "guess ABCB" for a 4-peg tier.',
      'Documented alternates: the bare code ("ABCB"), lowercase letters, a verb ("try ABCB", "play ABCB"), spaces between letters ("A B C B"), and surrounding quotes or backticks are all accepted.',
      'A guess with the wrong length or an unknown color letter is invalid and consumes an action attempt.',
    ].join(' '),
    tiers: /** @type {TierSpec[]} */ (
      TIER_DEFS.map((def, index) => ({
        id: def.id,
        rank: index + 1,
        scoring: /** @type {'efficiency'} */ ('efficiency'),
        maxActions: budgetFor(def.maxPar),
        publicSeeds: 25,
        parKind: /** @type {'reference'} */ ('reference'),
        params: { pegs: def.pegs, colors: def.colors },
      }))
    ),
  },

  /**
   * @param {TierSpec} tier
   * @param {string} seed
   * @returns {MastermindState}
   */
  reset(tier, seed) {
    const { pegs, colors } = /** @type {{ pegs: number, colors: number }} */ (tier.params);
    return {
      seed,
      pegs,
      colors,
      secret: secretFor(pegs, colors, seed),
      guesses: [],
      maxGuesses: tier.maxActions,
      status: 'playing',
    };
  },

  /**
   * @param {MastermindState} state
   * @returns {number | null}
   */
  toAct(state) {
    return state.status === 'playing' ? 0 : null;
  },

  /**
   * The observation never contains the secret or the seed: two episodes with
   * different secrets are observationally identical until the first guess.
   *
   * @param {MastermindState} state
   * @param {number} seat
   * @returns {Observation}
   */
  observe(state, seat) {
    void seat;
    const alphabet = alphabetFor(state.colors);
    const remaining = state.maxGuesses - state.guesses.length;
    /** @type {string[]} */
    const lines = [
      `Mastermind. Guess the secret code: ${state.pegs} pegs, each one of the colors ${alphabet} (colors may repeat).`,
      'Feedback per guess: black = right color in the right place, white = right color in the wrong place.',
      'Action format: "guess" followed by the code letters, e.g. "guess ABAB".',
    ];
    if (state.guesses.length === 0) {
      lines.push('No guesses yet.');
    } else {
      lines.push('Guesses so far:');
      state.guesses.forEach((entry, index) => {
        lines.push(`${index + 1}. guess ${entry.guess} -> ${entry.blacks} black, ${entry.whites} white`);
      });
    }
    lines.push(`Guesses remaining: ${remaining}.`);
    // The conformance kit requires the observation to list every legal action
    // when there are at most 64. Mini (3 pegs x 4 colors) has exactly 64
    // codes; the larger tiers have 1296 or more and keep the prose format.
    const codes = allCodes(state.pegs, state.colors);
    if (codes.length <= 64) {
      lines.push('Every code below is a legal guess:');
      for (const code of codes) lines.push(`guess ${code}`);
    }
    if (state.status === 'won') {
      lines.push('Game over: the secret is solved.');
    } else if (state.status === 'lost') {
      lines.push('Game over: the guess budget ran out unsolved.');
    } else {
      lines.push(`Make guess ${state.guesses.length + 1} of ${state.maxGuesses}.`);
    }
    return {
      text: lines.join('\n'),
      data: {
        pegs: state.pegs,
        colors: state.colors,
        alphabet,
        guesses: state.guesses.map((entry) => ({ ...entry })),
        guessesRemaining: remaining,
        status: state.status,
      },
    };
  },

  /**
   * Every code over the tier alphabet is always legal (repeating a guess is
   * pointless but not against the rules). The list is cached per tier shape;
   * it is far larger than 64, so observations do not list it.
   *
   * @param {MastermindState} state
   * @param {number} seat
   * @returns {string[]}
   */
  legalActions(state, seat) {
    if (state.status !== 'playing' || seat !== 0) return [];
    return canonicalActionsFor(state.pegs, state.colors);
  },

  /**
   * @param {MastermindState} state
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
    // Fast path: already-canonical action.
    if (
      text.length === 6 + state.pegs &&
      text.startsWith('guess ') &&
      isCode(text.slice(6), state.pegs, state.colors)
    ) {
      return { ok: true, action: text };
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
    s = s.replace(/^(guess|try|play|code)\s+/i, '');
    s = s.replace(/\s+/g, '').toUpperCase();
    if (s.length === 0) {
      return { ok: false, error: 'empty action; use "guess" followed by the code letters, e.g. "guess ABAB"' };
    }
    if (!isCode(s, state.pegs, state.colors)) {
      return {
        ok: false,
        error: `cannot parse ${JSON.stringify(String(text))} as a ${state.pegs}-peg code over ${alphabetFor(state.colors)}; use "guess" followed by the code letters, e.g. "guess ${'ABCD'.slice(0, state.pegs)}"`,
      };
    }
    return { ok: true, action: canonicalAction(s) };
  },

  /**
   * @param {MastermindState} state
   * @param {number} seat
   * @param {string} action
   * @returns {MastermindState}
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
      action.length !== 6 + state.pegs ||
      !action.startsWith('guess ') ||
      !isCode(action.slice(6), state.pegs, state.colors)
    ) {
      throw new GauntletRuleError(`unknown action ${JSON.stringify(action)}`);
    }
    const guess = action.slice(6);
    const fb = feedbackFor(guess, state.secret);
    const guesses = state.guesses.concat([{ guess, blacks: fb.blacks, whites: fb.whites }]);
    let status = /** @type {MastermindState['status']} */ ('playing');
    if (fb.blacks === state.pegs) {
      status = 'won';
    } else if (guesses.length >= state.maxGuesses) {
      status = 'lost';
    }
    return { ...state, guesses, status };
  },

  /**
   * @param {MastermindState} state
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
   * @param {MastermindState} state
   * @returns {Outcome}
   */
  truncate(state) {
    return {
      normalized: [0],
      raw: null,
      reason: 'budget exhausted before the secret was found',
      solved: false,
      par: parOf(state),
    };
  },
};

/**
 * Par for an episode: the reference strategy's guess count for this secret.
 *
 * @param {MastermindState} state
 * @returns {number}
 */
function parOf(state) {
  return referenceGuessCount(state.pegs, state.colors, state.seed, state.secret);
}

/**
 * The terminal outcome, shared by outcome() for won and lost states.
 *
 * @param {MastermindState} state
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
      reason: `solved: the secret was found in ${actions} guess(es), reference par ${par}`,
      solved: true,
      par,
    };
  }
  return {
    normalized: [0],
    raw: null,
    reason: `unsolved: the ${actions}-guess budget ran out without finding the secret, reference par ${par}`,
    solved: false,
    par,
  };
}

/**
 * Whether `code` is exactly `pegs` letters, all below the `colors`-th letter.
 *
 * @param {string} code
 * @param {number} pegs
 * @param {number} colors
 * @returns {boolean}
 */
function isCode(code, pegs, colors) {
  if (typeof code !== 'string' || code.length !== pegs) return false;
  const lastAllowed = 65 + colors; // one past the last allowed letter code
  for (let i = 0; i < code.length; i++) {
    const unit = code.charCodeAt(i);
    if (unit < 65 || unit >= lastAllowed) return false;
  }
  return true;
}

/** @type {Game<MastermindState>} */
export default mastermind;
