/**
 * The episode runner. Seats the agent at `agentSeat` and the game's opponents
 * elsewhere, extracts the action from each reply, records invalid attempts,
 * and ends episodes on terminal state, forfeit, budget exhaustion, or the
 * run's wall-clock limit (`episodeTimeLimitMs`).
 * No `node:*` imports.
 *
 * @module
 */

import { GauntletRuleError } from './errors.js';
import { hashObservation } from './canonical.js';
import { forfeitOutcome, unsolvedOutcome } from './outcomes.js';
import { TRAJECTORY_FORMAT } from './trajectory.js';

/** @import { Agent, AgentReply, Game, Observation, TierSpec, Trajectory, TrajectoryStep, TurnContext, Usage } from './types.js' */

/**
 * @typedef {object} RunEpisodeOptions
 * @property {Game<*>} game
 * @property {string} tierId
 * @property {string} seed
 * @property {string} [split] 'public' or 'eval'.
 * @property {Agent} agent
 * @property {number} [maxConsecutiveInvalid] Default 3.
 * @property {number} [episodeTimeLimitMs] Wall-clock cap on the whole episode,
 *   in milliseconds. When it passes, the episode ends with the `time-limit`
 *   end reason and the forfeit outcome (the agent scores 0, every other seat
 *   1). Off by default, so earlier runs and leaderboards are unchanged.
 * @property {number} [timeLimitGraceMs] When the episode time limit fires
 *   during an agent call: how long the runner waits for the in-flight call to
 *   settle (an abort-aware agent returns or throws promptly; one that ignores
 *   the signal is cut off at the grace). Only meaningful with
 *   `episodeTimeLimitMs`; default 1000.
 * @property {() => number} [now] Millisecond clock for timings and timestamps.
 */

/**
 * @param {Game<*>} game
 * @param {string} tierId
 * @returns {TierSpec}
 */
export function findTier(game, tierId) {
  const tier = game.spec.tiers.find((t) => t && t.id === tierId);
  if (!tier) {
    throw new Error(
      `game "${game.spec.id}" has no tier "${tierId}" (tiers: ${game.spec.tiers
        .map((t) => t.id)
        .join(', ')})`
    );
  }
  return tier;
}

/**
 * Extract the attempted action from an agent reply: the last non-empty line,
 * trimmed, with wrapping backticks/quotes and a leading "action:" (any case)
 * removed. Returns null when nothing usable remains.
 *
 * @param {string} text
 * @returns {string | null}
 */
export function extractAction(text) {
  const lines = String(text)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) return null;
  let s = lines[lines.length - 1];
  for (let pass = 0; pass < 4; pass++) {
    s = s.trim();
    const prefix = /^action:\s*/i.exec(s);
    if (prefix) {
      s = s.slice(prefix[0].length);
      continue;
    }
    if (
      s.length >= 2 &&
      ((s.startsWith('`') && s.endsWith('`')) ||
        (s.startsWith('"') && s.endsWith('"')) ||
        (s.startsWith("'") && s.endsWith("'")))
    ) {
      s = s.slice(1, -1);
      continue;
    }
    break;
  }
  s = s.trim();
  return s.length > 0 ? s : null;
}

/**
 * The runner's full accept/reject decision for one reply: extract the
 * attempted action, parse it against the current state and seat, and check
 * legality. `runEpisode` and `verifyTrajectory` both call this, so replay
 * verification re-derives exactly the decision the runner made instead of
 * re-implementing a copy of it.
 *
 * @param {Game<*>} game
 * @param {*} state
 * @param {number} seat
 * @param {string[]} legalActions Sorted canonical actions for this seat.
 * @param {string} replyText Raw reply text.
 * @returns {{ attempted: string | null, canonical: string | null, invalid: boolean, reason: string | null }}
 *   `attempted` is what extractAction read from the reply (null when nothing
 *   usable); `canonical` is the accepted action on a valid reply and null
 *   otherwise; `reason` explains a rejection and is null when valid.
 */
export function judgeReply(game, state, seat, legalActions, replyText) {
  const attempted = extractAction(replyText);
  /** @type {string | null} */
  let canonical = null;
  /** @type {string | null} */
  let invalidReason = null;
  if (attempted === null) {
    invalidReason = 'no action found in reply';
  } else {
    try {
      const parsed = game.parseAction(state, seat, attempted);
      if (parsed && parsed.ok) {
        canonical = parsed.action;
      } else {
        invalidReason =
          parsed && !parsed.ok && parsed.error
            ? String(parsed.error)
            : 'unparseable action';
      }
    } catch (err) {
      invalidReason = `parseAction threw: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  let invalid = invalidReason !== null;
  if (!invalid && canonical !== null && !legalActions.includes(canonical)) {
    invalid = true;
    invalidReason = `illegal action "${canonical}"`;
    canonical = null;
  }
  return {
    attempted,
    canonical,
    invalid,
    reason: invalid ? invalidReason : null,
  };
}

/**
 * The episode hit the run's wall-clock limit: like a forfeit, the agent
 * scores 0 and every other seat scores 1. The outcome's `reason` is
 * `time-limit` so a scored trajectory shows why it ended, while `end.reason`
 * carries the same string. Defined beside the runner (rather than
 * outcomes.js) so the runner and the replay verifier share one constructor
 * without widening the outcomes module's contract.
 *
 * @param {number} seats
 * @param {number} agentSeat
 * @returns {import('./types.js').Outcome}
 */
export function timeLimitOutcome(seats, agentSeat) {
  return {
    normalized: Array.from({ length: seats }, (_, seat) => (seat === agentSeat ? 0 : 1)),
    raw: null,
    reason: 'time-limit',
    solved: false,
    par: null,
  };
}

/**
 * @param {Game<*>} game
 * @param {TierSpec} tier
 * @param {*} state
 * @param {number} agentSeat
 * @returns {import('./types.js').Outcome}
 */
function budgetOutcome(game, tier, state, agentSeat) {
  if (tier.scoring === 'efficiency') {
    return unsolvedOutcome(game.spec.seats);
  }
  if (typeof game.truncate !== 'function') {
    throw new Error(
      `game "${game.spec.id}" tier "${tier.id}" scores by outcome but the game does not implement truncate()`
    );
  }
  const outcome = game.truncate(state);
  if (!outcome || !Array.isArray(outcome.normalized)) {
    throw new Error(
      `game "${game.spec.id}" tier "${tier.id}": truncate() must return an Outcome`
    );
  }
  void agentSeat;
  return outcome;
}

/**
 * @param {Agent} agent
 * @param {number} seat
 * @returns {Trajectory['agent']}
 */
function agentRecord(agent, seat) {
  /** @type {Trajectory['agent']} */
  const record = { id: agent.id, track: agent.track, seat };
  if (agent.model !== undefined) record.model = agent.model;
  if (agent.provider !== undefined) record.provider = agent.provider;
  if (agent.dryRun !== undefined) record.dryRun = agent.dryRun;
  return record;
}

/**
 * Shut down every actor that offers a dispose(): the opponents the runner
 * builds per episode, and the agent when it holds resources too. Dispose
 * rejections are absorbed on purpose — cleanup must never mask the
 * episode's own error, and the UCI client's idle reap stays the backstop
 * for an engine that ignores its quit.
 *
 * @param {readonly import('./types.js').Agent[]} actors
 * @returns {Promise<void>}
 */
async function disposeActors(actors) {
  await Promise.allSettled(
    actors.map((actor) => {
      const dispose = /** @type {undefined | (() => unknown)} */ (
        /** @type {*} */ (actor).dispose
      );
      return typeof dispose === 'function' ? dispose.call(actor) : Promise.resolve();
    })
  );
}

/**
 * Run one episode and return its recorded trajectory.
 *
 * @param {RunEpisodeOptions} options
 * @returns {Promise<Trajectory>}
 */
export async function runEpisode({
  game,
  tierId,
  seed,
  split = 'public',
  agent,
  maxConsecutiveInvalid = 3,
  episodeTimeLimitMs,
  timeLimitGraceMs = 1000,
  now = Date.now,
}) {
  if (!agent || typeof agent.act !== 'function') {
    throw new Error('runEpisode: options.agent must be an Agent');
  }
  if (!Number.isInteger(maxConsecutiveInvalid) || maxConsecutiveInvalid < 1) {
    throw new Error('runEpisode: maxConsecutiveInvalid must be a positive integer');
  }
  if (
    episodeTimeLimitMs !== undefined &&
    (!Number.isInteger(episodeTimeLimitMs) || episodeTimeLimitMs < 1)
  ) {
    throw new Error(
      `runEpisode: episodeTimeLimitMs must be a positive integer (milliseconds), got ${JSON.stringify(episodeTimeLimitMs)}`
    );
  }
  if (!Number.isInteger(timeLimitGraceMs) || timeLimitGraceMs < 0) {
    throw new Error(
      `runEpisode: timeLimitGraceMs must be a non-negative integer (milliseconds), got ${JSON.stringify(timeLimitGraceMs)}`
    );
  }
  const spec = game.spec;
  const tier = findTier(game, tierId);
  const seats = spec.seats;

  const agentSeat =
    typeof game.agentSeat === 'function' ? game.agentSeat(tier, seed) : 0;
  if (!Number.isInteger(agentSeat) || agentSeat < 0 || agentSeat >= seats) {
    throw new Error(
      `game "${spec.id}": agentSeat(${tier.id}, "${seed}") returned invalid seat ${agentSeat} for ${seats} seat(s)`
    );
  }

  /** @type {Agent[]} */
  const actors = new Array(seats).fill(null);
  actors[agentSeat] = agent;
  /** @type {{ seat: number, id: string }[]} */
  const opponents = [];
  for (let seat = 0; seat < seats; seat++) {
    if (seat === agentSeat) continue;
    if (typeof game.opponent !== 'function') {
      throw new Error(
        `game "${spec.id}" has seats=${seats} but implements no opponent()`
      );
    }
    const opponent = game.opponent(tier, seed, seat);
    if (!opponent || typeof opponent.act !== 'function') {
      throw new Error(
        `game "${spec.id}": opponent(${tier.id}, "${seed}", ${seat}) did not return an Agent`
      );
    }
    actors[seat] = opponent;
    opponents.push({ seat, id: opponent.id });
  }

  /** @type {TrajectoryStep[]} */
  const steps = [];
  /** @type {number[]} */
  const turns = new Array(seats).fill(0);
  /** @type {string | null} */
  let feedback = null;
  let consecutiveInvalid = 0;
  let agentActions = 0;
  let invalidActions = 0;
  let state = game.reset(tier, seed);
  const startedAtMs = now();

  /**
   * Wall-clock deadline. The real-clock timer fires once via `deadlinePromise`;
   * the per-turn check compares `now()` against the deadline so an injected
   * clock fires it too (and tests can drive it without sleeping).
   */
  const deadlineMs = episodeTimeLimitMs !== undefined ? startedAtMs + episodeTimeLimitMs : null;
  let deadlineFired = false;
  let fireDeadline = () => {};
  const deadlinePromise =
    deadlineMs === null
      ? null
      : new Promise((/** @type {(value: void) => void} */ resolve) => {
          fireDeadline = () => {
            resolve();
          };
        });
  // The delay is computed on the episode's own clock (`now`): with an
  // injected clock, `deadlineMs - Date.now()` compares two different epochs
  // and goes negative, which would fire the timer immediately and make the
  // race resolve time-limit before any reply could win.
  const deadlineTimer =
    deadlineMs === null ? null : setTimeout(fireDeadline, Math.max(0, deadlineMs - now()));
  // Passed to every actor in the turn context: an abort-aware agent cancels
  // its in-flight work when the limit passes (a model agent's fetch can adopt
  // the signal; the harness owns that wiring).
  const timeLimitController = deadlineMs === null ? null : new AbortController();

  /**
   * @type {{ reason: 'terminal' | 'forfeit-invalid' | 'budget-exhausted' | 'time-limit',
   *          outcome: import('./types.js').Outcome,
   *          timeLimitMs?: number, elapsedMs?: number } | null}
   */
  let end = null;

  try {
    while (!end) {
      const seat = game.toAct(state);
      if (seat === null) {
        const outcome = game.outcome(state);
        if (!outcome) {
          throw new Error(
            `game "${spec.id}": toAct is null but outcome() returned nothing`
          );
        }
        end = { reason: 'terminal', outcome };
        break;
      }
      if (!Number.isInteger(seat) || seat < 0 || seat >= seats) {
        throw new Error(`game "${spec.id}": toAct returned invalid seat ${seat}`);
      }
      const isAgent = seat === agentSeat;
      if (isAgent && agentActions >= tier.maxActions) {
        end = {
          reason: 'budget-exhausted',
          outcome: budgetOutcome(game, tier, state, agentSeat),
        };
        break;
      }
      // Wall-clock check between turns: the deadline can pass between two
      // calls just as it can inside one. Checked only once the episode has
      // recorded at least one step — setup time (reset, statics, engine
      // seeding) must not end an episode at zero steps, which would leave a
      // trajectory with nothing to replay. `now()` is consulted, not only the
      // real-clock timer, so an injected clock fires the limit too.
      if (deadlineMs !== null && steps.length >= 1 && now() >= deadlineMs) {
        end = {
          reason: 'time-limit',
          outcome: timeLimitOutcome(seats, agentSeat),
          timeLimitMs: episodeTimeLimitMs,
          elapsedMs: now() - startedAtMs,
        };
        break;
      }
      const actor = actors[seat];
      if (!actor) {
        throw new Error(`game "${spec.id}": no agent seated for seat ${seat}`);
      }
      const observation = /** @type {Observation} */ (game.observe(state, seat));
      const legalActions = /** @type {string[]} */ (game.legalActions(state, seat));
      /** @type {TurnContext} */
      const ctx = {
        spec,
        tier,
        seat,
        turn: turns[seat],
        observation,
        legalActions: actor.track === 'official' ? null : legalActions,
        feedback,
        ...(timeLimitController ? { signal: timeLimitController.signal } : {}),
      };
      turns[seat] = turns[seat] + 1;

      const startedAt = now();
      let reply = /** @type {AgentReply | null} */ (null);
      try {
        if (deadlinePromise === null) {
          reply = await actor.act(ctx);
        } else {
          // Race the call against the wall-clock deadline. A win for the
          // deadline ends the episode even though the call is still in
          // flight; a win for the call proceeds exactly as before.
          const inflight = /** @type {Promise<AgentReply>} */ (actor.act(ctx));
          const verdict = await Promise.race([
            inflight,
            deadlinePromise.then(() => TIME_LIMIT),
          ]);
          if (verdict === TIME_LIMIT) {
            // Ask the actor to cancel its in-flight work (abort-aware agents
            // do; the rest are cut off at the grace), then wait for the call
            // to settle — its rejection must be absorbed and an abort-aware
            // agent's prompt settlement keeps the accounting honest — without
            // ever waiting longer than the grace.
            timeLimitController?.abort(
              new Error(`episode time limit ${episodeTimeLimitMs}ms reached`)
            );
            await new Promise((/** @type {(value: void) => void} */ resolve) => {
              const graceTimer = setTimeout(resolve, timeLimitGraceMs);
              inflight.then(
                () => {
                  clearTimeout(graceTimer);
                  resolve();
                },
                () => {
                  clearTimeout(graceTimer);
                  resolve();
                }
              );
            });
            end = {
              reason: 'time-limit',
              outcome: timeLimitOutcome(seats, agentSeat),
              timeLimitMs: episodeTimeLimitMs,
              elapsedMs: now() - startedAtMs,
            };
            break;
          }
          reply = /** @type {AgentReply} */ (verdict);
        }
      } catch (err) {
        if (!isAgent) {
          throw new Error(
            `opponent "${actor.id}" threw during act(): ${err instanceof Error ? err.message : String(err)}`
          );
        }
        throw err;
      }
      const ms = now() - startedAt;

      const decision = judgeReply(
        game,
        state,
        seat,
        legalActions,
        reply && typeof reply.text === 'string' ? reply.text : ''
      );
      const attempted = decision.attempted;
      const canonical = decision.canonical;
      const invalid = decision.invalid;
      const invalidReason = decision.reason;

      if (!isAgent && invalid) {
        throw new Error(
          `opponent "${actor.id}" produced an invalid action (${invalidReason}); this is a bug in the opponent, not the agent`
        );
      }

      /** @type {TrajectoryStep} */
      const stepRecord = {
        seat,
        by: isAgent ? 'agent' : 'opponent',
        observationHash: hashObservation(observation),
        reply:
          reply && typeof reply.text === 'string'
            ? {
                text: reply.text,
                ...(reply.usage !== undefined ? { usage: reply.usage } : {}),
                ...(reply.meta !== undefined ? { meta: reply.meta } : {}),
              }
            : { text: String(reply && reply.text !== undefined ? reply.text : '') },
        action: invalid ? /** @type {string} */ (attempted) : /** @type {string} */ (canonical),
        invalid,
        /** @type {Usage | null} */
        usage: reply && reply.usage ? reply.usage : null,
        ms,
      };
      steps.push(stepRecord);

      if (invalid) {
        invalidActions++;
        if (isAgent) {
          agentActions++;
          consecutiveInvalid++;
          feedback = /** @type {string} */ (invalidReason);
          if (consecutiveInvalid >= maxConsecutiveInvalid) {
            end = {
              reason: 'forfeit-invalid',
              outcome: forfeitOutcome(seats, agentSeat),
            };
          }
        }
        continue;
      }

      consecutiveInvalid = 0;
      feedback = null;
      if (isAgent) agentActions++;
      state = game.step(state, seat, /** @type {string} */ (canonical));
    }
  } finally {
    // The deadline timer must not outlive the episode: a finished trajectory
    // never leaves a pending timer parked on the event loop.
    if (deadlineTimer !== null) clearTimeout(deadlineTimer);
    // Engine-backed actors are shut down here, on success and on throw, so a
    // finished episode never leaves a child process parked until the client's
    // 60 s idle reap. disposeActors absorbs cleanup rejections on purpose: the
    // episode's own error must keep priority, and a finished trajectory must
    // not be discarded over a cleanup failure.
    await disposeActors(actors);
  }

  const finishedAtMs = now();

  return {
    format: TRAJECTORY_FORMAT,
    game: { id: spec.id, version: spec.version },
    tier: tier.id,
    seed,
    split: /** @type {'public' | 'eval'} */ (split),
    agent: agentRecord(agent, agentSeat),
    opponents,
    steps,
    end: {
      reason: end.reason,
      outcome: end.outcome,
      agentActions,
      invalidActions,
      forfeitThreshold: maxConsecutiveInvalid,
      // Recorded only for a time-limit end, and self-reported like usage: the
      // verifier cannot re-derive a wall clock from (game, tier, seed), so it
      // checks these fields' shape and trusts the recording run for the
      // numbers.
      ...(end.reason === 'time-limit'
        ? { timeLimitMs: end.timeLimitMs, elapsedMs: end.elapsedMs }
        : {}),
    },
    startedAt: new Date(startedAtMs).toISOString(),
    finishedAt: new Date(finishedAtMs).toISOString(),
  };
}

// Re-exported so harnesses can catch runner-facing rule errors without
// importing errors.js separately.
export { GauntletRuleError };

/** Sentinel the deadline race resolves with when the wall clock wins. */
const TIME_LIMIT = Symbol('time-limit');
