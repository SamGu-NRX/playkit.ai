/**
 * The example-confound study's agent wrapper: changes only the example text
 * the model reads (in the rules, the observation or the feedback) and records
 * every applied change in the reply's `meta`.
 *
 * Design, fixed by PREREGISTRATION.md before any model run:
 *
 * - The runner's `TurnContext` carries the three surfaces an official-track
 *   model agent reads: `ctx.spec.rulesText` (repeated every turn by
 *   `buildOfficialTurnMessage`), `ctx.observation.text`, and `ctx.feedback`.
 *   The wrapper derives a patched copy of each surface it touches and hands
 *   the derived context to the inner agent — the runner's originals, the
 *   observation hash, the trajectory record and the referee's parsing are
 *   never altered, so every bundle still verifies with
 *   `gauntlet bundle verify`.
 * - Each replacement must occur exactly once per turn where its field is
 *   applicable. Zero occurrences throw an error naming the game and the
 *   missing string — a silent pass-through would quietly turn a corrected
 *   arm back into the confounded one. Feedback patches skip (without error)
 *   on turns where the referee has no feedback; on turns where feedback
 *   exists but does not carry the target string, they throw like the rest.
 * - Every applied change is recorded in `meta.examplePatch` on the same turn,
 *   so a trajectory carries its own provenance of what the model was shown.
 * - The wrapper is community track by construction: the prompt differs from
 *   the official one, so results self-report to the community table and the
 *   official leaderboard is untouched.
 * - Nesting: this wrapper sits OUTSIDE any community-track wrapper
 *   (e.g. `community/assisted-agent.js`), so the assisted augmentation is
 *   applied to already-patched text and the model's inner meta survives.
 *
 * Pure JS, no `node:*` imports.
 *
 * @module
 */

/** @import { Agent, AgentReply, TurnContext } from '../../core/types.js' */

/**
 * @typedef {object} ExamplePatchAgentOptions
 * @property {Agent} inner The wrapped agent. Receives derived turn contexts
 *   whose rules/observation/feedback carry the replacements; everything else
 *   (seat, turn, legalActions, observation data, spec identity) passes
 *   through unchanged.
 * @property {import('./patches.js').PatchSet} patchSet The preregistered
 *   replacement set to apply.
 * @property {string} [id] Agent id. Default
 *   `community-example-patch:<patchSet name>:<inner id>`.
 */

/**
 * Count non-overlapping occurrences of `needle` in `haystack`.
 *
 * @param {string} haystack
 * @param {string} needle
 * @returns {number}
 */
function countOccurrences(haystack, needle) {
  if (needle.length === 0) return 0;
  return haystack.split(needle).length - 1;
}

/**
 * Build the example-patching agent.
 *
 * @param {ExamplePatchAgentOptions} options
 * @returns {Agent}
 */
export function createExamplePatchAgent(options) {
  const { inner, patchSet } = options;
  if (!inner || typeof inner.act !== 'function') {
    throw new Error(
      'createExamplePatchAgent: options.inner must be an agent with an act(ctx) method'
    );
  }
  if (
    !patchSet ||
    typeof patchSet.name !== 'string' ||
    typeof patchSet.gameId !== 'string' ||
    !Array.isArray(patchSet.patches) ||
    patchSet.patches.length === 0
  ) {
    throw new Error(
      'createExamplePatchAgent: options.patchSet must be a preregistered patch set (name, gameId, patches)'
    );
  }
  const id =
    options.id ?? `community-example-patch:${patchSet.name}:${inner.id}`;

  /**
   * Apply one patch to its field's text. Returns the patched text, or null
   * when the field is not applicable this turn (feedback === null).
   *
   * @param {TurnContext} ctx
   * @param {import('./patches.js').ExamplePatch} patch
   * @returns {{ text: string | null, occurrences: number }}
   */
  function applyPatch(ctx, patch) {
    /** @type {string | null | undefined} */
    let source;
    if (patch.field === 'rules') source = ctx.spec?.rulesText;
    else if (patch.field === 'observation') source = ctx.observation?.text;
    else source = ctx.feedback;

    if (patch.field === 'feedback' && (source === null || source === undefined)) {
      // The referee has nothing to say this turn; there is no example to
      // patch and no error — the patch simply does not apply.
      return { text: null, occurrences: 0 };
    }
    if (typeof source !== 'string') {
      throw new Error(
        `example-patch agent "${id}": game "${patchSet.gameId}" has no ${patch.field} text to patch (got ${typeof source})`
      );
    }
    const occurrences = countOccurrences(source, patch.find);
    if (occurrences === 0) {
      throw new Error(
        `example-patch agent "${id}": target string not found in the ${patch.field} text of game "${patchSet.gameId}"` +
          (patchSet.tierId ? ` on tier "${patchSet.tierId}"` : '') +
          `: ${JSON.stringify(patch.find)} — refusing to pass the unpatched prompt through`
      );
    }
    if (occurrences > 1) {
      throw new Error(
        `example-patch agent "${id}": target string occurs ${occurrences} times in the ${patch.field} text of game "${patchSet.gameId}", expected exactly once: ${JSON.stringify(patch.find)}`
      );
    }
    return { text: source.replace(patch.find, patch.replaceWith), occurrences };
  }

  return {
    id,
    track: /** @type {'community'} */ ('community'),
    ...(inner.model !== undefined ? { model: inner.model } : {}),
    ...(inner.provider !== undefined ? { provider: inner.provider } : {}),
    ...(inner.dryRun !== undefined ? { dryRun: inner.dryRun } : {}),
    /**
     * @param {TurnContext} ctx
     * @returns {Promise<AgentReply>}
     */
    async act(ctx) {
      if (ctx.spec?.id !== patchSet.gameId) {
        throw new Error(
          `example-patch agent "${id}" is seated on game "${String(ctx.spec?.id)}", expected "${patchSet.gameId}" — patch sets are game-specific`
        );
      }
      if (patchSet.tierId !== null && patchSet.tierId !== undefined && ctx.tier?.id !== patchSet.tierId) {
        throw new Error(
          `example-patch agent "${id}" is seated on tier "${String(ctx.tier?.id)}", expected "${patchSet.tierId}" — the "${patchSet.name}" replacements are preregistered for that tier only`
        );
      }

      /** @type {TurnContext} */
      const derived = { ...ctx, spec: { ...ctx.spec }, observation: { ...ctx.observation } };
      /** @type {Array<{ field: string, find: string, replaceWith: string, occurrences: number }>} */
      const applied = [];
      for (const patch of patchSet.patches) {
        const result = applyPatch(ctx, patch);
        if (result.text === null) continue;
        if (patch.field === 'rules') derived.spec.rulesText = result.text;
        else if (patch.field === 'observation') derived.observation.text = result.text;
        else derived.feedback = result.text;
        applied.push({
          field: patch.field,
          find: patch.find,
          replaceWith: patch.replaceWith,
          occurrences: result.occurrences,
        });
      }

      const reply = await inner.act(derived);
      return {
        text: reply.text,
        ...(reply.usage !== undefined ? { usage: reply.usage } : {}),
        meta: {
          examplePatch: { patchSet: patchSet.name, applied },
          ...(reply.meta !== undefined ? reply.meta : {}),
        },
      };
    },
  };
}
