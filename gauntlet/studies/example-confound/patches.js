/**
 * The exact example-text replacement sets for the example-confound study,
 * preregistered in PREREGISTRATION.md (which was committed before any model
 * run). Every entry changes ONLY example text the model reads — the referee,
 * the observation hash and the trajectory are untouched.
 *
 * Fields:
 * - `field`: where the string reaches the model — 'rules' (spec.rulesText,
 *   read every turn on the official track), 'observation' (observation.text),
 *   or 'feedback' (the referee's per-turn feedback; skipped on turns where
 *   the referee has nothing to say).
 * - `find` / `replaceWith`: the exact strings. Each must occur exactly once
 *   in its field's text on a turn where the field is applicable.
 * - `note`: why the patch exists (cited in meta documentation).
 *
 * @typedef {object} ExamplePatch
 * @property {'rules' | 'observation' | 'feedback'} field
 * @property {string} find
 * @property {string} replaceWith
 * @property {string} note
 *
 * @typedef {object} PatchSet
 * @property {string} name
 * @property {string} gameId
 * @property {string | null} tierId When non-null the set applies only on
 *   that tier.
 * @property {ExamplePatch[]} patches
 */

/** @type {PatchSet} */
export const MASTERMIND_MINI_CORRECTED = {
  name: 'mastermind-mini-corrected',
  gameId: 'mastermind',
  tierId: 'mini',
  patches: [
    {
      field: 'observation',
      find: 'Action format: "guess" followed by the code letters, e.g. "guess ABAB".',
      replaceWith: 'Action format: "guess" followed by 3 code letters, e.g. "guess ABA".',
      note: 'the packet-named observation example: a 4-letter example on a 3-peg tier',
    },
    {
      field: 'rules',
      find: 'Action grammar: "guess" followed by the code in color letters, e.g. "guess ABCB" for a 4-peg tier.',
      replaceWith: 'Action grammar: "guess" followed by the code in color letters, e.g. "guess ABA" for a 3-peg tier.',
      note: 'preregistered addition: the rules show a second wrong-length example every turn, which would leave H1 (a correct-length example) untestable',
    },
  ],
};

/** @type {PatchSet} */
export const CONNECT4_LADDER_1_NEUTRAL = {
  name: 'connect4-ladder-1-neutral',
  gameId: 'connect4',
  tierId: null,
  patches: [
    {
      field: 'rules',
      find:
        'the column number alone, e.g. "4" drops into column 4. Documented alternates: ' +
        '"column 4", "col 4", "play 4", "drop 4", "place 4", "move 4", uppercase',
      replaceWith:
        'the column number alone, 1 to 7. Documented alternates: "column N", "col N", ' +
        '"play N", "drop N", "place N", "move N" for a column number N, uppercase',
      note: 'removes the worked column-4 example; the sentence continues "letters, surrounding quotes or backticks, and surrounding whitespace are all accepted." unpatched',
    },
    {
      field: 'feedback',
      find: 'use the column number 1-7, e.g. "4" or "column 4"',
      replaceWith: 'use the column number 1-7',
      note: 'removes the worked column-4 example from the referee parse-error feedback',
    },
  ],
};

/**
 * All patch sets, keyed by name. run-suite.mjs resolves --patch-set here.
 *
 * @type {Record<string, PatchSet>}
 */
export const PATCH_SETS = {
  [MASTERMIND_MINI_CORRECTED.name]: MASTERMIND_MINI_CORRECTED,
  [CONNECT4_LADDER_1_NEUTRAL.name]: CONNECT4_LADDER_1_NEUTRAL,
};
