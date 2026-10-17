/**
 * The no-skill strategies for the tier audit.
 *
 * - `copy-example` plays the action the game's rules text documents as an
 *   example (`e.g. "…"` token) whenever that exact text is in the turn's
 *   legal actions, otherwise the first legal action. Legality is judged
 *   against `ctx.legalActions` — the canonical list the baseline track sees;
 *   a token documented only as an alternate grammar form falls back, and the
 *   episode record says so.
 * - `first-legal` plays the first legal action, every turn.
 *
 * Both are pure per-turn functions of the turn context: no state, no RNG, no
 * `node:*`. Their replies are judged by the same referee as any agent's.
 *
 * Sliding's only example documents an INVALID action ("for example `down`
 * when the blank is already in the top row"), so its extractor records
 * `none` by construction — the generic `e.g.` scan finds no quoted token.
 *
 * @module
 */

/** @import { Agent, TurnContext } from '../../core/types.js' */

/**
 * The example-action token a game's rules text documents, if any.
 *
 * @param {string | undefined} rulesText
 * @returns {{ token: string, source: 'rules' } | null}
 */
export function extractExampleToken(rulesText) {
  const match = String(rulesText ?? '').match(/e\.g\.\s*["'`]([^"'`]+)["'`]/);

  if (!match) return null;
  return { token: match[1], source: /** @type {'rules'} */ ('rules') };
}

/**
 * Build the copy-the-example agent for one cell.
 *
 * @param {{ token: string | null, source: 'rules' | 'observation' | 'none' }} example
 * @returns {Agent}
 */
export function createCopyExampleAgent(example) {
  return {
    id: 'copy-example',
    track: /** @type {'baseline'} */ ('baseline'),
    /**
     * @param {TurnContext} ctx
     * @returns {Promise<{ text: string, meta?: * }>}
     */
    async act(ctx) {
      const legal = ctx.legalActions ?? [];
      if (example.token !== null && legal.includes(example.token)) {
        return {
          text: example.token,
          meta: { copyExample: { source: example.source, token: example.token, played: true } },
        };
      }
      return {
        text: legal[0] ?? '',
        meta: {
          copyExample: {
            source: example.token === null ? 'none' : `${example.source}-not-canonical`,
            token: example.token,
            played: false,
            fallback: 'first-legal',
          },
        },
      };
    },
  };
}

/**
 * Build the constant-first-legal agent.
 *
 * @returns {Agent}
 */
export function createFirstLegalAgent() {
  return {
    id: 'first-legal',
    track: /** @type {'baseline'} */ ('baseline'),
    /**
     * @param {TurnContext} ctx
     * @returns {Promise<{ text: string }>}
     */
    async act(ctx) {
      const legal = ctx.legalActions ?? [];
      return { text: legal[0] ?? '' };
    },
  };
}
