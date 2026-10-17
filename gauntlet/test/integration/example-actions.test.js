/**
 * Example-action conformance: any action a game quotes as an example must be
 * legal in the state that produced the quoted text. A wrong-shaped example
 * teaches agents an illegal action — the example-confound study (#104) found
 * mastermind/mini's four-peg example taught the 0.5B an illegal guess format,
 * and correcting it at prompt time cut the model's invalid-step rate ~10x —
 * so the example is part of the rules surface and gets the same conformance
 * bar as everything else the runner feeds an agent.
 *
 * Scope: for every registered game and tier, at the initial state of public
 * seed 0, for the seat to act:
 *   1. the observation text, and
 *   2. the feedback messages parseAction returns for a battery of invalid
 *      inputs (empty, garbage, wrong shape, wrong length),
 * are scanned for quoted spans that follow an `e.g.` marker — the shape every
 * game uses to introduce a worked example. Each span must parse to a legal
 * action in that state.
 *
 * Two exemptions, both explicit:
 *   - Echoes: a message that derives its "e.g." from the agent's own input
 *     (cube's `use uppercase, e.g. "R U R"`) quotes what the agent sent, not
 *     a game-chosen example; the test skips spans equal to the fed input.
 *   - The allow-list below: examples that cannot be legal by construction,
 *     named per game with the reason. Entries must be hit at least once, so
 *     stale entries fail the suite.
 *
 * @module
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { GAMES } from '../../games/index.js';
import { publicSeed } from '../../core/seeds.js';

/**
 * Quoted spans: double quotes or backticks (single quotes would pair with
 * apostrophes in prose). Examples are short; 120 characters is generous.
 *
 * @type {RegExp}
 */
const QUOTED = /["`]([^"`]{1,120}?)["`]/g;

/** The example marker every game introduces examples with. */
const EG = /e\.g\./i;

/**
 * Invalid inputs fed to parseAction to reach every rejection branch (empty,
 * garbage, bare number, wrong length, lowercase — the branches games quote
 * examples in).
 *
 * @type {string[]}
 */
const INVALID_INPUTS = ['', 'zz-9!', '0', 'ZZZZZZZZZZ', 'xx'];

/**
 * Examples that cannot be legal by construction. `tier: null` matches every
 * tier of the game; otherwise the entry covers one tier only. Every entry
 * must be hit at least once when the test runs, so a fix that removes the
 * reason (or a rename that orphans the entry) fails the suite.
 *
 * @type {{ game: string, tier: string | null, candidate: string, reason: string }[]}
 */
const ALLOWED = [
  // Chess family: the grammar line their parse feedback quotes (a UCI and a
  // SAN example each) is a notation illustration. Chess deals a seed-selected
  // opening, chess-puzzles deals puzzle positions, chess-stockfish follows
  // chess — so no fixed example move can be legal in every initial position
  // by construction. Quoted per game because each carries its own copy.
  ...['chess', 'chess-stockfish', 'chess-puzzles'].flatMap((game) =>
    ['e2e4', 'e7e8q', 'Nf3', 'O-O'].map((candidate) => ({
      game,
      tier: /** @type {string | null} */ (null),
      candidate,
      reason:
        'the action-grammar line quoted in parse feedback illustrates notation; the game deals a seed-selected position, so no fixed example move can be legal in every initial position by construction',
    }))
  ),
  {
    game: 'chess-endgames',
    tier: null,
    candidate: 'a1a2',
    reason:
      'the grammar example names a from/to pair as notation; initial positions are seeded tablebase deals, so no fixed example move can be legal on every deal by construction',
  },
  {
    game: 'othello',
    tier: null,
    candidate: 'pass',
    reason:
      'the parse error quotes "pass" as the alternative for states with no legal placement; every initial state has placements, so the quoted alternative cannot be legal there by construction',
  },
  {
    game: 'othello',
    tier: 'ladder-1',
    candidate: 'd3',
    reason:
      'the parse error quotes d3 as a notation example; ladder-1 starts from a seeded mid-game position (7 discs) in which that square is not a legal placement, and the standard-start tiers start too late for the example to be fixed here — changing othello is outside this packet\'s allowed paths',
  },
];

/**
 * The quoted spans after an `e.g.` marker in `text`, line by line: the
 * marker and its example share a line in every game's observation and parse
 * feedback, and line scoping keeps prose quotes elsewhere in the text out.
 *
 * @param {string} text
 * @returns {string[]}
 */
function exampleSpans(text) {
  const spans = [];
  for (const line of text.split('\n')) {
    const marker = EG.exec(line);
    if (!marker) continue;
    const after = line.slice(marker.index);
    QUOTED.lastIndex = 0;
    let match;
    while ((match = QUOTED.exec(after)) !== null) {
      spans.push(match[1]);
    }
  }
  return spans;
}

/**
 * Case- and space-insensitive form, for recognising input echoes.
 *
 * @param {string} s
 * @returns {string}
 */
function normalized(s) {
  return s.replace(/\s+/g, '').toUpperCase();
}

/**
 * @param {string} gameId
 * @param {string} tierId
 * @param {string} candidate
 * @returns {{ game: string, tier: string | null, candidate: string }[]} matches
 */
function allowedMatches(gameId, tierId, candidate) {
  return ALLOWED.filter(
    (entry) => entry.game === gameId && (entry.tier === null || entry.tier === tierId) && entry.candidate === candidate
  );
}

test('every quoted example action is legal at the initial state of public seed 0', () => {
  /** @type {string[]} */
  const failures = [];
  /** @type {{ game: string, tierId: string, candidate: string }[]} */
  const allowedHits = [];

  for (const game of Object.values(GAMES)) {
    const spec = game.spec;
    for (const tier of spec.tiers) {
      const state = game.reset(tier, publicSeed(spec.id, tier.id, 0));
      const seat = game.toAct(state);
      if (seat === null) throw new Error(`${spec.id}/${tier.id}: the initial state always has a seat to act`);
      const legal = game.legalActions(state, seat);

      /** @type {[string, string, string | null][]} */
      const sources = [['observation', game.observe(state, seat).text, null]];
      for (const input of INVALID_INPUTS) {
        const parsed = game.parseAction(state, seat, input);
        if (!parsed.ok) {
          sources.push([`parse-error feedback for ${JSON.stringify(input)}`, parsed.error, input]);
        }
      }

      for (const [source, text, input] of sources) {
        for (const candidate of exampleSpans(text)) {
          if (input !== null && normalized(candidate) === normalized(input)) {
            continue; // the message echoes the agent's own input, not an example
          }
          const allowed = allowedMatches(spec.id, tier.id, candidate);
          if (allowed.length > 0) {
            for (const entry of allowed) {
              allowedHits.push({ game: spec.id, tierId: tier.id, candidate: entry.candidate });
            }
            continue;
          }
          const parsedExample = game.parseAction(state, seat, candidate);
          const why = !parsedExample.ok
            ? `parseAction rejected it: ${parsedExample.error}`
            : !legal.includes(parsedExample.action)
              ? `parsed to ${JSON.stringify(parsedExample.action)} but that is not legal in this state`
              : null;
          if (why !== null) {
            failures.push(
              `${spec.id}/${tier.id} [${source}]: e.g. "${candidate}" — ${why}`
            );
          }
        }
      }
    }
  }

  // Every allow-list entry must have been hit, so the list cannot outlive
  // the reason it exists.
  const stale = ALLOWED.filter(
    (entry) =>
      !allowedHits.some(
        (hit) =>
          hit.game === entry.game &&
          (entry.tier === null || hit.tierId === entry.tier) &&
          hit.candidate === entry.candidate
      )
  );

  assert.equal(failures.length, 0, `examples quoted to agents must be legal:\n${failures.join('\n')}`);
  assert.equal(
    stale.length,
    0,
    `stale allow-list entries (no longer hit — delete them):\n${stale
      .map((entry) => `${entry.game}/${entry.tier ?? '*'}: "${entry.candidate}"`)
      .join('\n')}`
  );
  assert.ok(allowedHits.length > 0 || ALLOWED.length === 0, 'allow-list entries were hit');
});
