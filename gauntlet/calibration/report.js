/**
 * REPORT.md renderer for the calibration run. Pure module: takes the run's
 * tables, checks, metas and environment, returns the markdown text. Kept
 * free of `node:*` imports so the tests can render fixtures directly.
 *
 * @module
 */

/** Baseline provenance notes for games whose baselines are not packet-native. */
/** @type {Record<string, string>} */
const MAPPING_NOTES = {
  tictactoe:
    'No packet baselines ship for tictactoe (a smoke game): `greedy` here is a win/block/center heuristic with seeded tie-breaks, `engine` is perfect minimax over the game\'s own `step` and `outcome`.',
  minesweeper:
    '`greedy` is the packet\'s probability agent (proven-safe cells first, lowest mine-probability cell when deduction stalls); `engine` is the packet\'s deduction agent (plays only proven-safe cells — the no-guess guarantee).',
  sliding:
    'The sliding packet ships no greedy baseline: `greedy` here minimizes total Manhattan distance to goal with seeded tie-breaks; `engine` is the packet\'s optimal-line solver agent.',
};

/**
 * @param {number | null | undefined} v
 * @returns {string}
 */
function fmtScore(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return '—';
  return String(Math.round(v * 1000) / 1000);
}

/**
 * @param {number | null | undefined} v
 * @returns {string}
 */
function fmtFraction(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return '—';
  return `${Math.round(v * 1000) / 10}%`;
}

/**
 * @typedef {import('./checks.js').CalibrationTable} CalibrationTable
 * @typedef {import('./checks.js').Violation} Violation
 */

/**
 * @typedef {object} RenderEnv
 * @property {string} node
 * @property {string} platform
 * @property {string} cpu
 * @property {number} cores
 * @property {number} parallelismUsed
 * @property {number} memoryGiB
 * @property {string} headSha
 * @property {string} baseSha
 * @property {string[]} mergeParents
 * @property {string} runAt
 */

/**
 * @typedef {object} RenderInput
 * @property {CalibrationTable[]} tables
 * @property {Violation[]} violations
 * @property {{ gameId: string, wallTimeSec: number, episodesRun: number, capHit: boolean }[]} metas
 * @property {string[]} failures
 * @property {number | null} seedsLimit
 * @property {number} timeCapSec
 * @property {number} wallTimeSec
 * @property {RenderEnv} env
 */

/**
 * @param {RenderInput} input
 * @returns {string}
 */
export function renderReport(input) {
  const { tables, violations, metas, failures, seedsLimit, timeCapSec, wallTimeSec, env } = input;
  const lines = [];

  lines.push('# Gauntlet calibration report');
  lines.push('');
  lines.push(
    `Baseline calibration over the gauntlet's public seeds: every game is played by a random, a greedy and an engine baseline through the same core runner and scored by the package's own scoring rules. This is the first evidence that the tier ladders mean something — a tier ordering that even uniform play breaks is a tier ordering no agent ranking can stand on.`
  );
  lines.push('');
  lines.push(
    `> **What this report can and cannot tell you.** The checks below validate *baseline* ordering: random ≤ greedy ≤ engine per tier, non-rising random/greedy scores as tier rank rises, and ≥95% engine solves on efficiency tiers. That is evidence the tiers are ordered and solvable, not that the ladder discriminates between agents stronger than the engine — a ladder whose rungs only separate agents above the engine would pass here and still be useless. The evidence that would break the premise: any monotonic rise for random or greedy with rank, or greedy beating engine on a tier; both appear in the checks section with the parameter change they suggest.`
  );
  lines.push('');

  // Environment and provenance.
  lines.push('## Run');
  lines.push('');
  lines.push('| | |');
  lines.push('|---|---|');
  lines.push(`| Run at | ${env.runAt} |`);
  lines.push(`| Node | ${env.node} |`);
  lines.push(`| Machine | ${env.platform}, ${env.cpu}, ${env.cores} cores, ${env.memoryGiB} GiB |`);
  lines.push(`| Worker parallelism | ${env.parallelismUsed} |`);
  lines.push(`| Seeds per tier | ${seedsLimit === null ? 'all public seeds' : `first ${seedsLimit} public seeds`} |`);
  lines.push(`| Per-game wall cap | ${timeCapSec}s |`);
  lines.push(`| Total wall time | ${wallTimeSec}s |`);
  lines.push(`| HEAD | ${env.headSha} |`);
  lines.push(`| Base | ${env.baseSha} |`);
  if (env.mergeParents.length > 1) {
    lines.push(`| Merge parents of HEAD | ${env.mergeParents.join(', ')} |`);
  }
  lines.push('');
  lines.push(
    'Reproduce from `gauntlet/` with `node calibration/run.js` (flags: `--games=`, `--seeds=`, `--per-game-cap=`, `--out=`, `--report=`). One worker process per game; deterministic end to end — same seeds and code produce byte-identical tables.'
  );
  lines.push('');

  // Per-game tables.
  lines.push('## Tables');
  lines.push('');
  for (const table of tables) {
    lines.push(`### ${table.game.id} (v${table.game.version}${table.game.benchmark ? '' : ', benchmark: false — smoke game, not scored on the gauntlet leaderboard'})`);
    lines.push('');
    lines.push('| tier (rank) | scoring | random | greedy | engine | engine solved |');
    lines.push('|---|---|---|---|---|---|');
    const kinds = /** @type {const} */ (['random', 'greedy', 'engine']);
    const first = kinds.map((k) => table.baselines[k]).find(Boolean);
    const tiers = first ? Object.values(first.tiers).sort((a, b) => a.rank - b.rank) : [];
    // A block with no episodes (a cap stopped the worker before that rung
    // ran) was never checked: gating the pass line on full coverage keeps a
    // capped partial table from rendering a vacuous "checks pass".
    const hasEmptyBlocks = tiers.some((tier) =>
      kinds.some((kind) => {
        const block = table.baselines[kind]?.tiers[tier.id];
        return !block || !(block.episodes > 0);
      })
    );
    for (const tier of tiers) {
      const cells = kinds.map((kind) => {
        const block = table.baselines[kind]?.tiers[tier.id];
        if (!block) return '—';
        const value = fmtScore(block.score.value);
        const ci = block.score.ci95 ? ` [${fmtScore(block.score.ci95[0])}, ${fmtScore(block.score.ci95[1])}]` : '';
        return `${value}${ci}`;
      });
      const engineBlock = table.baselines.engine?.tiers[tier.id];
      const solved =
        tier.scoring === 'efficiency' && engineBlock
          ? fmtFraction(engineBlock.solvedFraction)
          : '—';
      lines.push(`| ${tier.id} (${tier.rank}) | ${tier.scoring} | ${cells.join(' | ')} | ${solved} |`);
    }
    lines.push('');
    const meta = metas.find((m) => m.gameId === table.game.id);
    if (meta) {
      const coverage =
        meta.capHit
          ? `⚠️ the ${timeCapSec}s wall cap stopped this worker early (${meta.episodesRun} episodes run) — remaining cells are empty and the checks below skip them`
          : `${meta.episodesRun} episodes, ${meta.wallTimeSec}s`;
      lines.push(`_Run:_ ${coverage}.`);
      lines.push('');
    }
    const gameViolations = violations.filter((v) => v.game === table.game.id);
    if (gameViolations.length === 0 && !hasEmptyBlocks) {
      lines.push('✅ ordering checks pass (random ≤ greedy ≤ engine per tier; no rank rise for random/greedy; engine solves ≥95% where required).');
      lines.push('');
    } else if (gameViolations.length === 0) {
      lines.push('⚠️ ordering checks skipped — cells are empty after the cap (episodes stopped before they could be scored), so nothing was checked there.');
      lines.push('');
    } else {
      for (const violation of gameViolations) {
        lines.push(`❌ **${violation.check}** — ${violation.detail}`);
        lines.push('');
        lines.push(`  _Proposal:_ ${violation.proposal}`);
        lines.push('');
      }
      if (hasEmptyBlocks) {
        lines.push('⚠️ additional ordering checks skipped — other cells are empty after the cap; nothing was checked there.');
        lines.push('');
      }
    }
    const note = MAPPING_NOTES[table.game.id];
    if (note) {
      lines.push(`_Baselines:_ ${note}`);
      lines.push('');
    }
  }

  // Checks summary.
  lines.push('## Checks');
  lines.push('');
  if (violations.length === 0) {
    lines.push(`All games pass all three checks (${tables.length} table${tables.length === 1 ? '' : 's'}).`);
  } else {
    lines.push(
      `${violations.length} violation(s) across ${new Set(violations.map((v) => v.game)).size} game(s). Each violation names the parameter it suggests changing; a violation is a calibration finding about tier parameters, not a scoring-rules bug — the scoring rules are the package's own and are shared with the leaderboard.`
    );
    lines.push('');
    for (const violation of violations) {
      lines.push(`- **${violation.game} — ${violation.check}** (${violation.tier ?? 'cross-tier'}): ${violation.detail}`);
    }
  }
  lines.push('');

  if (failures.length > 0) {
    lines.push('## Worker failures');
    lines.push('');
    for (const failure of failures) {
      lines.push(`- ${failure}`);
    }
    lines.push('');
    lines.push('Games whose worker failed have no table in this report; re-run them individually with `--games=<id>`.');
    lines.push('');
  }

  return lines.join('\n');
}
