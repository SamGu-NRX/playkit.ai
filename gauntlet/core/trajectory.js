/**
 * Trajectory format `playkit-gauntlet-trajectory/1` and its verifier. A
 * trajectory is replayable: from (game, tier, seed) alone, every recorded
 * action reproduces every observation hash and the final outcome. Pure JS,
 * no `node:*`.
 *
 * @module
 */

import { canonicalJson, hashObservation } from './canonical.js';
import { GauntletRuleError } from './errors.js';
import { forfeitOutcome, unsolvedOutcome } from './outcomes.js';
import { judgeReply } from './runner.js';

/** @import { Game, TierSpec, Trajectory } from './types.js' */

export const TRAJECTORY_FORMAT = 'playkit-gauntlet-trajectory/1';

export { canonicalJson, hashObservation };

/**
 * Deep structural equality over JSON-able values, via canonical JSON.
 *
 * @param {*} a
 * @param {*} b
 * @returns {boolean}
 */
function same(a, b) {
  try {
    return canonicalJson(a) === canonicalJson(b);
  } catch {
    return false;
  }
}

/**
 * @param {Game<*>} game
 * @param {Trajectory} trajectory
 * @returns {TierSpec | null}
 */
function tierOf(game, trajectory) {
  return game.spec.tiers.find((t) => t.id === trajectory.tier) ?? null;
}

/**
 * Replay every recorded action from reset and check each observation hash,
 * legality, the step counts, and the final outcome.
 *
 * @param {Game<*>} game
 * @param {Trajectory} trajectory
 * @returns {Promise<{ ok: true } | { ok: false, step: number, reason: string }>}
 *   `step` is the 0-based step index, or -1 for pre-step failures.
 */
export async function verifyTrajectory(game, trajectory) {
  if (trajectory.format !== TRAJECTORY_FORMAT) {
    return {
      ok: false,
      step: -1,
      reason: `unknown format ${JSON.stringify(trajectory.format)}, expected ${TRAJECTORY_FORMAT}`,
    };
  }
  if (trajectory.game.id !== game.spec.id) {
    return {
      ok: false,
      step: -1,
      reason: `trajectory is for game "${trajectory.game.id}", verifier is for "${game.spec.id}"`,
    };
  }
  if (trajectory.game.version !== game.spec.version) {
    return {
      ok: false,
      step: -1,
      reason: `trajectory recorded game version ${trajectory.game.version} but the current game is ${game.spec.version}; the old version may no longer replay`,
    };
  }
  const tier = tierOf(game, trajectory);
  if (!tier) {
    return {
      ok: false,
      step: -1,
      reason: `game "${game.spec.id}" has no tier "${trajectory.tier}"`,
    };
  }
  const seats = game.spec.seats;
  const agentSeat = trajectory.agent.seat;
  if (
    !Number.isInteger(agentSeat) ||
    agentSeat < 0 ||
    agentSeat >= seats
  ) {
    return {
      ok: false,
      step: -1,
      reason: `agent seat ${agentSeat} is invalid for ${seats} seat(s)`,
    };
  }
  if (typeof game.agentSeat === 'function') {
    const expectedSeat = game.agentSeat(tier, trajectory.seed);
    if (expectedSeat !== agentSeat) {
      return {
        ok: false,
        step: -1,
        reason: `trajectory agent seat ${agentSeat} but game derives ${expectedSeat} from this seed`,
      };
    }
  }

  let state;
  try {
    state = game.reset(tier, trajectory.seed);
  } catch (err) {
    return {
      ok: false,
      step: -1,
      reason: `reset threw: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  let consecutiveInvalid = 0;
  let agentActions = 0;
  let invalidActions = 0;

  for (let i = 0; i < trajectory.steps.length; i++) {
    const step = trajectory.steps[i];
    const seat = game.toAct(state);
    if (seat === null) {
      return {
        ok: false,
        step: i,
        reason: `step ${i} recorded after the game was over`,
      };
    }
    if (step.seat !== seat) {
      return {
        ok: false,
        step: i,
        reason: `step ${i} claims seat ${step.seat} but it is seat ${seat}'s turn`,
      };
    }
    const expectedBy = seat === agentSeat ? 'agent' : 'opponent';
    if (step.by !== expectedBy) {
      return {
        ok: false,
        step: i,
        reason: `step ${i} claims by="${step.by}" but seat ${seat} is a ${expectedBy}`,
      };
    }
    let observation;
    try {
      observation = game.observe(state, seat);
    } catch (err) {
      return {
        ok: false,
        step: i,
        reason: `observe threw at step ${i}: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    const expectedHash = hashObservation(observation);
    if (step.observationHash !== expectedHash) {
      return {
        ok: false,
        step: i,
        reason: `observation hash mismatch at step ${i}: recorded ${step.observationHash}, replay gives ${expectedHash}`,
      };
    }
    const legal = /** @type {string[]} */ (game.legalActions(state, seat));
    const replyText =
      step.reply && typeof step.reply.text === 'string'
        ? step.reply.text
        : '';
    // Re-derive the runner's own accept/reject decision from the recorded
    // reply, so a trajectory can only verify if the runner could have
    // produced it exactly.
    const decision = judgeReply(game, state, seat, legal, replyText);
    if (step.invalid && step.by === 'opponent') {
      return {
        ok: false,
        step: i,
        reason: `step ${i} is an invalid opponent step, but the runner rejects invalid opponent replies outright and could not have recorded one`,
      };
    }
    if (step.invalid) {
      if (!decision.invalid) {
        return {
          ok: false,
          step: i,
          reason: `step ${i} is marked invalid, but its reply parses to the legal action ${JSON.stringify(decision.canonical)}; the runner would have accepted it and moved`,
        };
      }
      if (step.action !== decision.attempted) {
        return {
          ok: false,
          step: i,
          reason: `step ${i} records action ${JSON.stringify(step.action)}, but the runner would extract ${JSON.stringify(decision.attempted)} from its reply`,
        };
      }
      agentActions++;
      invalidActions++;
      consecutiveInvalid++;
      continue;
    }
    if (decision.invalid) {
      return {
        ok: false,
        step: i,
        reason: `step ${i} records a valid action, but the runner would have rejected its reply: ${decision.reason}`,
      };
    }
    if (step.action !== decision.canonical) {
      return {
        ok: false,
        step: i,
        reason: `step ${i} records action ${JSON.stringify(step.action)}, but its reply parses to ${JSON.stringify(decision.canonical)}`,
      };
    }
    try {
      state = game.step(state, seat, step.action);
    } catch (err) {
      return {
        ok: false,
        step: i,
        reason: `step ${i} threw: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    consecutiveInvalid = 0;
    if (step.by === 'agent') agentActions++;
  }

  if (agentActions !== trajectory.end.agentActions) {
    return {
      ok: false,
      step: trajectory.steps.length,
      reason: `end.agentActions is ${trajectory.end.agentActions} but the replay counts ${agentActions}`,
    };
  }
  if (invalidActions !== trajectory.end.invalidActions) {
    return {
      ok: false,
      step: trajectory.steps.length,
      reason: `end.invalidActions is ${trajectory.end.invalidActions} but the replay counts ${invalidActions}`,
    };
  }

  const end = trajectory.end;
  const reason = end.reason;
  if (reason === 'terminal') {
    if (game.toAct(state) !== null) {
      return {
        ok: false,
        step: trajectory.steps.length,
        reason: 'end reason is terminal but the replayed game is not over',
      };
    }
    const outcome = game.outcome(state);
    if (!same(outcome, end.outcome)) {
      return {
        ok: false,
        step: trajectory.steps.length,
        reason: 'final outcome differs from the replayed game outcome',
      };
    }
  } else if (reason === 'forfeit-invalid') {
    if (game.toAct(state) === null) {
      return {
        ok: false,
        step: trajectory.steps.length,
        reason: 'end reason is forfeit-invalid but the replayed game reached a natural end',
      };
    }
    if (consecutiveInvalid < 1) {
      return {
        ok: false,
        step: trajectory.steps.length,
        reason: 'end reason is forfeit-invalid but the last agent attempts were not consecutive invalid actions',
      };
    }
    const expected = forfeitOutcome(seats, agentSeat);
    if (!same(expected, end.outcome)) {
      return {
        ok: false,
        step: trajectory.steps.length,
        reason: 'forfeit outcome differs from the standard forfeit outcome',
      };
    }
  } else if (reason === 'budget-exhausted') {
    if (game.toAct(state) === null) {
      return {
        ok: false,
        step: trajectory.steps.length,
        reason: 'end reason is budget-exhausted but the replayed game reached a natural end',
      };
    }
    if (agentActions !== tier.maxActions) {
      return {
        ok: false,
        step: trajectory.steps.length,
        reason: `end reason is budget-exhausted with ${agentActions} agent attempts but tier.maxActions is ${tier.maxActions}`,
      };
    }
    let expected;
    if (tier.scoring === 'efficiency') {
      expected = unsolvedOutcome(seats);
    } else {
      if (typeof game.truncate !== 'function') {
        return {
          ok: false,
          step: trajectory.steps.length,
          reason: 'tier scores by outcome but the game implements no truncate()',
        };
      }
      expected = game.truncate(state);
    }
    if (!same(expected, end.outcome)) {
      return {
        ok: false,
        step: trajectory.steps.length,
        reason: 'budget outcome differs from the game truncate()/unsolved outcome',
      };
    }
  } else {
    return {
      ok: false,
      step: trajectory.steps.length,
      reason: `unknown end reason ${JSON.stringify(reason)}`,
    };
  }

  if (tier.scoring === 'efficiency' && reason === 'terminal') {
    const outcomeRecord = /** @type {import('./types.js').Outcome} */ (end.outcome);
    if (typeof outcomeRecord.solved !== 'boolean') {
      return {
        ok: false,
        step: trajectory.steps.length,
        reason: 'efficiency-tier terminal outcome is missing boolean solved',
      };
    }
    if (!('par' in outcomeRecord)) {
      return {
        ok: false,
        step: trajectory.steps.length,
        reason: 'efficiency-tier terminal outcome is missing par',
      };
    }
  }

  return { ok: true };
}

export { GauntletRuleError };
