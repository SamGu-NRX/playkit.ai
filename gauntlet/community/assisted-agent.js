/**
 * The assisted harness (community track): wraps an official-track model agent
 * so the model sees the legal actions every turn and may retry an invalid
 * reply inside the same turn, with the referee's reason as feedback.
 *
 * This is the community-track harness of design doc section 6: the official
 * track stays harness-free (`harness/` is untouched, the official prompt is
 * untouched); results scored through this wrapper are self-reported and land
 * in the leaderboard's community table, never the official ranking.
 *
 * Per turn the wrapper derives a turn context for the inner agent whose
 * observation carries the observation text, the legal-action list (all of it
 * up to `maxLegalActions`; beyond that, the first `maxLegalActions` plus the
 * full count), and one instruction line asking for a final line of the form
 * `ACTION: <action>`. It extracts the action the way the runner does
 * (`extractAction` from `core/runner.js`) and checks it against the legal
 * list. When it is not legal, it asks again — the referee's reason and the
 * legal list again as the turn's feedback — up to `retries` times within the
 * same turn. Usage and cost sum across attempts (a null token count anywhere
 * propagates: unmeasured is never reported as measured), and `meta.assisted`
 * records the attempt count and how many of them the wrapper rejected
 * (`invalidAttempts` — the exhausted turn counts every attempt), so one
 * runner turn with retries is still one trajectory step.
 *
 * The wrapper only ever *withholds* a retry, never a submission: after the
 * last retry (or on success) the inner agent's last reply text is returned
 * untouched, and the runner's `parseAction` makes the final call — a reply the
 * wrapper's exact-match check rejected can still be canonicalized by the game.
 *
 * Pure JS, no `node:*` imports.
 *
 * @module
 */

import { extractAction } from '../core/runner.js';

/** @import { Agent, AgentReply, TurnContext, Usage } from '../core/types.js' */

/**
 * Sum two Usage records. A null count anywhere means unmeasured, and an
 * unmeasured component makes the total unmeasured — null propagates, 0 lies.
 *
 * @param {Usage | undefined} a
 * @param {Usage | undefined} b
 * @returns {Usage}
 */
function sumUsage(a, b) {
  const inputA = a && a.inputTokens !== undefined ? a.inputTokens : null;
  const outputA = a && a.outputTokens !== undefined ? a.outputTokens : null;
  const inputB = b && b.inputTokens !== undefined ? b.inputTokens : null;
  const outputB = b && b.outputTokens !== undefined ? b.outputTokens : null;
  const costA = a && a.costUsd !== undefined ? a.costUsd : null;
  const costB = b && b.costUsd !== undefined ? b.costUsd : null;
  const anyNull =
    inputA === null || outputA === null || inputB === null || outputB === null;
  return {
    inputTokens: anyNull
      ? null
      : /** @type {number} */ (inputA) + /** @type {number} */ (inputB),
    outputTokens: anyNull
      ? null
      : /** @type {number} */ (outputA) + /** @type {number} */ (outputB),
    costUsd: costA === null || costB === null ? null : costA + costB,
  };
}

const ZERO_USAGE = /** @type {Usage} */ ({ inputTokens: 0, outputTokens: 0, costUsd: null });

/**
 * Wrap a comma-joined action list to lines of at most ~100 characters so the
 * prompt stays readable for wide boards.
 *
 * @param {string} joined
 * @returns {string}
 */
function wrapActionList(joined) {
  const words = joined.split(', ');
  /** @type {string[]} */
  const lines = [];
  let line = '';
  for (const word of words) {
    if (line.length > 0 && line.length + 2 + word.length > 100) {
      lines.push(line);
      line = word;
    } else {
      line = line.length > 0 ? `${line}, ${word}` : word;
    }
  }
  if (line.length > 0) lines.push(line);
  return lines.join('\n');
}

/**
 * @typedef {object} AssistedAgentOptions
 * @property {Agent} inner The wrapped agent (typically an official-track
 *   model agent from harness/model-agent.js). It receives only derived turn
 *   contexts, never the runner's raw one.
 * @property {number} [retries] Re-asks after an invalid first attempt, within
 *   the same runner turn. Default 2, so a turn makes at most 3 provider calls.
 * @property {number} [maxLegalActions] Legal-action list cap. At or below the
 *   cap the full sorted list is shown; above it, the first `maxLegalActions`
 *   actions plus the full count. Default 64 (the design doc's threshold for
 *   embedding the list in observations).
 * @property {string} [id] Agent id. Default `community-assisted:<inner id>`.
 */

/**
 * Build the community-track assisted agent around an inner agent.
 *
 * @param {AssistedAgentOptions} options
 * @returns {Agent & { dispose: () => Promise<void> }}
 */
export function createAssistedAgent(options) {
  const { inner } = options;
  if (!inner || typeof inner.act !== 'function') {
    throw new Error(
      'createAssistedAgent: options.inner must be an agent with an act(ctx) method'
    );
  }
  const retries = options.retries ?? 2;
  if (!Number.isInteger(retries) || retries < 0) {
    throw new Error(
      `createAssistedAgent: retries must be an integer >= 0, got ${options.retries}`
    );
  }
  const maxLegalActions = options.maxLegalActions ?? 64;
  if (!Number.isInteger(maxLegalActions) || maxLegalActions < 1) {
    throw new Error(
      `createAssistedAgent: maxLegalActions must be an integer >= 1, got ${options.maxLegalActions}`
    );
  }
  const id = options.id ?? `community-assisted:${inner.id}`;

  /**
   * The observation text the inner agent sees: the runner's observation, the
   * legal-action block, and the ACTION-line instruction.
   *
   * @param {TurnContext} ctx
   * @returns {string}
   */
  function buildObservationText(ctx) {
    const legal = /** @type {string[]} */ (ctx.legalActions);
    /** @type {string[]} */
    const parts = [];
    if (legal.length <= maxLegalActions) {
      parts.push(`Legal actions (${legal.length}):\n${wrapActionList(legal.join(', '))}`);
    } else {
      parts.push(
        `Legal actions (${legal.length} total, first ${maxLegalActions} shown — any of the ` +
          `${legal.length} is allowed, the rules above define the full format):\n` +
          wrapActionList(legal.slice(0, maxLegalActions).join(', '))
      );
    }
    parts.push(
      'End your reply with a final line of the form `ACTION: <action>` where ' +
        '<action> is copied exactly from one of the legal actions above.'
    );
    return `${ctx.observation.text}\n\n${parts.join('\n\n')}`;
  }

  return {
    id,
    track: /** @type {'community'} */ ('community'),
    ...(inner.model !== undefined ? { model: inner.model } : {}),
    ...(inner.provider !== undefined ? { provider: inner.provider } : {}),
    ...(inner.dryRun !== undefined ? { dryRun: inner.dryRun } : {}),
    async act(ctx) {
      if (!Array.isArray(ctx.legalActions)) {
        throw new Error(
          `agent "${id}" needs the community track's legal actions; got legalActions: null — ` +
            'seat it through a community-track spec (community-assisted:...), not on the official track'
        );
      }
      const augmentedText = buildObservationText(ctx);
      /** @type {TurnContext} */
      let attemptCtx = {
        ...ctx,
        legalActions: null,
        observation: { ...ctx.observation, text: augmentedText },
        feedback: ctx.feedback,
      };
      /** @type {Usage} */
      let total = { ...ZERO_USAGE };
      /** @type {AgentReply} */
      let last = { text: '', usage: { ...ZERO_USAGE } };
      for (let attempt = 0; attempt <= retries; attempt++) {
        last = await inner.act(attemptCtx);
        total = sumUsage(total, last.usage);
        const attempted = extractAction(
          last && typeof last.text === 'string' ? last.text : ''
        );
        if (attempted !== null && ctx.legalActions.includes(attempted)) {
          return {
            text: last.text,
            usage: total,
            meta: {
              assisted: {
                attempts: attempt + 1,
                retried: attempt > 0,
                invalidAttempts: attempt,
              },
              ...(last.meta !== undefined ? { inner: last.meta } : {}),
            },
          };
        }
        const reason =
          attempted === null
            ? 'no action was found in your reply'
            : `"${attempted}" is not a legal action in this position`;
        attemptCtx = {
          ...attemptCtx,
          feedback:
            `Your previous reply was rejected: ${reason}. Reply with exactly one ` +
            'action from the legal actions list above and end your reply with ' +
            '`ACTION: <action>`.',
        };
      }
      return {
        text: last.text,
        usage: total,
        meta: {
          assisted: {
            attempts: retries + 1,
            retried: retries > 0,
            exhausted: true,
            invalidAttempts: retries + 1,
          },
          ...(last.meta !== undefined ? { inner: last.meta } : {}),
        },
      };
    },
    // The runner disposes the actor it was seated — this wrapper, not the
    // inner agent. Forward it so an engine-backed inner agent's process is
    // shut down with the episode instead of leaking one engine per episode.
    dispose: async () => {
      await inner.dispose?.();
    },
    // Worst-case accounting the run engine can reserve against: the dollar
    // caps price a quoted agent's next call before it starts (runs/run.js),
    // and the wrapper hides up to `retries + 1` inner calls behind one
    // turn. A retry's request is NOT attempt 0's request: the inner agent
    // carries its previous reply across the turn's attempts, and the
    // official turn message embeds that reply in full (harness/official.js)
    // while the rejection feedback re-embeds the attempted action — itself
    // a substring of the reply. Model agents expose their effective output
    // cap (maxOutputTokens), which bounds the growth: under this quote's
    // own conversion (at most one token per two UTF-8 bytes) a capped reply
    // contributes at most 2 * cap bytes as the next previous-reply section,
    // so the pair (previous reply + feedback) grows the request by at most
    // 4 * cap + 256 bytes per retry. Price the largest (last) attempt's
    // padded request once and charge every attempt at that worst case —
    // the quote is monotone in bytes, so this bounds the whole turn. An
    // inner agent without a numeric maxOutputTokens (only model agents
    // carry the cap) falls back to attempt 0's price times the attempt
    // count: its growth is unbounded from outside. null without an inner
    // quote, mirroring the official agents.
    quoteWorstCaseUsd(/** @type {TurnContext} */ ctx) {
      if (typeof inner.quoteWorstCaseUsd !== 'function') return null;
      if (!Array.isArray(ctx.legalActions)) return inner.quoteWorstCaseUsd(ctx);
      const baseCtx = {
        ...ctx,
        legalActions: null,
        observation: { ...ctx.observation, text: buildObservationText(ctx) },
      };
      const cap = inner.maxOutputTokens;
      if (retries > 0 && typeof cap === 'number' && Number.isFinite(cap)) {
        // Price the largest (last) attempt's request once — the padded
        // observation bounds what every retry's request can have grown to —
        // and charge every attempt at that worst case.
        const lastQuote = inner.quoteWorstCaseUsd({
          ...baseCtx,
          observation: {
            ...baseCtx.observation,
            text: `${baseCtx.observation.text}${' '.repeat(retries * (4 * cap + 256))}`,
          },
        });
        if (lastQuote === null || !Number.isFinite(lastQuote)) return null;
        return lastQuote * (retries + 1);
      }
      const quoted = inner.quoteWorstCaseUsd(baseCtx);
      if (quoted === null || !Number.isFinite(quoted)) return null;
      if (retries === 0) return quoted;
      // No numeric cap: the growth is unbounded from outside — price every
      // attempt at attempt 0's request and accept the underestimate.
      return quoted * (retries + 1);
    },
  };
}
