/**
 * The official track: the one fixed system prompt and the one user message
 * every official-track agent gets, identical for every model and every game
 * (design doc, section 6; ARC-AGI-3 technical report section 4.3.1).
 *
 * Context stays bounded on long games because nothing else carries over: the
 * message rebuilds each turn from the rules text, the previous reply in full,
 * any invalid-action feedback, and the current observation. Pure JS, no
 * `node:*` imports — the overlay can reuse this in the browser.
 *
 * @module
 */

/** @import { TurnContext } from '../core/types.js' */

/**
 * The official system prompt, verbatim from the ARC-AGI-3 technical report
 * (section 4.3.1, https://arcprize.org/media/ARC_AGI_3_Technical_Report.pdf).
 * Do not edit: a prompt change is a manifest-version bump that separates old
 * entries from new ones.
 *
 * @type {string}
 */
export const OFFICIAL_SYSTEM_PROMPT =
  'You are playing a game. Your goal is to win. Reply with the exact action ' +
  'you want to take. The final action in your reply will be executed next ' +
  'turn. Your entire reply will be carried to the next turn.';

/**
 * The reply an agent sees as "your previous reply" when it has none yet.
 * @type {string}
 */
export const NO_PREVIOUS_REPLY = '(none)';

/**
 * Build the single user message for one turn on the official track, in the
 * fixed order: rules text; previous reply in full (or "(none)"); invalid
 * action feedback when there is any; then the current observation.
 *
 * Sections are separated by blank lines. The feedback line is prefixed so the
 * model can tell the judge's message apart from its own reply — that prefix is
 * harness wording, not part of the feedback itself.
 *
 * @param {TurnContext} ctx The turn context as the runner delivers it
 *   (`legalActions` is null on the official track and is not used here).
 * @param {string | null | undefined} previousReply The agent's full previous
 *   reply text, or null/undefined on the first turn.
 * @returns {string}
 */
export function buildOfficialTurnMessage(ctx, previousReply) {
  if (!ctx || !ctx.spec || typeof ctx.spec.rulesText !== 'string') {
    throw new Error('buildOfficialTurnMessage: ctx.spec.rulesText is required');
  }
  if (!ctx.observation || typeof ctx.observation.text !== 'string') {
    throw new Error('buildOfficialTurnMessage: ctx.observation.text is required');
  }
  const sections = [ctx.spec.rulesText];
  const previous =
    typeof previousReply === 'string' && previousReply.trim().length > 0
      ? previousReply
      : NO_PREVIOUS_REPLY;
  sections.push(`Your previous reply:\n${previous}`);
  if (typeof ctx.feedback === 'string' && ctx.feedback.length > 0) {
    sections.push(`Feedback on your previous reply: ${ctx.feedback}`);
  }
  sections.push(`Current state:\n${ctx.observation.text}`);
  return sections.join('\n\n');
}
