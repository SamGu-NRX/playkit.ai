#!/usr/bin/env node
/**
 * Standalone replay viewer: show a recorded Gauntlet episode turn by turn in
 * the terminal — the observation the agent saw, its reply as recorded, how the
 * referee parsed it (valid action, or the invalid-action error the agent then
 * received as feedback), and the outcome at the end.
 *
 *   node replay/cli.js <trajectory.json> [--step N] [--format text|json]
 *                      [--max-reply-chars K]
 *
 *   --step N             Show only step N (0-based, one frame).
 *   --format text        Human-readable episode (default).
 *   --format json        Print the frames payload (`playkit-gauntlet-replay-frames/1`)
 *                        for the UI pass; --step N filters its frames array.
 *   --max-reply-chars K  Truncate displayed replies to K characters (text
 *                        format only; JSON always carries the full reply).
 *                        Default: no truncation.
 *
 * The trajectory is replay-verified first; a trajectory that does not verify
 * is refused with the failing step named on stderr and exit code 1.
 *
 * Node-only (reads files): the frames *payload* stays browser-safe.
 *
 * @module
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { buildFrames, ReplayRefusedError } from './frames.js';
import { CompareRefusedError, compareBundles, compareTrajectories } from './compare.js';
import { getGame } from '../games/index.js';

/** @typedef {import('./frames.js').ReplayFrame} ReplayFrame */
/** @typedef {import('./frames.js').ReplayFrames} ReplayFrames */

const USAGE = `usage:
  node replay/cli.js <trajectory.json> [--step N] [--format text|json] [--max-reply-chars K]
  node replay/cli.js <a.json> --against <b.json> [--format text|json]
  node replay/cli.js --bundles <dirA> <dirB> [--format text|json]

  --step N             show only step N (0-based) — single-trajectory mode only
  --format text|json   text: readable report (default); json: machine payload
                       (frames: playkit-gauntlet-replay-frames/1;
                       compare: playkit-gauntlet-replay-compare/1)
  --max-reply-chars K  truncate displayed replies to K chars (text only)
  --against <b.json>   compare two trajectories of the same episode turn by turn
  --bundles <a> <b>    compare two run directories episode by episode
`;

/**
 * @param {string} message
 * @returns {never}
 */
function usageError(message) {
  process.stderr.write(`replay: ${message}\n${USAGE}`);
  process.exit(2);
}

/**
 * @param {string[]} argv
 * @returns {{ file: string, step: number | null, format: 'text' | 'json', maxReplyChars: number | null, against: string | null, bundles: [string, string] | null }}
 */
function parseArgs(argv) {
  /** @type {{ file: string, step: number | null, format: 'text' | 'json', maxReplyChars: number | null, against: string | null, bundles: [string, string] | null }} */
  const args = { file: '', step: null, format: 'text', maxReplyChars: null, against: null, bundles: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    /** @param {string} name @returns {string} */
    const value = (name) => {
      i++;
      if (i >= argv.length) usageError(`--${name} needs a value`);
      return argv[i];
    };
    if (arg === '--step') {
      const raw = value('step');
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 0) usageError(`--step must be a non-negative integer, got ${JSON.stringify(raw)}`);
      if (args.against !== null || args.bundles !== null) {
        usageError('--step only works in single-trajectory mode');
      }
      args.step = n;
    } else if (arg === '--format') {
      const raw = value('format');
      if (raw !== 'text' && raw !== 'json') {
        usageError(`--format must be "text" or "json", got ${JSON.stringify(raw)}`);
      }
      args.format = raw;
    } else if (arg === '--max-reply-chars') {
      const raw = value('max-reply-chars');
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 1) usageError(`--max-reply-chars must be a positive integer, got ${JSON.stringify(raw)}`);
      if (args.against !== null || args.bundles !== null) {
        usageError('--max-reply-chars only works in single-trajectory mode');
      }
      args.maxReplyChars = n;
    } else if (arg === '--against') {
      if (args.bundles !== null) usageError('--against cannot be combined with --bundles');
      if (args.against !== null) usageError('--against given twice');
      args.against = value('against');
    } else if (arg === '--bundles') {
      if (args.against !== null) usageError('--bundles cannot be combined with --against');
      if (args.file !== '') usageError('--bundles takes two run directories and no trajectory file');
      if (args.bundles !== null) usageError('--bundles given twice');
      const dirA = value('bundles');
      const dirB = value('bundles');
      args.bundles = [dirA, dirB];
    } else if (arg === '--help' || arg === '-h') {
      process.stdout.write(USAGE);
      process.exit(0);
    } else if (arg.startsWith('--')) {
      usageError(`unknown option ${arg}`);
    } else if (args.bundles !== null) {
      usageError(`--bundles takes two run directories; unexpected extra argument ${JSON.stringify(arg)}`);
    } else if (args.file === '') {
      args.file = arg;
    } else {
      usageError(`unexpected extra argument ${JSON.stringify(arg)} — to compare two files use --against`);
    }
  }
  if (args.file === '' && args.bundles === null) usageError('a trajectory file is required');
  return args;
}

/**
 * @param {string} raw
 * @returns {import('../core/types.js').Trajectory}
 */
function readTrajectory(raw) {
  const parsed = /** @type {*} */ (JSON.parse(raw));
  if (!parsed || !parsed.game || typeof parsed.game.id !== 'string') {
    throw new Error('not a gauntlet trajectory: missing game.id');
  }
  return parsed;
}

/**
 * Indent every line of a multi-line block for terminal display.
 *
 * @param {string} text
 * @param {string} pad
 * @returns {string}
 */
function indent(text, pad) {
  return String(text)
    .split('\n')
    .map((line) => pad + line)
    .join('\n');
}

/**
 * @param {number} ms
 * @returns {string}
 */
function formatDuration(ms) {
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
}

/**
 * @param {string} startedAt
 * @param {string} finishedAt
 * @returns {string}
 */
function wallTime(startedAt, finishedAt) {
  const start = Date.parse(startedAt);
  const end = Date.parse(finishedAt);
  if (Number.isNaN(start) || Number.isNaN(end)) return 'unknown wall time';
  return formatDuration(Math.max(0, end - start));
}

/**
 * @param {ReplayFrames} payload
 * @returns {string}
 */
function renderHeader(payload) {
  const agent = payload.agent;
  const agentParts = [agent.track, `seat ${agent.seat}`];
  if (agent.model) agentParts.push(`model ${agent.model}`);
  const opponents = payload.opponents.length
    ? payload.opponents.map((o) => `seat ${o.seat} — ${o.id}`).join(', ')
    : 'none (solitaire)';
  const endOutcome = payload.end.outcome;
  const agentScore =
    endOutcome && Array.isArray(endOutcome.normalized)
      ? endOutcome.normalized[payload.agentSeat]
      : undefined;
  const lines = [
    'PlayKit Gauntlet episode replay',
    `game:    ${payload.game.id} v${payload.game.version} · tier ${payload.tier} · seed ${payload.seed} · split ${payload.split}`,
    `agent:   ${agent.id} (${agentParts.join(', ')})`,
    `opponent: ${opponents}`,
    `end:     ${payload.end.reason} — ${payload.end.agentActions} agent attempt(s), ${payload.end.invalidActions} invalid` +
      (typeof agentScore === 'number' ? ` · agent score ${agentScore.toFixed(3)}` : '') +
      ` · wall ${wallTime(payload.startedAt, payload.finishedAt)}`,
    `steps:   ${payload.frames.length} · replay-verified ok`,
  ];
  if (endOutcome && endOutcome.reason) lines.push(`outcome: ${endOutcome.reason}`);
  return lines.join('\n');
}

/**
 * @param {ReplayFrame} frame
 * @param {number | null} maxReplyChars
 * @returns {string}
 */
function renderFrame(frame, maxReplyChars) {
  const who = frame.by === 'agent' ? 'agent' : `opponent (${frame.actorId})`;
  const head = `turn ${frame.turn + 1} · step ${frame.index} · seat ${frame.seat} (${who}) · ${formatDuration(frame.ms)}`;
  /** @type {string[]} */
  const lines = [head];

  if (frame.feedback !== null) {
    lines.push('feedback seen (for the previous invalid attempt):');
    lines.push(indent(frame.feedback, '    '));
  }

  lines.push('observation:');
  lines.push(indent(frame.observation.text, '    '));

  let replyText = frame.reply.text;
  if (maxReplyChars !== null && replyText.length > maxReplyChars) {
    const hidden = replyText.length - maxReplyChars;
    replyText =
      replyText.slice(0, maxReplyChars) +
      ` … [+${hidden} chars cut — full text in --format json, or raise --max-reply-chars]`;
  }
  lines.push('reply:');
  lines.push(indent(replyText === '' ? '(empty reply)' : replyText, '    '));

  if (!frame.parse.invalid) {
    lines.push(
      frame.parse.canonical === frame.parse.attempted
        ? `referee: valid — action ${JSON.stringify(frame.parse.canonical)}`
        : `referee: valid — ${JSON.stringify(frame.parse.attempted)} parses to ${JSON.stringify(frame.parse.canonical)}`
    );
    lines.push(`applied: ${JSON.stringify(frame.action)}`);
  } else {
    lines.push(`referee: INVALID — ${frame.parse.reason ?? 'unparseable action'}`);
    lines.push(
      `applied: nothing (invalid attempt recorded as ${JSON.stringify(frame.action)})`
    );
  }

  /** @type {string[]} */
  const tail = [];
  if (frame.score) {
    const delta = frame.score.delta === null ? '' : ` (${frame.score.delta >= 0 ? '+' : ''}${frame.score.delta.toFixed(3)})`;
    const kind = frame.score.kind === 'outcome' ? 'final' : 'running';
    tail.push(`score ${frame.score.value.toFixed(3)} ${kind}${delta}`);
  }
  if (frame.usage) {
    const inTok = frame.usage.inputTokens === null ? '?' : frame.usage.inputTokens;
    const outTok = frame.usage.outputTokens === null ? '?' : frame.usage.outputTokens;
    tail.push(`tokens in ${inTok} out ${outTok}`);
    if (typeof frame.usage.costUsd === 'number') tail.push(`$${frame.usage.costUsd.toFixed(6)}`);
  }
  if (tail.length) lines.push(`bookkeeping: ${tail.join(' · ')}`);
  return lines.join('\n');
}

/**
 * @param {ReplayFrames} payload
 * @param {number | null} maxReplyChars
 * @returns {string}
 */
function renderText(payload, maxReplyChars) {
  const shown = payload.frames
    .map((frame) => renderFrame(frame, maxReplyChars))
    .join('\n\n');
  return `${renderHeader(payload)}\n\n${shown}\n`;
}

/**
 * Recursively collect *.json files under a run directory, sorted.
 *
 * @param {string} root
 * @returns {string[]}
 */
function collectJsonFiles(root) {
  /** @type {string[]} */
  const files = [];
  /** @param {string} dir */
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (name.endsWith('.json')) files.push(path);
    }
  };
  walk(root);
  return files;
}

/**
 * Load every trajectory JSON in a run directory, keyed by the episode identity
 * the contents record (`<game>/<tier>/<split>/<seed>`) — directory layout is
 * incidental. Files that are not trajectory JSON (run.json, suite.json) are
 * reported as ignored rather than fatal.
 *
 * @param {string} root
 * @returns {{ entries: Map<string, import('./compare.js').TrajectoryEntry & { rel: string }>, ignored: string[] }}
 */
function loadBundle(root) {
  const entries = /** @type {Map<string, import('./compare.js').TrajectoryEntry & { rel: string }>} */ (new Map());
  /** @type {string[]} */
  const ignored = [];
  for (const path of collectJsonFiles(root)) {
    const rel = relative(root, path);
    /** @type {*} */
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      ignored.push(rel);
      continue;
    }
    const isTrajectory =
      parsed &&
      parsed.format === 'playkit-gauntlet-trajectory/1' &&
      parsed.game &&
      typeof parsed.game.id === 'string' &&
      typeof parsed.tier === 'string' &&
      typeof parsed.seed === 'string' &&
      Array.isArray(parsed.steps);
    if (!isTrajectory) {
      ignored.push(rel);
      continue;
    }
    const key = `${parsed.game.id}/${parsed.tier}/${parsed.split}/${parsed.seed}`;
    if (entries.has(key)) {
      throw new Error(`duplicate episode ${key} in ${root}: ${entries.get(key)?.rel} and ${rel}`);
    }
    entries.set(key, { trajectory: parsed, path, rel });
  }
  return { entries, ignored };
}

/**
 * @param {number | null} value
 * @returns {string}
 */
function formatUsd(value) {
  if (value === null) return 'unknown';
  const cents = value.toFixed(value !== 0 && Math.abs(value) < 0.01 ? 5 : 4);
  return '$' + cents;
}

/**
 * @param {number | null} value
 * @returns {string}
 */
function formatP(value) {
  return value === null ? '—' : value.toFixed(4);
}

/**
 * @param {import('./compare.js').EpisodeCompare} payload
 * @returns {string}
 */
function renderEpisodeCompareText(payload) {
  const A = payload.a;
  const B = payload.b;
  const lines = [
    'PlayKit Gauntlet replay compare',
    `game:  ${payload.game.id} v${payload.game.version} · tier ${payload.tier} · seed ${payload.seed}`,
    `A:     ${payload.agents.a.id}${payload.agents.a.model ? ` — ${payload.agents.a.model}` : ''}`,
    `B:     ${payload.agents.b.id}${payload.agents.b.model ? ` — ${payload.agents.b.model}` : ''}`,
  ];
  if (payload.identical) {
    lines.push('', 'the two replays are identical: same verified steps, no divergence');
    return lines.join('\n');
  }
  /** @param {string} label @param {string | number} a @param {string | number} b */
  const row = (label, a, b) => lines.push(`${label.padEnd(24)}${String(a).padEnd(30)}${b}`);
  lines.push('');
  row('metric', 'A', 'B');
  row('attempts (agent turns)', A.attempts, B.attempts);
  row('valid actions', A.validActions, B.validActions);
  row('invalid replies', A.invalidActions, B.invalidActions);
  row('distinct observations', A.distinctObservations, B.distinctObservations);
  row('revisited states', A.revisitedStates, B.revisitedStates);
  row(
    'undo-style actions',
    A.undoStyleActions === null ? '—' : String(A.undoStyleActions),
    B.undoStyleActions === null ? '—' : String(B.undoStyleActions)
  );
  row('tokens in', A.tokens.inputTokens ?? 'unknown', B.tokens.inputTokens ?? 'unknown');
  row('tokens out', A.tokens.outputTokens ?? 'unknown', B.tokens.outputTokens ?? 'unknown');
  row('steps without usage', A.tokens.unknownSteps, B.tokens.unknownSteps);
  row('latency total', formatDuration(A.latency.totalMs), formatDuration(B.latency.totalMs));
  row('latency mean', formatDuration(Math.round(A.latency.meanMs ?? 0)), formatDuration(Math.round(B.latency.meanMs ?? 0)));
  row('cost', formatUsd(A.costUsd), formatUsd(B.costUsd));
  row(
    'end',
    `${A.end.reason} · ${A.end.outcomeScore === null ? 'no score' : A.end.outcomeScore.toFixed(3)}`,
    `${B.end.reason} · ${B.end.outcomeScore === null ? 'no score' : B.end.outcomeScore.toFixed(3)}`
  );
  row(
    'episode score',
    A.end.episodeScore === null ? '—' : A.end.episodeScore.toFixed(4),
    B.end.episodeScore === null ? '—' : B.end.episodeScore.toFixed(4)
  );

  /** @param {import('./compare.js').AgentCompare} agent @param {string} label */
  const detailBlock = (agent, label) => {
    lines.push('');
    lines.push(`${label} top actions:`);
    for (const { action, count, share } of agent.topActions) {
      lines.push(`  ${action.padEnd(24)}${String(count).padStart(5)}  (${(share * 100).toFixed(1)}%)`);
    }
    if (agent.topActions.length === 0) lines.push('  (none)');
    if (agent.invalidByReason.length > 0) {
      lines.push(`${label} invalid replies by reason:`);
      for (const { reason, count } of agent.invalidByReason) {
        lines.push(`  ${String(count).padStart(5)}  × ${reason}`);
      }
    }
  };
  detailBlock(A, 'A');
  detailBlock(B, 'B');

  const div = payload.divergence;
  if (div) {
    const why =
      div.reason === 'actions-differ'
        ? `actions differ (observations ${div.observationMatch ? 'match' : 'ALSO differ'})`
        : div.reason === 'observation-differs'
          ? 'observations differ (the same seat now sees a different position or reply feedback)'
          : div.reason === 'a-ended'
            ? 'A ends here while B continues'
            : 'B ends here while A continues';
    lines.push('');
    lines.push(`first divergence: step ${div.index} — ${why}`);
    /** @param {import('./compare.js').DivergenceSide | null} sideOrNull @param {string} label */
    const side = (sideOrNull, label) => {
      lines.push(`${label} at step ${div.index}:`);
      if (!sideOrNull) {
        lines.push('  (no recorded step)');
        return;
      }
      lines.push(`  observation hash ${sideOrNull.observation.hash}:`);
      lines.push(indent(sideOrNull.observation.text, '    '));
      lines.push(
        `  reply ${JSON.stringify(sideOrNull.replyText)} → ${
          sideOrNull.invalid
            ? `INVALID (${sideOrNull.attempted === null ? 'unparseable' : JSON.stringify(sideOrNull.attempted)})`
            : `action ${JSON.stringify(sideOrNull.action)}`
        }`
      );
    };
    side(div.a, 'A');
    side(div.b, 'B');
  }
  return lines.join('\n');
}

/**
 * @param {import('./compare.js').BundleCompare} payload
 * @returns {string}
 */
function renderBundleCompareText(payload) {
  const lines = [
    'PlayKit Gauntlet bundle compare',
    `A: ${payload.bundles.a.dir || '(dir A)'} — ${payload.bundles.a.agent} (${payload.bundles.a.episodes} episodes)`,
    `B: ${payload.bundles.b.dir || '(dir B)'} — ${payload.bundles.b.agent} (${payload.bundles.b.episodes} episodes)`,
    '',
    'per-game paired results (winner = higher episode score; the sign test drops ties):',
    `${'game'.padEnd(16)}${'pairs'.padStart(6)}${'A wins'.padStart(8)}${'ties'.padStart(6)}${'B wins'.padStart(8)}${'  sign-test p'}`,
  ];
  let totals = { pairs: 0, aWins: 0, ties: 0, bWins: 0 };
  for (const g of payload.games) {
    lines.push(
      `${g.game.padEnd(16)}${String(g.pairs).padStart(6)}${String(g.aWins).padStart(8)}${String(g.ties).padStart(6)}${String(g.bWins).padStart(8)}${'  '}${formatP(g.signTestP)}`
    );
    totals = {
      pairs: totals.pairs + g.pairs,
      aWins: totals.aWins + g.aWins,
      ties: totals.ties + g.ties,
      bWins: totals.bWins + g.bWins,
    };
  }
  lines.push(
    `${'total'.padEnd(16)}${String(totals.pairs).padStart(6)}${String(totals.aWins).padStart(8)}${String(totals.ties).padStart(6)}${String(totals.bWins).padStart(8)}`
  );
  lines.push('');
  lines.push('paired episodes:');
  for (const pair of payload.pairs) {
    const tag =
      pair.verdict === 'end-record' && pair.versionDrift
        ? `  [end-record: game v${pair.versionDrift.recorded} → current v${pair.versionDrift.current}]`
        : '  [verified]';
    lines.push(`  ${pair.key}  A ${pair.a.outcome} — B ${pair.b.outcome} → ${pair.winner}${tag}`);
  }
  /** @param {string[]} keys @param {string} label */
  const unpaired = (keys, label) => {
    lines.push('');
    lines.push(keys.length ? `unpaired, only in ${label} (${keys.length}):` : `unpaired, only in ${label}: none`);
    for (const key of keys) lines.push(`  ${key}`);
  };
  unpaired(payload.unpaired.a, 'A');
  unpaired(payload.unpaired.b, 'B');
  lines.push('');
  lines.push(payload.refused.length ? `refused pairs (${payload.refused.length}):` : 'refused pairs: none');
  for (const { key, reason } of payload.refused) lines.push(`  ${key}: ${reason}`);
  lines.push(payload.ignored.length ? `ignored files (${payload.ignored.length}):` : 'ignored files: none');
  for (const file of payload.ignored) lines.push(`  ${file}`);
  return lines.join('\n');
}

/**
 * @returns {Promise<void>}
 */
async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.bundles) {
    const [dirA, dirB] = args.bundles;
    let bundleA;
    let bundleB;
    try {
      bundleA = loadBundle(dirA);
      bundleB = loadBundle(dirB);
    } catch (err) {
      usageError(err instanceof Error ? err.message : String(err));
    }
    let bundlePayload;
    try {
      bundlePayload = await compareBundles(bundleA.entries, bundleB.entries, {
        getGameOf: (trajectory) => getGame(trajectory.game.id),
        dirA,
        dirB,
      });
    } catch (err) {
      if (err instanceof ReplayRefusedError || err instanceof CompareRefusedError) {
        process.stderr.write(`replay: ${err.message}\n`);
        process.exit(1);
      }
      throw err;
    }
    bundlePayload.ignored = [
      ...bundleA.ignored.map((rel) => join(dirA, rel)),
      ...bundleB.ignored.map((rel) => join(dirB, rel)),
    ];
    if (args.format === 'json') {
      process.stdout.write(`${JSON.stringify(bundlePayload, null, 2)}\n`);
    } else {
      process.stdout.write(`${renderBundleCompareText(bundlePayload)}\n`);
    }
    return;
  }

  /** @type {import('../core/types.js').Trajectory} */
  let trajectory;
  try {
    trajectory = readTrajectory(readFileSync(args.file, 'utf8'));
  } catch (err) {
    usageError(`cannot read ${args.file}: ${err instanceof Error ? err.message : String(err)}`);
  }
  /** @type {Game<*>} */
  let game;
  try {
    game = getGame(trajectory.game.id);
  } catch (err) {
    usageError(err instanceof Error ? err.message : String(err));
  }

  if (args.against !== null) {
    let other;
    try {
      other = readTrajectory(readFileSync(args.against, 'utf8'));
    } catch (err) {
      usageError(`cannot read ${args.against}: ${err instanceof Error ? err.message : String(err)}`);
    }
    let comparePayload;
    try {
      comparePayload = await compareTrajectories(game, trajectory, other, {
        pathA: args.file,
        pathB: args.against,
      });
    } catch (err) {
      if (err instanceof ReplayRefusedError || err instanceof CompareRefusedError) {
        process.stderr.write(`replay: ${err.message}\n`);
        process.exit(1);
      }
      throw err;
    }
    if (args.format === 'json') {
      process.stdout.write(`${JSON.stringify(comparePayload, null, 2)}\n`);
    } else {
      process.stdout.write(`${renderEpisodeCompareText(comparePayload)}\n`);
    }
    return;
  }

  let payload;
  try {
    payload = await buildFrames(game, trajectory, { path: args.file });
  } catch (err) {
    if (err instanceof ReplayRefusedError) {
      process.stderr.write(`replay: ${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }

  if (args.step !== null) {
    const frame = payload.frames.find((f) => f.index === args.step);
    if (!frame) {
      usageError(`--step ${args.step} is outside this episode (0..${payload.frames.length - 1})`);
    }
    if (args.format === 'json') {
      payload = { ...payload, frames: [frame] };
    } else {
      process.stdout.write(`${renderHeader(payload)}\n\n${renderFrame(frame, args.maxReplyChars)}\n`);
      return;
    }
  }
  if (args.format === 'json') {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else {
    process.stdout.write(`${renderText(payload, args.maxReplyChars)}\n`);
  }
}

/** @import { Game } from '../core/types.js' */

main().catch((err) => {
  process.stderr.write(`replay: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
