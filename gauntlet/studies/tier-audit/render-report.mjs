#!/usr/bin/env node
/**
 * Render REPORT.md for the tier audit from the committed tiers.json +
 * report-data.json. Deterministic: the same inputs produce the same report.
 *
 * @module
 */

import { readFile, writeFile } from 'node:fs/promises';

const dir = new URL('.', import.meta.url).pathname;
const tiers = JSON.parse(await readFile(dir + 'tiers.json', 'utf8'));
const summary = JSON.parse(await readFile(dir + 'report-data.json', 'utf8'));

/**
 * @param {number | null} x
 * @param {[number, number] | null} ci
 */
function fmt(x, ci) {
  if (x === null || ci === null) return '—';
  return `${x.toFixed(3)} [${ci[0].toFixed(3)}, ${ci[1].toFixed(3)}]`;
}

/** @type {string[]} */
const lines = [];
lines.push('# Tier audit: which gauntlet tiers separate skill, and which reward no-skill play');
lines.push('');
lines.push('Question: can a tier tell a stronger deterministic player from a weaker one at');
lines.push('realistic seed counts — and does a tier reward a player that does not engage with');
lines.push('the game at all? Every registered game tier (18 games, 76 tiers) is audited with');
lines.push('three scripted agents and, where an engine baseline exists, three skill-dial');
lines.push('settings.');
lines.push('');
lines.push('## Cells');
lines.push('');
lines.push('Re-derived at the current game versions on this branch: every cell was');
lines.push('re-checked (a cell counts only when every planned seed has a trajectory');
lines.push('recording the registry\u2019s current game version), cells whose game version');
lines.push('had moved (mastermind 1.1.0, wordle 1.2.0) or whose trajectories were');
lines.push('untracked were re-played, and the tables below are that re-audit.');
lines.push('');
lines.push('- `copy-example` — plays the rules-text documented example token when it is');
lines.push('  exactly legal, else the first legal action. A stronger-than-nothing player that');
lines.push('  only reads the docs.');
lines.push('- `first-legal` — always the first legal action. Pure no-skill floor.');
lines.push('- `dial-0` / `dial-0.5` / `dial-1` — the game\'s own baseline agent with expert');
lines.push('  blending p=0 (random), p=0.5 (half expert), p=1 (random again). Skill must show');
lines.push('  as dial-0.5 strictly between the two random endpoints.');
lines.push('');
lines.push('Dial cells are reused from the committed skill-dial solo study where that study');
lines.push('covered the tier at every p on the same public seeds and game version');
lines.push('(`cellSources: skill-dial-solo`). Cells that cannot exist are recorded as');
lines.push('`not-applicable` with the reason in tiers.json (tictactoe/chess-puzzles/');
lines.push('chess-stockfish ship no baseline agents; cube/cube-5..9 dial-0.5 exceeds the');
lines.push('expert solver\'s proven scramble range; sudoku dial-0.5 hits solver contradictions');
lines.push('on half-mixed states).');
lines.push('');
lines.push('## Statistics');
lines.push('');
lines.push('Cell values mirror the official scoring layer exactly (verified by 614');
lines.push('`score()` mirror checks in compute-tiers): efficiency tiers publish');
lines.push('`min(solvedFraction, mean e)` under every profile; outcome tiers publish the');
lines.push('mean of the profile-transformed episode scores. CIs are seeded percentile');
lines.push('bootstraps (10k draws): plain mean resampling for outcome tiers, joint');
lines.push('`(e, solved)` resampling of the capped statistic for efficiency tiers.');
lines.push('Exploitability: paired bootstrap of `no-skill − dial-1` (both are random-policy');
lines.push('episodes; a positive gap means the tier rewards not engaging). Power: paired');
lines.push('gap tests report the seeds needed for two-sided alpha 0.05.');
lines.push('');
lines.push(`Headline counts: ${summary.tiers.usable} usable tiers, ${summary.tiers.flagged} flagged`);
lines.push(`(${tiers.counts.tiers} total). Seeds per tier: the tier's full public seed list`);
lines.push('(12–60; chess-puzzles tiers n=60).');
lines.push('');
lines.push('## Flags (the short answer)');
lines.push('');
lines.push('- **Exploitable tiers** — a no-skill strategy\'s paired CI clears zero over the');
lines.push('  dial-1 random endpoint: 2048 (all four tiers), chess-endgames/kqk,');
lines.push('  connect4/ladder-1, holdem/station, holdem/rules. On these tiers a player that');
lines.push('  does not engage with the game scores significantly above the random endpoint.');
lines.push('- **Luck-dominated tiers** — dial-0 and dial-1 random-policy CIs overlap');
lines.push('  (skill signal unreachable at the audit\'s seed budget): chess/sand,');
lines.push('  go/ladder-1, go/ladder-2, go/ladder-4.');
lines.push('');
lines.push('## Full table');
lines.push('');
lines.push('Values are `rhae-v1` (`squared-outcome` and `chance-adjusted` in tiers.json).');
lines.push('`dial-0.5` is the only column where skill can appear: it must beat both random');
lines.push('endpoints by more than the CIs. `exploit` columns show the paired no-skill');
lines.push('advantage over the random endpoint (`dial-1`).');
lines.push('');
lines.push('| game/tier | n | copy-example | first-legal | dial-0 | dial-0.5 | dial-1 | exploit copy | exploit first | flags |');
lines.push('|---|---|---|---|---|---|---|---|---|---|');
for (const row of tiers.rows) {
  const n = row.cells['dial-0']?.['rhae-v1'].n ?? row.cells['copy-example']?.['rhae-v1'].n ?? 0;
  const cell = (c) => {
    const v = row.cells[c]?.['rhae-v1'];
    return v ? fmt(v.mean, v.ci95) : '—';
  };
  const ex = (c) => {
    const v = row.exploitableBy?.[c];
    return v ? fmt(v.mean, v.ci95) : '—';
  };
  lines.push(
    `| ${row.game}/${row.tier} | ${n} | ${cell('copy-example')} | ${cell('first-legal')} | ${cell('dial-0')} | ${cell('dial-05')} | ${cell('dial-1')} | ${ex('copy-example')} | ${ex('first-legal')} | ${row.flags.join(', ') || '—'} |`
  );
}
lines.push('');
lines.push('## Reproducing');
lines.push('');
lines.push('Raw episode trajectories (165 MB, 5605 episodes) are re-derivable and not');
lines.push('committed; every cell bundle\'s run record and suite manifest are committed');
lines.push('under `bundles/`. From `gauntlet/` on alpha with the engine binaries installed');
lines.push('(`stockfish`, `gnugo`):');
lines.push('');
lines.push('```sh');
lines.push('node studies/tier-audit/run-cells.mjs           # regenerate any missing bundles');
lines.push('sh studies/tier-audit/reproduce.sh              # replay-verify all bundles, regenerate tiers.json, diff byte-identical');
lines.push('node studies/tier-audit/render-report.mjs       # re-render this report from tiers.json');
lines.push('```');
lines.push('');
lines.push('Engine opponents are GNU Go 3.8 and Stockfish 17.1; episodes are deterministic');
lines.push('per recorded engine version and public seeds.');
lines.push('');

await writeFile(dir + 'REPORT.md', lines.join('\n') + '\n');
console.log(`report: ${tiers.rows.length} rows rendered`);
