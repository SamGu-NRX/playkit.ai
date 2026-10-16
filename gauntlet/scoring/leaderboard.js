/**
 * The Gauntlet leaderboard, format `playkit-gauntlet-leaderboard/1`: score
 * every entry against the same suite, rank them within their track, and
 * render Markdown with one table per track (official, community, baseline)
 * plus a score-versus-cost data series in the style of the ARC Prize
 * leaderboard. No chart or page is rendered here — the JSON `scoreVsCost`
 * series and the Markdown tables are the data a leaderboard UI would plot as
 * a score-vs-cost scatter (x: cost per episode, log scale; y: benchmark score
 * with its 95% interval as an error bar, one point per ranked entry, colored
 * by track, unranked entries grayed out and excluded from the axes).
 *
 * Entries that cannot be scored honestly are refused by `score` and the
 * refusal propagates from here.
 *
 * @module
 */

import { score } from './score.js';

/** @import { Game } from '../core/types.js' */
/** @import { SuiteManifest } from './suite.js' */
/** @import { EntryScore, ScoreEntry, ScoreWithCI } from './score.js' */

export const LEADERBOARD_FORMAT = 'playkit-gauntlet-leaderboard/1';

/** The three tracks, in leaderboard order. */
const TRACKS = ['official', 'community', 'baseline'];

/**
 * A ranked entry as it appears in the leaderboard.
 *
 * @typedef {object} LeaderboardEntry
 * @property {{ id: string, track: string, model?: string, provider?: string }} agent
 * @property {number | null} rank Null for unranked entries.
 * @property {boolean} ranked
 * @property {string | null} unrankedReason
 * @property {ScoreWithCI | null} benchmarkScore
 * @property {number | 'unknown'} costUsd
 * @property {number | 'unknown'} costPerEpisodeUsd
 * @property {number} episodes
 * @property {number} invalidActionRate
 * @property {number} meanAgentActions
 * @property {Record<string, import('./score.js').GameScore>} games
 */

/**
 * One point of the score-versus-cost series.
 *
 * @typedef {object} ScoreVsCostPoint
 * @property {string} agent
 * @property {string} track
 * @property {number | null} rank
 * @property {boolean} ranked
 * @property {ScoreWithCI | null} benchmarkScore
 * @property {number | 'unknown'} costUsd
 * @property {number | 'unknown'} costPerEpisodeUsd
 */

/**
 * @typedef {object} Leaderboard
 * @property {'playkit-gauntlet-leaderboard/1'} format
 * @property {string} generatedAt
 * @property {{ id: string, split: string, saltCommitment: string | null }} suite
 * @property {Record<string, LeaderboardEntry[]>} tracks One array per track.
 * @property {Record<string, ScoreVsCostPoint[]>} scoreVsCost One series per
 *   track, like the ARC Prize leaderboard's score-vs-cost plot data.
 */

/**
 * Format a number for Markdown tables.
 *
 * @param {number | null | 'unknown'} v
 * @param {number} digits
 * @returns {string}
 */
function fmt(v, digits = 4) {
  if (v === null || v === undefined) return '—';
  if (v === 'unknown') return 'unknown';
  return typeof v === 'number' ? v.toFixed(digits) : String(v);
}

/**
 * @param {ScoreWithCI | null} scored
 * @returns {string}
 */
function fmtScoreCI(scored) {
  if (!scored || scored.value === null || !scored.ci95) return '—';
  return `${fmt(scored.value)} [${fmt(scored.ci95[0])}, ${fmt(scored.ci95[1])}]`;
}

/**
 * @param {{ id: string, track: string, model?: string, provider?: string }} agent
 * @returns {string}
 */
function agentLabel(agent) {
  const detail = [agent.model, agent.provider].filter(Boolean).join(' @ ');
  return detail ? `${agent.id} (${detail})` : agent.id;
}

/**
 * Render the Markdown for one track.
 *
 * @param {string} track
 * @param {LeaderboardEntry[]} entries
 * @returns {string}
 */
function trackMarkdown(track, entries) {
  const lines = [`## ${track[0].toUpperCase()}${track.slice(1)} track`, ''];
  if (entries.length === 0) {
    lines.push('_No entries._', '');
    return lines.join('\n');
  }

  lines.push(
    '| Rank | Agent | Benchmark score (95% CI) | Cost (USD) | Cost/episode (USD) | Invalid actions | Mean agent actions |',
    '|---:|---|---:|---:|---:|---:|---:|'
  );
  for (const entry of entries) {
    lines.push(
      `| ${entry.rank ?? '—'} | ${agentLabel(entry.agent)} | ${fmtScoreCI(entry.benchmarkScore)} | ${fmt(entry.costUsd)} | ${fmt(entry.costPerEpisodeUsd)} | ${(entry.invalidActionRate * 100).toFixed(1)}% | ${fmt(entry.meanAgentActions, 1)} |`
    );
  }
  lines.push('');

  const unranked = entries.filter((e) => !e.ranked);
  if (unranked.length > 0) {
    lines.push(`### Unranked — ${track} track`, '', '| Agent | Reason |', '|---|---|');
    for (const entry of unranked) {
      lines.push(`| ${agentLabel(entry.agent)} | ${entry.unrankedReason ?? 'unranked'} |`);
    }
    lines.push('');
  }

  const withScores = entries.filter((e) => e.benchmarkScore && e.benchmarkScore.value !== null);
  if (withScores.length > 0) {
    lines.push(
      `### Score versus cost — ${track} track`,
      '',
      '| Agent | Rank | Benchmark score | Cost (USD) | Cost/episode (USD) |',
      '|---|---:|---:|---:|---:|'
    );
    for (const entry of withScores) {
      lines.push(
        `| ${agentLabel(entry.agent)} | ${entry.rank ?? '—'} | ${fmt(entry.benchmarkScore?.value ?? null)} | ${fmt(entry.costUsd)} | ${fmt(entry.costPerEpisodeUsd)} |`
      );
    }
    lines.push('');
  }
  return lines.join('\n');
}

/**
 * Build the leaderboard.
 *
 * @param {SuiteManifest} suite
 * @param {ScoreEntry[]} entries One per submitting agent.
 * @param {Game<*>[] | Map<string, Game<*>> | Record<string, Game<*>>} games
 *   Implementations for every suite game.
 * @returns {Promise<{ leaderboard: Leaderboard, markdown: string }>}
 */
export async function leaderboard(suite, entries, games) {
  if (!Array.isArray(entries)) {
    throw new Error('[gauntlet/scoring/leaderboard.js] entries: entries must be an array');
  }

  /** @type {LeaderboardEntry[]} */
  const scored = [];
  for (const entry of entries) {
    if (!entry || !entry.agent || !Array.isArray(entry.trajectories)) {
      throw new Error(
        '[gauntlet/scoring/leaderboard.js] entry-shape: every entry needs { agent, trajectories }'
      );
    }
    const track = entry.agent.track;
    if (!TRACKS.includes(track)) {
      throw new Error(
        `[gauntlet/scoring/leaderboard.js] track: agent "${entry.agent.id}" has track ${JSON.stringify(track)}; expected one of ${TRACKS.join(', ')}`
      );
    }
    const result = await score(suite, entry.trajectories, games, {
      agent: entry.agent,
      saltCommitment: entry.saltCommitment,
    });
    scored.push(/** @type {LeaderboardEntry} */ (/** @type {*} */ (result)));
  }

  /** @type {Record<string, LeaderboardEntry[]>} */
  const tracks = { official: [], community: [], baseline: [] };
  for (const track of TRACKS) {
    tracks[track] = scored
      .filter((e) => e.agent.track === track)
      .sort((a, b) => {
        const av = a.ranked ? (a.benchmarkScore?.value ?? -Infinity) : -Infinity;
        const bv = b.ranked ? (b.benchmarkScore?.value ?? -Infinity) : -Infinity;
        if (av !== bv) return bv - av;
        return a.agent.id < b.agent.id ? -1 : a.agent.id > b.agent.id ? 1 : 0;
      })
      .map((e, i) => ({ ...e, rank: e.ranked ? i + 1 : null }));
  }

  /** @type {Record<string, ScoreVsCostPoint[]>} */
  const scoreVsCost = { official: [], community: [], baseline: [] };
  for (const track of TRACKS) {
    scoreVsCost[track] = tracks[track]
      .filter((e) => e.ranked && e.benchmarkScore && e.benchmarkScore.value !== null)
      .map((e) => ({
        agent: e.agent.id,
        track,
        rank: e.rank,
        ranked: e.ranked,
        benchmarkScore: e.benchmarkScore,
        costUsd: e.costUsd,
        costPerEpisodeUsd: e.costPerEpisodeUsd,
      }));
  }

  /** @type {Leaderboard} */
  const board = {
    format: LEADERBOARD_FORMAT,
    generatedAt: new Date().toISOString(),
    suite: {
      id: suite.id,
      split: suite.split,
      saltCommitment: suite.saltCommitment,
    },
    tracks,
    scoreVsCost,
  };

  const markdownLines = [
    '# PlayKit Gauntlet leaderboard',
    '',
    `- Suite: \`${board.suite.id}\` (split \`${board.suite.split}\`, salt commitment: ${board.suite.saltCommitment ? `\`${board.suite.saltCommitment}\`` : 'none'})`,
    `- Generated: ${board.generatedAt}`,
    '',
  ];
  for (const track of TRACKS) {
    markdownLines.push(trackMarkdown(track, tracks[track]));
  }

  return { leaderboard: board, markdown: markdownLines.join('\n') };
}
