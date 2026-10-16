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
 * When the caller supplies a fitted rating ladder (`ratingLadder`), every
 * entry also carries a display-only chess rating — `rateAgent` over the
 * entry's trajectories on ladder-known rungs. It renders as a Markdown
 * column and a per-entry `rating` field and is never read by the ranking
 * math; entries with no ladder-known trajectories have no rating.
 *
 * @module
 */

import { score, GauntletRefusalError } from './score.js';

import { DEFAULT_PROFILE } from './profiles.js';
import { rateAgent, selectLadderKnown } from '../rating/elo.js';

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
 * @property {import('../rating/elo.js').AgentRating} [rating] Display-only
 *   chess rating, present only when the caller supplied a rating ladder and
 *   the entry has trajectories on ladder-known rungs. Never affects rank.
 * @property {{ profile: string, baselineSha256?: string }} [scoring] Present
 *   only when the entry was scored under a non-default or explicitly
 *   selected scoring profile.
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
 * @property {{ profile: string, baselineSha256?: string }} [scoring] Present
 *   only when a scoring profile was explicitly selected or is non-default.
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
 * The display-only chess rating cell: `rating [low, high]`, the divergence
 * direction for an agent with no finite rating, `—` when the entry was not
 * rated (no ladder supplied, or no ladder-known trajectories).
 *
 * @param {import('../rating/elo.js').AgentRating | undefined} rating
 * @returns {string}
 */
function fmtRatingCell(rating) {
  if (!rating) return '—';
  if (rating.rating === null) {
    return rating.direction === null ? '—' : `— (${rating.direction})`;
  }
  const low = rating.low === null ? 'unbounded' : fmt(rating.low, 1);
  const high = rating.high === null ? 'unbounded' : fmt(rating.high, 1);
  return `${fmt(rating.rating, 1)} [${low}, ${high}]`;
}

/**
 * Render the Markdown for one track.
 *
 * @param {string} track
 * @param {LeaderboardEntry[]} entries
 * @param {boolean} withRatings Render the chess rating column — present only
 *   when the builder was given a rating ladder.
 * @returns {string}
 */
function trackMarkdown(track, entries, withRatings) {
  const lines = [`## ${track[0].toUpperCase()}${track.slice(1)} track`, ''];
  if (entries.length === 0) {
    lines.push('_No entries._', '');
    return lines.join('\n');
  }

  lines.push(
    withRatings
      ? '| Rank | Agent | Benchmark score (95% CI) | Cost (USD) | Cost/episode (USD) | Invalid actions | Mean agent actions | Chess rating (95% CI) |'
      : '| Rank | Agent | Benchmark score (95% CI) | Cost (USD) | Cost/episode (USD) | Invalid actions | Mean agent actions |',
    withRatings
      ? '|---:|---|---:|---:|---:|---:|---:|---:|'
      : '|---:|---|---:|---:|---:|---:|---:|'
  );
  for (const entry of entries) {
    /** @type {string[]} */
    const cells = [
      `${entry.rank ?? '—'}`,
      agentLabel(entry.agent),
      fmtScoreCI(entry.benchmarkScore),
      fmt(entry.costUsd),
      fmt(entry.costPerEpisodeUsd),
      `${(entry.invalidActionRate * 100).toFixed(1)}%`,
      fmt(entry.meanAgentActions, 1),
    ];
    if (withRatings) cells.push(fmtRatingCell(entry.rating));
    lines.push(`| ${cells.join(' | ')} |`);
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
 * @typedef {object} LeaderboardOptions
 * @property {string} [profile] Default scoring profile for entries that do
 *   not name one. Defaults to `rhae-v1`. When the effective profile is
 *   non-default (or explicitly selected), the leaderboard JSON carries a
 *   `scoring` block with the profile id and, when used, the baseline file's
 *   SHA-256.
 * @property {import('./profiles.js').ScoringBaseline} [baseline] Default
 *   parsed scoring baseline for entries that do not carry one (required by
 *   `chance-adjusted`).
 * @property {string} [baselineSha256] SHA-256 hex of the baseline file.
 * @property {import('../rating/elo.js').RatingLadder} [ratingLadder] Fitted
 *   chess ladder for the display-only rating column. When absent the column
 *   is omitted entirely.
 */

/**
 * Build the leaderboard.
 *
 * @param {SuiteManifest} suite
 * @param {ScoreEntry[]} entries One per submitting agent.
 * @param {Game<*>[] | Map<string, Game<*>> | Record<string, Game<*>>} games
 *   Implementations for every suite game.
 * @param {LeaderboardOptions} [options]
 * @returns {Promise<{ leaderboard: Leaderboard, markdown: string }>}
 */
export async function leaderboard(suite, entries, games, options = {}) {
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
      profile: entry.profile ?? options.profile,
      baseline: entry.baseline ?? options.baseline,
      baselineSha256: entry.baselineSha256 ?? options.baselineSha256,
    });
    /** @type {LeaderboardEntry} */
    const scoredEntry = /** @type {*} */ (result);
    // Display-only chess rating: computed from the entry's trajectories on
    // ladder-known rungs, never read by the ranking math below.
    if (options.ratingLadder) {
      const { known } = selectLadderKnown(entry.trajectories, options.ratingLadder);
      if (known.length > 0) scoredEntry.rating = rateAgent(known, options.ratingLadder);
    }
    scored.push(scoredEntry);
  }

  // One leaderboard, one profile. Entries scored under different profiles
  // are on different scales (rhae-v1 floors the random baseline at ~0.11,
  // chance-adjusted pins it at 0), so ranking them together would compare
  // numbers that do not mean the same thing.
  const boardProfile = scored.find((e) => e.scoring)?.scoring?.profile ?? DEFAULT_PROFILE;
  for (const entry of scored) {
    const entryProfile = entry.scoring?.profile ?? DEFAULT_PROFILE;
    if (entryProfile !== boardProfile) {
      throw new GauntletRefusalError(
        'leaderboard.js',
        'profile-mismatch',
        `cannot rank entry "${entry.agent.id}" scored under profile "${entryProfile}" together with entries under profile "${boardProfile}"; profile scores are on different scales — build one leaderboard per profile`
      );
    }
  }

  // One board, one baseline. chance-adjusted scores depend on the baseline
  // file's random-mean vector (it sets the denominator and clamp per tier),
  // so two entries scored against different baseline files are on different
  // scales even under the same profile name — exactly what the profile check
  // above exists to prevent. Only entries whose result names a baseline
  // participate: chance-adjusted always carries a scoring block, while the
  // baseline-reading-free profiles (rhae-v1, squared-outcome) never read one,
  // so a differing sha there is provenance noise, not a scale difference.
  if (boardProfile === 'chance-adjusted') {
    /** @type {string | undefined} */
    let boardBaselineSha256;
    /** @type {string | undefined} */
    let boardBaselineEntryId;
    for (const entry of scored) {
      const sha = entry.scoring?.baselineSha256;
      if (sha === undefined) continue;
      if (boardBaselineSha256 === undefined) {
        boardBaselineSha256 = sha;
        boardBaselineEntryId = entry.agent.id;
        continue;
      }
      if (boardBaselineSha256 !== sha) {
        throw new GauntletRefusalError(
          'leaderboard.js',
          'baseline-mismatch',
          `cannot rank entry "${entry.agent.id}" scored against baseline ${sha.slice(0, 12)} together with entry "${boardBaselineEntryId}" scored against baseline ${boardBaselineSha256.slice(0, 12)}; chance-adjusted scores depend on the baseline's random-mean vector — build one leaderboard per baseline file`
        );
      }
    }
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
  // The profile block appears only when a profile was explicitly selected or
  // is non-default, so the default leaderboard JSON stays byte-identical.
  if (options.profile !== undefined || boardProfile !== DEFAULT_PROFILE) {
    /** @type {{ profile: string, baselineSha256?: string }} */
    const scoring = { profile: boardProfile };
    // Provenance names the baseline the entries were actually scored against:
    // the entries' consensus when they carry their own baselines, falling
    // back to the board-level option.
    const sha = scored.find((e) => e.scoring?.baselineSha256)?.scoring?.baselineSha256 ?? options.baselineSha256;
    if (typeof sha === 'string') scoring.baselineSha256 = sha;
    board.scoring = scoring;
  }

  const markdownLines = [
    '# PlayKit Gauntlet leaderboard',
    '',
    `- Suite: \`${board.suite.id}\` (split \`${board.suite.split}\`, salt commitment: ${board.suite.saltCommitment ? `\`${board.suite.saltCommitment}\`` : 'none'})`,
    `- Generated: ${board.generatedAt}`,
    '',
  ];
  const withRatings = options.ratingLadder !== undefined;
  for (const track of TRACKS) {
    markdownLines.push(trackMarkdown(track, tracks[track], withRatings));
  }

  return { leaderboard: board, markdown: markdownLines.join('\n') };
}
