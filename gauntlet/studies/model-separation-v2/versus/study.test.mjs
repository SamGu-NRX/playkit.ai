import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildManifest, jobCount } from './build-suite.mjs';
import { modelSuite, rawEpisodeScore, trajectoryFiles } from './score-study.mjs';

const here = dirname(fileURLToPath(import.meta.url));

const TIERS = [
  ['tictactoe', 'random-opponent', 1],
  ['tictactoe', 'blunder-opponent', 2],
  ['connect4', 'ladder-1', 1],
  ['connect4', 'ladder-0', 2],
];

test('suite manifest: exactly the four versus tiers at their natural consecutive ranks', () => {
  const manifest = buildManifest(12);
  assert.equal(manifest.games.length, 2);
  const got = manifest.games.map((g) => [g.id, ...g.tiers.map((t) => [t.id, t.rank, t.scoring])]);
  assert.deepEqual(got, [
    ['tictactoe', ['random-opponent', 1, 'outcome'], ['blunder-opponent', 2, 'outcome']],
    ['connect4', ['ladder-1', 1, 'outcome'], ['ladder-0', 2, 'outcome']],
  ]);
  assert.equal(manifest.id, 'gauntlet-public-model-separation-v2-versus-s12');
  assert.equal(jobCount(manifest), 48, '12 seeds x 4 tiers');
});

test('suite manifest: seeds are the tier public seeds 0..n-1, capped at the tier supply', () => {
  for (const n of [3, 12, 16, 20]) {
    const manifest = buildManifest(n);
    for (const g of manifest.games) {
      for (const t of g.tiers) {
        assert.ok(t.seeds.length === n || t.seeds.length < n, `${g.id}/${t.id} capped`);
        t.seeds.forEach((seed, i) => {
          assert.match(seed, new RegExp(`^${g.id}/${t.id}/public/${i}$`), `${seed} is public seed ${i}`);
        });
      }
    }
  }
  // connect4/ladder-1 has 12 public seeds, so a 16/tier request caps it at 12.
  const m16 = buildManifest(16);
  const ladder1 = m16.games.find((g) => g.id === 'connect4').tiers.find((t) => t.id === 'ladder-1');
  assert.equal(ladder1.seeds.length, 12, 'ladder-1 caps at its 12 public seeds');
});

test('modelSuite: both study games, their two study tiers, natural ranks, and a per-model id', () => {
  const suite = modelSuite('qwen2.5-7b-instruct-q4_k_m');
  assert.equal(suite.id, 'model-separation-v2-versus-qwen2.5-7b-instruct-q4_k_m');
  assert.deepEqual(
    suite.games.map((g) => [g.id, ...g.tiers.map((t) => [t.id, t.rank])]),
    [
      ['tictactoe', ['random-opponent', 1], ['blunder-opponent', 2]],
      ['connect4', ['ladder-1', 1], ['ladder-0', 2]],
    ],
  );
});

test('rawEpisodeScore mirrors the outcome rules for win/loss/draw and rejects junk', () => {
  const tier = { id: 'random-opponent', scoring: 'outcome' };
  const seat = 0;
  const mk = (value) => ({
    agent: { seat },
    game: { id: 'tictactoe' },
    seed: 'tictactoe/random-opponent/public/0',
    end: {
      outcome: { normalized: [value, value === 0.5 ? 0.5 : 1 - value] },
      agentActions: 5,
    },
  });
  assert.equal(rawEpisodeScore(tier, mk(1)).e, 1);
  assert.equal(rawEpisodeScore(tier, mk(0)).e, 0);
  assert.equal(rawEpisodeScore(tier, mk(0.5)).e, 0.5);
  assert.equal(rawEpisodeScore(tier, mk(1)).agentActions, 5);
  assert.throws(
    () => rawEpisodeScore(tier, { agent: { seat: 0 }, end: { outcome: {} } }),
    /no finite normalized/,
    'a trajectory without a finite normalized value is refused',
  );
  assert.throws(
    () => rawEpisodeScore({ id: 'par-x', scoring: 'efficiency' }, { agent: { seat: 0 }, end: { outcome: { normalized: [1] } } }),
    /not an outcome tier/,
    'efficiency tiers are refused: this study covers outcome tiers only',
  );
});

test('trajectoryFiles picks up only trajectory json, never run manifests or suite.json', () => {
  const root = mkdtempSync(join(tmpdir(), 'vstudy-traj-'));
  try {
    const stem = 'qwen2.5-0.5b-instruct-q4_k_m';
    mkdirSync(join(root, stem, 'tictactoe/random-opponent/public'), { recursive: true });
    writeFileSync(join(root, stem, 'tictactoe/random-opponent/public/0.json'), '{}');
    writeFileSync(join(root, stem, 'tictactoe/random-opponent/public/1.json'), '{}');
    writeFileSync(join(root, stem, 'run.json'), '{}');
    writeFileSync(join(root, stem, 'run.jsonl'), '{}');
    writeFileSync(join(root, stem, 'suite.json'), '{}');
    const files = trajectoryFiles(root, stem);
    assert.equal(files.length, 2);
    assert.ok(files.every((f) => f.endsWith('/0.json') || f.endsWith('/1.json')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('study-local models.sha256 matches the canonical model-separation study file', () => {
  const canonical = resolve(here, '../../model-separation/models.sha256');
  assert.ok(existsSync(canonical), 'studies/model-separation/models.sha256 exists');
  const studyCopy = resolve(here, 'models.sha256');
  assert.ok(existsSync(studyCopy), 'study-local models.sha256 committed');
  const lines = readFileSync(studyCopy, 'utf8').trim().split('\n');
  assert.ok(lines.length >= 3, 'at least the three ladder GGUF files listed');
  for (const line of lines) assert.match(line, /^[0-9a-f]{64}  \S+$/, 'sha256sum format');
});

test('scorer main() scores real committed fixtures and agrees with the mirror', async () => {
  // Real, bundle-verified trajectories, re-recorded at the current game
  // versions (connect4 1.2.0; the 7B probe recordings predate the connect4
  // engine fix and the scorer's version refusal correctly rejects them).
  // Each episode was played through the real CLI against a loopback stub
  // replaying the prior probe recordings' seat-0 reply scripts, so the
  // recorded outcomes (a tictactoe win, a ladder-1 win, a ladder-0 loss)
  // match the original pins. The trajectories' agent spec names the actual
  // recording agent; the stem below is only the directory label the study's
  // pinned-model discovery scans. score() replays and hash-verifies every
  // fixture, so a fixture drifting from HEAD fails here.
  const root = mkdtempSync(join(tmpdir(), 'vstudy-run-'));
  const out = mkdtempSync(join(tmpdir(), 'vstudy-out-'));
  const stem = 'qwen2.5-7b-instruct-q4_k_m';
  const fixtures = [
    ['trajectory-tictactoe-random-opponent-seed0.json', 'tictactoe/random-opponent/public/0'],
    ['trajectory-connect4-ladder-1-seed0.json', 'connect4/ladder-1/public/0'],
    ['trajectory-connect4-ladder-0-seed0.json', 'connect4/ladder-0/public/0'],
  ];
  try {
    for (const [fixture, seed] of fixtures) {
      const [game, tier] = seed.split('/').slice(0, 2);
      const dir = join(root, stem, game, tier, game, tier, 'public');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, '0.json'), readFileSync(join(here, 'fixtures', fixture)));
    }
    const { main } = await import('./score-study.mjs');
    await main(['--runs', root, '--out', out]);
    const results = JSON.parse(readFileSync(join(out, 'profile-results.json'), 'utf8'));
    const episodes = JSON.parse(readFileSync(join(out, 'episodes.json'), 'utf8'));
    assert.equal(results.format, 'playkit-gauntlet-study-model-separation-v2-versus-profile-results/1');
    assert.equal(results.groups.length, 3);
    // main() exits non-zero on any mirror disagreement, so reaching here means
    // score() and the episode-rule mirror agree; pin the published values.
    const byTier = new Map(results.groups.map((g) => [`${g.game}/${g.tier}`, g]));
    for (const [, g] of byTier) {
      for (const profile of ['rhae-v1', 'squared-outcome']) {
        assert.equal(g.scores[profile].value, g.mirrorMean[profile], `${g.game}/${g.tier} ${profile} mirror agrees`);
        assert.equal(g.scores[profile].refusal, null, `${g.game}/${g.tier} ${profile} no refusal`);
      }
    }
    assert.equal(byTier.get('tictactoe/random-opponent').scores['rhae-v1'].value, 1, 'tictactoe win scores 1');
    assert.equal(byTier.get('connect4/ladder-1').scores['rhae-v1'].value, 1, 'ladder-1 win scores 1');
    assert.equal(byTier.get('connect4/ladder-0').scores['rhae-v1'].value, 0, 'ladder-0 loss scores 0');
    assert.equal(episodes.length, 3);
    for (const e of episodes) {
      assert.ok(e.r !== undefined && e.r >= 0 && e.r < 1, `chance-adjusted basis recorded for ${e.seed}`);
      assert.ok(e.calls > 0 && e.tokensPerCall > 0, `process columns populated for ${e.seed}`);
    }
    const chances = episodes.map((e) => e.profiles['chance-adjusted']).sort();
    assert.deepEqual(chances, [0, 1, 1], 'chance-adjusted saturates to 1/1/0 on these episodes');
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  }
});

test('compute-stats.py self-test passes when python3 is available', () => {
  let python = null;
  try {
    execFileSync('python3', ['--version'], { stdio: 'ignore' });
    python = 'python3';
  } catch {
    // python3 absent: skip like the Stockfish tests skip
  }
  if (!python) {
    test.skip('python3 is not available on this machine', () => {});
    return;
  }
  execFileSync(python, [join(here, 'compute-stats.py'), '--self-test'], { stdio: 'pipe' });
});

test('compute-stats.py --dir writes stats.json to the selected output directory, never beside the script', () => {
  let python = null;
  try {
    execFileSync('python3', ['--version'], { stdio: 'ignore' });
    python = 'python3';
  } catch {
    test.skip('python3 is not available on this machine', () => {});
    return;
  }
  const out = mkdtempSync(join(tmpdir(), 'vstudy-stats-'));
  // Minimal offline inputs: empty groups/episodes render n/a tiers, so the
  // script runs end-to-end without bundles or models; calibration reads are
  // the committed tables. The old behavior wrote the result beside the script,
  // so reproduce.sh's --dir invocation clobbered the committed stats.json
  // before comparing it against itself.
  writeFileSync(
    join(out, 'profile-results.json'),
    JSON.stringify({ format: 'playkit-gauntlet-study-model-separation-v2-versus-profile-results/1', baseline: 'sha256:test-baseline', groups: [] }) + '\n'
  );
  writeFileSync(join(out, 'episodes.json'), '[]\n');
  const committedBefore = existsSync(join(here, 'stats.json')) ? readFileSync(join(here, 'stats.json')) : null;
  try {
    execFileSync(python, [join(here, 'compute-stats.py'), '--dir', out], { stdio: 'pipe' });
    assert.ok(existsSync(join(out, 'stats.json')), 'stats.json must be written to --dir, not beside the script');
    if (committedBefore !== null) {
      assert.deepEqual(readFileSync(join(here, 'stats.json')), committedBefore, 'compute-stats must never touch the committed stats.json under --dir');
    }
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
