/**
 * The conformance kit: everything a Game must satisfy to register. Runs the
 * checks per tier and seed, returns a report, and throws listing every
 * failure (so broken games cannot ship quietly). No `node:*` imports.
 *
 * @module
 */

import { canonicalJson } from './canonical.js';
import { GauntletRuleError } from './errors.js';
import { rngFromSeed, nextInt } from './rng.js';
import { publicSeed } from './seeds.js';
import { runEpisode } from './runner.js';

/** @import { Game, TierSpec } from './types.js' */

const ALLOWED_TAGS = new Set([
  'adversarial',
  'planning',
  'deduction',
  'long-horizon',
  'probabilistic',
  'spatial',
]);

/**
 * @typedef {object} ConformanceReport
 * @property {string} game
 * @property {boolean} ok
 * @property {number} checks Number of checks executed.
 * @property {string[]} failures Empty when ok.
 */

/**
 * @param {string[]} failures
 * @param {string} label
 * @param {() => void | Promise<void>} fn
 * @param {{ checks: number, pending: Promise<void>[] }} counter
 */
function check(failures, label, fn, counter) {
  counter.checks++;
  try {
    const result = fn();
    if (result instanceof Promise) {
      counter.pending.push(
        result.catch((err) => {
          failures.push(`${label}: ${err instanceof Error ? err.message : String(err)}`);
        })
      );
    }
  } catch (err) {
    failures.push(`${label}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * @param {*} condition
 * @param {string} message
 * @returns {void}
 */
function assert(condition, message) {
  if (!condition) throw new Error(message);
}

/**
 * @param {*} a
 * @param {*} b
 * @returns {boolean}
 */
function same(a, b) {
  return canonicalJson(a) === canonicalJson(b);
}

/**
 * Validate GameSpec and TierSpec fields.
 *
 * @param {Game<*>} game
 * @param {string[]} failures
 */
function validateSpec(game, failures) {
  const spec = game.spec;
  /** @param {() => void} fn */
  const expect = (fn) => check(failures, 'spec fields valid', fn, { checks: 0, pending: /** @type {Promise<void>[]} */ ([]) });
  expect(() => {
    assert(typeof spec.id === 'string' && spec.id.length > 0, 'spec.id must be a non-empty string');
    assert(
      typeof spec.version === 'string' && /^\d+\.\d+\.\d+$/.test(spec.version),
      `spec.version must be semver, got ${JSON.stringify(spec.version)}`
    );
    assert(typeof spec.title === 'string' && spec.title.length > 0, 'spec.title must be a non-empty string');
    assert(spec.seats === 1 || spec.seats === 2, 'spec.seats must be 1 or 2');
    assert(spec.information === 'perfect' || spec.information === 'hidden', 'spec.information must be "perfect" or "hidden"');
    assert(typeof spec.stochastic === 'boolean', 'spec.stochastic must be a boolean');
    assert(Array.isArray(spec.tags) && spec.tags.every((tag) => ALLOWED_TAGS.has(tag)), `spec.tags must be a subset of ${[...ALLOWED_TAGS].join(', ')}`);
    assert(typeof spec.benchmark === 'boolean', 'spec.benchmark must be a boolean');
    assert(Array.isArray(spec.requires) && spec.requires.every((r) => typeof r === 'string'), 'spec.requires must be an array of strings');
    assert(typeof spec.rulesText === 'string' && spec.rulesText.length > 0, 'spec.rulesText must be a non-empty string');
    assert(Array.isArray(spec.tiers) && spec.tiers.length > 0, 'spec.tiers must be a non-empty array');
    const ranks = spec.tiers.map((t) => t.rank).sort((a, b) => a - b);
    assert(ranks.every((rank, i) => rank === i + 1), 'tier ranks must be unique and consecutive starting at 1');
    const tierIds = new Set(spec.tiers.map((t) => t.id));
    assert(tierIds.size === spec.tiers.length, 'tier ids must be unique');
    for (const tier of spec.tiers) {
      assert(typeof tier.id === 'string' && tier.id.length > 0, 'tier.id must be a non-empty string');
      assert(tier.scoring === 'outcome' || tier.scoring === 'efficiency', `tier ${tier.id}: scoring must be "outcome" or "efficiency"`);
      assert(Number.isInteger(tier.maxActions) && tier.maxActions > 0, `tier ${tier.id}: maxActions must be a positive integer`);
      assert(Number.isInteger(tier.publicSeeds) && tier.publicSeeds > 0, `tier ${tier.id}: publicSeeds must be a positive integer`);
      assert(tier.params !== undefined, `tier ${tier.id}: params must be present (JSON)`);
      if (tier.scoring === 'efficiency') {
        assert(tier.parKind === 'optimal' || tier.parKind === 'reference', `tier ${tier.id}: efficiency tiers require parKind "optimal" or "reference"`);
      }
    }
  });
}

/**
 * Run every conformance check on a game. Returns a promise that resolves to
 * the report when everything passes, and rejects with an Error listing every
 * failure when the game is not conformant.
 *
 * @param {Game<*>} game
 * @param {{ seedsPerTier?: number }} [options]
 * @returns {Promise<ConformanceReport>}
 * @throws {Error} listing every failure when the game is not conformant.
 */
export async function runConformance(game, { seedsPerTier = 3 } = {}) {
  const spec = game.spec;
  /** @type {string[]} */
  const failures = [];
  /** @type {{ checks: number, pending: Promise<void>[] }} */
  const counter = { checks: 0, pending: /** @type {Promise<void>[]} */ ([]) };

  validateSpec(game, failures);

  for (const tier of spec.tiers) {
    for (let i = 0; i < seedsPerTier; i++) {
      const seed = publicSeed(spec.id, tier.id, i);
      checkSeed(game, tier, seed, failures, counter);
    }
  }

  await Promise.all(counter.pending);

  const report = {
    game: spec.id,
    ok: failures.length === 0,
    checks: counter.checks,
    failures,
  };
  if (failures.length > 0) {
    throw new Error(
      `conformance failed for game "${spec.id}" (${failures.length} failure(s)):\n` +
        failures.map((f) => `  - ${f}`).join('\n')
    );
  }
  return report;
}

/**
 * @param {Game<*>} game
 * @param {TierSpec} tier
 * @param {string} seed
 * @param {string[]} failures
 * @param {{ checks: number, pending: Promise<void>[] }} counter
 */
function checkSeed(game, tier, seed, failures, counter) {
  const label = `${game.spec.id}/${tier.id} seed ${seed}`;
  const spec = game.spec;
  const seats = spec.seats;

  // reset determinism
  /** @type {*} */ let stateA;
  /** @type {*} */ let stateB;
  check(failures, `${label}: reset is deterministic`, () => {
    stateA = game.reset(tier, seed);
    stateB = game.reset(tier, seed);
    assert(same(stateA, stateB), 'two reset() calls with the same tier and seed returned different states');
    JSON.parse(JSON.stringify(stateA));
  }, counter);

  if (stateA === undefined) return;

  // guided playthrough with per-state checks
  const limit = Math.min(tier.maxActions * seats, 200);
  /** @type {string[]} */
  const actions = [];
  /** @type {*} */ let state = stateA;
  for (let ply = 0; ply < limit; ply++) {
    const seat = game.toAct(state);
    if (seat === null) break;
    assertSeat(failures, label, seat, seats, counter, 'toAct returned an invalid seat');
    if (seat < 0 || seat >= seats) break;

    check(failures, `${label}: outcome is null exactly while toAct is not`, () => {
      assert(game.outcome(state) === null, `outcome() returned a value on a non-terminal state (toAct=${seat})`);
    }, counter);

    /** @type {string[] | null} */
    let legalOrNull = null;
    check(failures, `${label}: legalActions returns sorted canonical actions`, () => {
      const legal = /** @type {string[]} */ (game.legalActions(state, seat));
      legalOrNull = legal;
      assert(Array.isArray(legal), 'legalActions must return an array');
      const sorted = [...legal].sort();
      assert(same(legal, sorted), `legalActions must be sorted, got ${JSON.stringify(legal)}`);
      assert(new Set(legal).size === legal.length, 'legalActions must not repeat actions');
    }, counter);
    /** @type {string[]} */
    const legal = legalOrNull ?? [];
    if (legal.length === 0) break;

    check(failures, `${label}: observation lists the legal actions when there are 64 or fewer`, () => {
      const observation = game.observe(state, seat);
      assert(observation !== null && typeof observation.text === 'string', 'observe must return { text, data } with string text');
      JSON.parse(JSON.stringify(observation.data));
      if (legal.length <= 64) {
        for (const action of legal) {
          assert(
            observation.text.includes(action),
            `observation.text must list legal action "${action}" when there are ${legal.length} legal actions`
          );
        }
      }
    }, counter);

    check(failures, `${label}: every legal action parses to itself`, () => {
      for (const action of legal) {
        const parsed = game.parseAction(state, seat, action);
        assert(
          parsed && parsed.ok === true && parsed.action === action,
          `parseAction(${JSON.stringify(action)}) must return { ok: true, action: ${JSON.stringify(action)} }, got ${JSON.stringify(parsed)}`
        );
      }
    }, counter);

    check(failures, `${label}: a non-legal action throws GauntletRuleError from step`, () => {
      const bogus = '__not_a_gauntlet_action__';
      try {
        const parsed = game.parseAction(state, seat, bogus);
        assert(
          !parsed || parsed.ok === false,
          `parseAction accepted the nonsense action "${bogus}" as ${JSON.stringify(parsed)}`
        );
      } catch (err) {
        assert(err instanceof GauntletRuleError, `parseAction must throw GauntletRuleError, got ${err}`);
      }
      let threw = false;
      try {
        game.step(state, seat, bogus);
      } catch (err) {
        threw = true;
        assert(err instanceof GauntletRuleError, `step must throw GauntletRuleError for non-legal actions, got ${err}`);
      }
      assert(threw, `step must throw GauntletRuleError for a non-legal action, but "${bogus}" was accepted`);
    }, counter);

    // pick the next action with the seeded RNG
    const pick = nextInt(rngFromSeed(`${seed}/conformance/${ply}`), 0, legal.length - 1).value;
    const action = legal[pick];
    /** @type {*} */ let next;
    check(failures, `${label}: step leaves its input unchanged and returns fresh state`, () => {
      const before = JSON.parse(JSON.stringify(state));
      next = game.step(state, seat, action);
      assert(same(state, before), 'step mutated its input state');
      assert(next !== state, 'step must return a new state object, not the input');
      JSON.parse(JSON.stringify(next));
    }, counter);
    if (next === undefined) break;
    actions.push(action);
    state = next;
  }

  if (actions.length === 0) {
    check(failures, `${label}: playthrough ends terminal or truncated`, () => {
      assert(game.toAct(stateA) === null, 'game admits no legal actions from the initial state and is not terminal either');
      assert(game.outcome(stateA) !== null, 'terminal initial state must have an outcome');
    }, counter);
  }

  // JSON round trip mid-game, then identical continuation
  if (actions.length >= 2) {
    check(failures, `${label}: state survives a JSON round trip mid-game and play continues identically`, () => {
      let replay = game.reset(tier, seed);
      for (let i = 0; i < actions.length; i++) {
        const seat = game.toAct(replay);
        if (seat === null) break;
        replay = game.step(replay, seat, actions[i]);
        if (i === 0) {
          replay = JSON.parse(JSON.stringify(replay));
        }
      }
      let straight = game.reset(tier, seed);
      for (const action of actions) {
        const seat = game.toAct(straight);
        if (seat === null) break;
        straight = game.step(straight, seat, action);
      }
      assert(same(replay, straight), 'states diverged after a JSON round trip mid-game');
    }, counter);
  }

  // full playthrough through the runner
  check(failures, `${label}: a seeded random playthrough ends terminal or truncated with normalized scores in [0, 1]`, () => {
    const agentSeed = `${seed}/conformance-agent`;
    let ply = 0;
    const agent = {
      id: 'conformance-random',
      track: /** @type {'baseline'} */ ('baseline'),
      async act(/** @type {import('./types.js').TurnContext} */ ctx) {
        const legal = ctx.legalActions ?? [];
        if (legal.length === 0) {
          return { text: '' };
        }
        const pick = nextInt(rngFromSeed(`${agentSeed}/${ply}`), 0, legal.length - 1).value;
        ply++;
        return { text: legal[pick] };
      },
    };
    return runEpisode({ game, tierId: tier.id, seed, agent, maxConsecutiveInvalid: 1 }).then(
      (trajectory) => {
        assert(
          trajectory.end.reason === 'terminal' || trajectory.end.reason === 'budget-exhausted',
          `random playthrough ended as ${trajectory.end.reason}, expected terminal or budget-exhausted`
        );
        const outcome = /** @type {import('./types.js').Outcome} */ (trajectory.end.outcome);
        assert(outcome !== null && Array.isArray(outcome.normalized), 'end.outcome must carry normalized scores');
        assert(outcome.normalized.length === seats, `outcome.normalized must have one score per seat (${seats})`);
        for (const score of outcome.normalized) {
          assert(
            typeof score === 'number' && Number.isFinite(score) && score >= 0 && score <= 1,
            `normalized scores must be finite numbers in [0, 1], got ${score}`
          );
        }
        if (trajectory.end.reason === 'budget-exhausted' && tier.scoring === 'efficiency') {
          assert(outcome.solved === false, 'budget-exhausted efficiency outcomes must be unsolved');
        }
        if (trajectory.end.reason === 'terminal' && tier.scoring === 'efficiency') {
          assert(typeof outcome.solved === 'boolean', 'efficiency-tier outcomes must carry boolean solved');
          assert('par' in outcome, 'efficiency-tier outcomes must carry par');
        }
      }
    );
  }, counter);
}

/**
 * @param {string[]} failures
 * @param {string} label
 * @param {*} seat
 * @param {number} seats
 * @param {{ checks: number, pending: Promise<void>[] }} counter
 * @param {string} message
 */
function assertSeat(failures, label, seat, seats, counter, message) {
  check(failures, `${label}: ${message}`, () => {
    assert(Number.isInteger(seat) && seat >= 0 && seat < seats, `got ${JSON.stringify(seat)}`);
  }, counter);
}
