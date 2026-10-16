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

import { readFileSync } from 'node:fs';
import { buildFrames, ReplayRefusedError } from './frames.js';
import { getGame } from '../games/index.js';

/** @typedef {import('./frames.js').ReplayFrame} ReplayFrame */
/** @typedef {import('./frames.js').ReplayFrames} ReplayFrames */

const USAGE = `usage: node replay/cli.js <trajectory.json> [--step N] [--format text|json] [--max-reply-chars K]

  --step N             show only step N (0-based)
  --format text|json   text: readable episode (default); json: frames payload
  --max-reply-chars K  truncate displayed replies to K chars (text only)
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
 * @returns {{ file: string, step: number | null, format: 'text' | 'json', maxReplyChars: number | null }}
 */
function parseArgs(argv) {
  /** @type {{ file: string, step: number | null, format: 'text' | 'json', maxReplyChars: number | null }} */
  const args = { file: '', step: null, format: 'text', maxReplyChars: null };
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
      args.maxReplyChars = n;
    } else if (arg === '--help' || arg === '-h') {
      process.stdout.write(USAGE);
      process.exit(0);
    } else if (arg.startsWith('--')) {
      usageError(`unknown option ${arg}`);
    } else if (args.file === '') {
      args.file = arg;
    } else {
      usageError(`unexpected extra argument ${JSON.stringify(arg)}`);
    }
  }
  if (args.file === '') usageError('a trajectory file is required');
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
 * @returns {Promise<void>}
 */
async function main() {
  const args = parseArgs(process.argv.slice(2));
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
