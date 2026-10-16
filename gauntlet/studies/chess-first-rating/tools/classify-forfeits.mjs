#!/usr/bin/env node
/**
 * Classify every invalid reply in the committed first-model-run chess
 * trajectories (reports/first-model-run/run-qwen/chess*), re-deriving the
 * runner's rejection reason by replaying each episode with the current game
 * code and calling the same judgeReply the runner and verifier use.
 *
 * The committed chess trajectories were recorded at chess v1.0.0; notation.js
 * and render.js are byte-identical between v1.0.0 and the current 1.1.0
 * (only the internals were memoized), so every observation hash re-derives
 * identically — the classification transfers exactly.
 *
 * Categories:
 *   empty            — nothing usable in the reply (extractAction null)
 *   prose            — the reply's action line is not shaped like a move
 *   wrong-notation   — move-shaped but rejected as unparseable (grammar)
 *                      — includes bare pawn squares like "e5" that SAN would
 *                      spell but that are illegal (occupied square), which the
 *                      judge mislabels "cannot parse" instead of "not legal"
 *   illegal-move     — parses cleanly (UCI or SAN) but is not legal in the
 *                      position
 *   parser-fault     — a move the chess grammar should accept was rejected
 *                      (checked for the chess game only — the one game this
 *                      study owns; its check normalizes UCI/SAN decorations)
 *
 * Flags recorded per step: staleRepeat (same attempted text as the agent's
 * previous attempt), legalListed (the observation listed the legal moves,
 * legal count <= 64), legalCount.
 *
 * Node-only. Usage:
 *   cd gauntlet && node studies/chess-first-rating/tools/classify-forfeits.mjs
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const GAUNTLET = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const RUN_DIR = join(GAUNTLET, 'reports', 'first-model-run', 'run-qwen');
const OUT_DIR = join(GAUNTLET, 'studies', 'chess-first-rating');

const chessGame = await import(join(GAUNTLET, 'games', 'chess', 'index.js'));
const chessStockfish = await import(join(GAUNTLET, 'games', 'chess-stockfish', 'index.js'));
const chessEndgames = await import(join(GAUNTLET, 'games', 'chess-endgames', 'index.js'));
const { judgeReply } = await import(join(GAUNTLET, 'core', 'runner.js'));
const { hashObservation } = await import(join(GAUNTLET, 'core', 'canonical.js'));
const { stripDecorations } = await import(join(GAUNTLET, 'games', 'chess', 'notation.js'));

const GAMES = {
  chess: chessGame.chess,
  'chess-stockfish': chessStockfish.chessStockfish,
  'chess-endgames': chessEndgames.chessEndgames,
};

/** Anything shaped like a chess move in UCI, loose SAN, or castling notation. */
const MOVE_SHAPED_RE =
  /^[a-h][1-8][a-h][1-8][qrbnQRBN]?=?[qrbnQRBN]?$|^(?:[KQRBN][a-h]?[1-8]?)(?:x)?[a-h][1-8](?:=?[qrbnQRBN])?[+#?!]*$|^[a-h](?:x)?[a-h]?[1-8](?:=?[qrbnQRBN])?[+#?!]*$|^[Oo0]-[Oo0](?:-[Oo0])?[+#?!]*$|^[KQRBN][a-h][1-8]$|^[a-h][1-8]$/;

function walkFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walkFiles(p));
    else if (name.endsWith('.json') && name !== 'run.json' && name !== 'suite.json') out.push(p);
  }
  return out;
}

const normSan = (s) =>
  s.toLowerCase().replace(/[+#!?]+$/g, '').replace(/=/g, '').replace(/0/g, 'o');

/**
 * Would a reasonable chess grammar have accepted this attempt? True when the
 * attempt normalizes to a legal move's SAN or a legal UCI (case-insensitive,
 * with/without the promotion `=`, castling with zeros).
 */
function shouldBeAcceptable(chessApi, attempted) {
  const verbose = chessApi.moves({ verbose: true });
  const legalUcis = verbose.map((m) => `${m.from}${m.to}${m.promotion ?? ''}`);
  const uciNorm = attempted.toLowerCase().replace(/=/g, '');
  if (legalUcis.some((u) => u.toLowerCase() === uciNorm)) return true;
  let sans = [];
  try {
    sans = chessApi.moves();
  } catch {
    return false;
  }
  const a = normSan(attempted);
  return sans.some((san) => normSan(san) === a);
}

const episodes = [];
const invalidSteps = [];

for (const rel of ['chess', 'chess-stockfish', 'chess-endgames']) {
  const gameDir = join(RUN_DIR, rel);
  for (const file of walkFiles(gameDir)) {
    const trajectory = JSON.parse(readFileSync(file, 'utf8'));
    const game = GAMES[trajectory.game.id];
    if (!game) throw new Error(`no game object for ${trajectory.game.id}`);
    const tier = game.spec.tiers.find((t) => t.id === trajectory.tier);
    if (!tier) throw new Error(`${file}: no tier ${trajectory.tier}`);

    // Re-derive the observation the model saw at each step.
    let state = game.reset(tier, trajectory.seed);
    let prevAttempted = null;
    const epInvalids = [];
    for (let i = 0; i < trajectory.steps.length; i++) {
      const step = trajectory.steps[i];
      const seat = game.toAct(state);
      if (seat === null) throw new Error(`${file}: game over at step ${i}`);
      const observation = game.observe(state, seat);
      const hash = hashObservation(observation);
      if (hash !== step.observationHash) {
        throw new Error(
          `${file}: observation hash mismatch at step ${i} — replay does not transfer; classification would be unsound`
        );
      }
      const legal = game.legalActions(state, seat);
      const isAgent = step.by === 'agent';
      const decision = judgeReply(game, state, seat, legal, step.reply?.text ?? '');

      if (isAgent && step.invalid) {
        const attempted = decision.attempted;
        const reason = decision.reason ?? '';
        // Classify by what the judge actually decided, using the stripped
        // form (games strip a leading "move"/"play" themselves, e.g.
        // chess-endgames parsed "move c7b6" as the UCI move c7b6).
        const stripped = attempted === null ? null : stripDecorations(attempted);
        let category;
        if (stripped === null) category = 'empty';
        else if (reason.includes('is not legal') || reason.includes('illegal action')) category = 'illegal-move';
        else if (reason.includes('no action found')) category = 'prose';
        else if (!MOVE_SHAPED_RE.test(stripped.replace(/^action:\s*/i, ''))) category = 'prose';
        else category = 'wrong-notation';
        if (
          attempted !== null &&
          trajectory.game.id === 'chess' &&
          shouldBeAcceptable(chessGame.stateToChess(observation.data), attempted)
        ) {
          category = 'parser-fault';
        }
        epInvalids.push({
          file: file.slice(RUN_DIR.length + 1),
          tier: trajectory.tier,
          stepIndex: i,
          attempted,
          reason: decision.reason,
          category,
          staleRepeat: attempted !== null && attempted === prevAttempted,
          legalCount: legal.length,
          legalListed: legal.length <= 64,
          agentSeat: trajectory.agent.seat,
          seat,
          replyPreview: String(step.reply?.text ?? '').slice(0, 120),
        });
      }
      if (isAgent) prevAttempted = step.action;
      if (!step.invalid) {
        state = game.step(state, seat, step.action);
      }
    }
    episodes.push({
      file: file.slice(RUN_DIR.length + 1),
      game: trajectory.game,
      tier: trajectory.tier,
      seed: trajectory.seed,
      agent: trajectory.agent.id,
      end: trajectory.end.reason,
      agentActions: trajectory.end.agentActions,
      invalidActions: trajectory.end.invalidActions,
      invalids: epInvalids,
    });
    invalidSteps.push(...epInvalids);
  }
}

// Summary tables.
const byCategory = {};
for (const s of invalidSteps) byCategory[s.category] = (byCategory[s.category] ?? 0) + 1;
const byEpisode = episodes.map((e) => ({
  file: e.file,
  end: e.end,
  agentActions: e.agentActions,
  invalidActions: e.invalidActions,
  categories: e.invalids.map((s) => s.category).join(', ') || 'none',
}));
const stale = invalidSteps.filter((s) => s.staleRepeat).length;
const listedWhenInvalid = invalidSteps.filter((s) => s.legalListed).length;

const summary = {
  episodes: episodes.length,
  invalidSteps: invalidSteps.length,
  byCategory,
  staleRepeat: stale,
  legalListShownAtInvalid: listedWhenInvalid,
  legalListHiddenAtInvalid: invalidSteps.length - listedWhenInvalid,
  parserFaults: byCategory['parser-fault'] ?? 0,
};

writeFileSync(
  join(OUT_DIR, 'forfeits.json'),
  JSON.stringify({ summary, episodes, invalidSteps }, null, 2) + '\n'
);

// Human-readable report.
const lines = [
  '# Committed Qwen chess trajectories — invalid-reply classification',
  '',
  'Source: `reports/first-model-run/run-qwen/{chess,chess-stockfish,chess-endgames}`, replayed and re-judged with the current game code (`judgeReply`, the same accept/reject decision the runner and verifier use). Every observation hash re-verified, so the classification transfers exactly: notation.js and render.js are unchanged since the v1.0.0 the run was recorded at.',
  '',
  `Episodes: ${episodes.length}. Invalid agent replies: ${invalidSteps.length}.`,
  '',
  '| Category | Count |',
  '|---|---:|',
  ...Object.entries(byCategory)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `| ${k} | ${v} |`),
  '',
  `Stale repeats (same attempted text as the previous attempt): ${stale}/${invalidSteps.length}.`,
  `Observation listed the legal moves at the invalid step: ${listedWhenInvalid}/${invalidSteps.length}.`,
  '',
  '## Every invalid reply',
  '',
  '| Episode | Step | Attempted | Category | Stale repeat | Legal listed | Judge reason |',
  '|---|---:|---|---|---|---|---|',
  ...invalidSteps.map(
    (s) =>
      `| ${s.file} | ${s.stepIndex} | \`${s.attempted ?? '(null)'}\` | ${s.category} | ${s.staleRepeat ? 'yes' : 'no'} | ${s.legalListed ? `yes (${s.legalCount})` : `no (${s.legalCount})`} | ${s.reason} |`
  ),
  '',
  '## Per-episode endings',
  '',
  '| Episode | End | Agent actions | Invalid actions | Categories in order |',
  '|---|---|---:|---:|---|',
  ...byEpisode.map(
    (e) => `| ${e.file} | ${e.end} | ${e.agentActions} | ${e.invalidActions} | ${e.categories} |`
  ),
  '',
];
writeFileSync(join(OUT_DIR, 'forfeits.md'), lines.join('\n') + '\n');
process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
