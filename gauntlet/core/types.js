/**
 * The Gauntlet environment contract. The names in this file are fixed: game
 * packets, the agent harness, scoring and the wire protocol are built against
 * them. Everything here is plain JSDoc — this module has no runtime exports
 * and must never import `node:*` (it loads in the browser too).
 *
 * @module
 */

/**
 * How much an agent can see.
 *
 * @typedef {'perfect' | 'hidden'} InformationMode
 */

/**
 * Tags a game can carry.
 *
 * @typedef {'adversarial' | 'planning' | 'deduction' | 'long-horizon' | 'probabilistic' | 'spatial'} GameTag
 */

/**
 * How a tier converts a finished episode into a score.
 *
 * - `outcome`: score comes from the final Outcome (win/draw/loss, capped
 *   scores, ...). Tiers scoring by outcome require `Game.truncate`.
 * - `efficiency`: score depends on finishing (solved) and how many agent
 *   actions it took relative to `par`. Requires `parKind`.
 *
 * @typedef {'outcome' | 'efficiency'} ScoringMode
 */

/**
 * Where the efficiency-tier `par` number comes from.
 *
 * - `optimal`: a proven game-theoretic/optimality bound.
 * - `reference`: a measured reference run (e.g. a strong baseline agent).
 *
 * @typedef {'optimal' | 'reference'} ParKind
 */

/**
 * Which population an agent belongs to.
 *
 * - `baseline`: bundled agents (random, fixed scripts, engines).
 * - `official`: evaluated agents on the official track. They see only
 *   `TurnContext.observation.text` — the runner passes them
 *   `legalActions: null` and they must parse the rules text.
 * - `community`: submitted agents, same information rights as baseline.
 *
 * @typedef {'baseline' | 'official' | 'community'} AgentTrack
 */

/**
 * A game description. Immutable once registered; bump `version` (semver)
 * whenever rules, generation or observation text change, so recorded
 * trajectories stay replayable.
 *
 * @typedef {object} GameSpec
 * @property {string} id Stable registry id, e.g. "chess".
 * @property {string} version Semver of the rules/observation text.
 * @property {string} title Human-readable title.
 * @property {1 | 2} seats Number of seats (1 = solitaire, 2 = one opponent).
 * @property {InformationMode} information Whether observations ever hide state.
 * @property {boolean} stochastic Whether the game itself uses randomness
 *   (opponents drawn from seeds do not count).
 * @property {GameTag[]} tags Subset of the allowed tags.
 * @property {boolean} benchmark False for smoke/fixture games; they are
 *   excluded from official scoring.
 * @property {string[]} requires External programs the game shells out to,
 *   e.g. ["stockfish"]. Empty by default.
 * @property {string} rulesText The complete rules and action grammar every
 *   agent sees. Official-track agents rely on this being sufficient.
 * @property {TierSpec[]} tiers At least one.
 */

/**
 * One difficulty/scoring band of a game.
 *
 * @typedef {object} TierSpec
 * @property {string} id Tier id, unique within the game, e.g. "engine-1400".
 * @property {number} rank 1 is easiest; unique and consecutive from 1.
 * @property {ScoringMode} scoring How episodes are scored.
 * @property {number} maxActions Agent action attempts (invalid ones included)
 *   before the episode ends as budget-exhausted.
 * @property {number} publicSeeds How many public seeds exist for this tier;
 *   public seed i is `<game>/<tier>/public/<i>` for i < publicSeeds.
 * @property {*} params Game-specific JSON (board sizes, engine strength...).
 * @property {ParKind} [parKind] Required on efficiency tiers.
 */

/**
 * What an agent sees at a decision point. `text` is the only channel
 * official-track agents get; `data` carries structured state for harnesses.
 * Observations must never reveal hidden information (e.g. the other seat's
 * hand in a hidden-information game).
 *
 * @typedef {object} Observation
 * @property {string} text Full observation text, including the legal-action
 *   list when there are 64 or fewer legal actions.
 * @property {*} data Game-specific JSON payload (may be the full state for
 *   perfect-information games).
 */

/**
 * Result of parsing an agent's action text.
 *
 * @typedef {object} ParseOk
 * @property {true} ok
 * @property {string} action The canonical action string.
 */

/**
 * @typedef {object} ParseError
 * @property {false} ok
 * @property {string} error Why the text was rejected (becomes the agent's
 *   next-turn feedback).
 */

/**
 * @typedef {ParseOk | ParseError} ParseResult
 */

/**
 * The result of a finished game, per seat.
 *
 * @typedef {object} Outcome
 * @property {number[]} normalized Per seat, in [0, 1].
 * @property {Array<*> | null} raw Per seat, game-native scores (e.g. piece
 *   counts), or null for synthetic outcomes (forfeit/budget).
 * @property {string} reason Human-readable summary of why the game ended.
 * @property {boolean} [solved] Required on efficiency tiers.
 * @property {number | null} [par] Required on efficiency tiers: the par
 *   action count this episode is measured against.
 */

/**
 * Everything an agent gets for one decision. `legalActions` is null for
 * official-track agents, who see only `observation.text` and must derive
 * legality from the rules text.
 *
 * @typedef {object} TurnContext
 * @property {GameSpec} spec
 * @property {TierSpec} tier
 * @property {number} seat
 * @property {number} turn Zero-based attempt index for this seat (invalid
 *   attempts consume turns).
 * @property {Observation} observation
 * @property {string[] | null} legalActions Sorted canonical actions, or null
 *   on the official track.
 * @property {string | null} feedback The previous invalid attempt's message,
 *   or null.
 */

/**
 * Token/cost accounting for one agent reply.
 *
 * @typedef {object} Usage
 * @property {number} inputTokens
 * @property {number} outputTokens
 * @property {number | null} costUsd Number, or null when unknown.
 */

/**
 * What an agent returns from `act`.
 *
 * @typedef {object} AgentReply
 * @property {string} text Raw reply text. The runner reads the action from
 *   the last non-empty line.
 * @property {Usage} [usage]
 * @property {*} [meta] Free-form diagnostics (reasoning traces, sampling
 *   info). Recorded in the trajectory, never interpreted.
 */

/**
 * An agent that can play a game.
 *
 * @typedef {object} Agent
 * @property {string} id
 * @property {AgentTrack} track
 * @property {(ctx: TurnContext) => Promise<AgentReply>} act
 * @property {string} [model]
 * @property {string} [provider]
 * @property {boolean} [dryRun] True for harness shakedowns that must not hit
 *   paid APIs.
 */

/**
 * A game implementation. All state-transition functions are pure: `step`
 * returns a fresh state and never mutates its input, so states survive a
 * JSON round trip and replays are exact.
 *
 * @template S
 * @typedef {object} Game
 * @property {GameSpec} spec
 * @property {(tier: TierSpec, seed: string) => S} reset Deterministic in
 *   (tier, seed); returns JSON-serializable initial state.
 * @property {(state: S) => number | null} toAct The seat to act, or null
 *   when the game is over.
 * @property {(state: S, seat: number) => Observation} observe
 * @property {(state: S, seat: number) => string[]} legalActions Sorted
 *   canonical action strings.
 * @property {(state: S, seat: number, text: string) => ParseResult} parseAction
 *   Accepts documented alternates, returns the canonical action. Rejects
 *   anything unusable with ok:false (or by throwing GauntletRuleError).
 * @property {(state: S, seat: number, action: string) => S} step Pure; throws
 *   GauntletRuleError for any action not in legalActions.
 * @property {(state: S) => Outcome | null} outcome Exactly when toAct is
 *   null; null otherwise.
 * @property {(state: S) => Outcome} truncate The Outcome used when the
 *   agent's budget runs out. Required when any tier scores by outcome.
 * @property {(tier: TierSpec, seed: string, seat: number) => Agent} [opponent]
 *   Returns the opponent Agent for a seat; required when seats is 2.
 * @property {(tier: TierSpec, seed: string) => number} [agentSeat] The
 *   evaluated agent's seat; default 0.
 */

export {};

/**
 * One recorded ply of an episode.
 *
 * @typedef {object} TrajectoryStep
 * @property {number} seat
 * @property {'agent' | 'opponent'} by
 * @property {string} observationHash
 * @property {{ text: string, meta?: Record<string, *> }} reply
 * @property {string} action
 * @property {boolean} invalid
 * @property {Usage | null} usage
 * @property {number} ms
 */

/**
 * A full recorded episode: replayable via verifyTrajectory.
 *
 * @typedef {object} Trajectory
 * @property {'playkit-gauntlet-trajectory/1'} format
 * @property {{ id: string, version: string }} game
 * @property {string} tier
 * @property {string} seed
 * @property {'public' | 'eval'} split
 * @property {{ id: string, track: AgentTrack, seat: number, model?: string, provider?: string, dryRun?: boolean }} agent
 * @property {{ seat: number, id: string }[]} opponents
 * @property {TrajectoryStep[]} steps
 * @property {{ reason: string, outcome: Outcome | null, agentActions: number, invalidActions: number }} end
 * @property {string} startedAt
 * @property {string} finishedAt
 */
