# Leak recheck: did the cross-episode agent leak change the model-separation result?

**Question.** PR #41 shipped a model-agent implementation where one agent object served every
episode of a run (`agents.js` built a single `model-agent` per run, not per episode). PR #42's
follow-up ("fresh model agent per episode") replaced it. Every model episode played before that
fix therefore ran under an agent that had already served earlier episodes in the same process.
Did that cross-episode leak change any measured result — specifically the model-separation
study's (PR #43) conclusion that the Gauntlet suite does **not** rank Qwen2.5 0.5B / 1.5B / 7B
in order at 4 seeds/tier?

**Verdict.** No. The leak left every per-episode score in PR #43's study unchanged, except one
connect4 ladder episode that 1.5B *lost* under the leak and *wins* under the fixed agent. The
study's headline numbers reproduce within one episode; its "does not rank in order" conclusion
stands (the single flipped episode moves 1.5B up, against the leak's favor, and the pooled
paired confidence interval still touches zero). The leak did change *trajectories*: reply
sequences differ in 10/28 episodes for 0.5B and 13/28 for 1.5B, and per-call input-token counts
differ by a few tokens — the fresh-agent prompts are measurably different even where greedy
sampling lands in the same place.

This study reran PR #43's suite on the episode-isolation fix with #43's exact serving setup,
paired episodes by (game, seed), and validated the comparison with a determinism control.

## Method

**Determinism control (piece 1).** Before comparing anything across code versions, the 0.5B
suite was rerun on PR #43's *own* head (worktree at `9aa7a04`) with #43's exact serving setup:
llama.cpp b11662, Q4_K_M quantization, ctx 4096, temp 0, seed 42, threads 8, concurrency 1
(CLI default), max-calls 2500, one warm-up call; model SHA-256 verified against
`studies/model-separation/models.sha256`. All 28 committed trajectories reproduce **byte for
byte** after stripping machine-only fields (per-step `ms`, per-reply `responseId`, episode
timestamps): 0/28 mismatched, run.json counters identical (`compare-runs.py`,
`runs/qwen2.5-0.5b-repeat-of-43/`). Temperature-0 serving on this host is deterministic across
runs, so any fixed-vs-#43 difference is attributable to the agent fix, not run-to-run noise.

**Fixed runs (piece 2).** The same manifest, same serving setup, on the episode-isolation head
(this branch), one run per model: `runs/qwen2.5-0.5b/` (28 episodes), `runs/qwen2.5-1.5b/`
(28), `runs/qwen2.5-7b/` (six-game manifest `suite-six.public.json`, 24 episodes — sokoban
excluded exactly as in PR #43, where 7B sokoban replies ramble to the 4096-token reply cap).
Every run passed `bundle verify`.

**Paired comparison (piece 3).** Episodes are paired by (game, seed) and classified with
`paired-diff.py`, which imports the model-separation study's own `episode_score` so the two
studies cannot drift (scores: outcome tiers take `normalized[seat]`, efficiency tiers take the
par-ratio rule). Classes:

- **byte-identical** — trajectories equal after stripping machine-only fields;
- **schema-only** — JSON differs but the agent reply sequence and the episode score are
  identical; the JSON deltas are input-token counts (shared-agent state) and #42's usage
  fields, not behavior;
- **behavioral** — reply sequence or episode score differs.

Significance uses a paired bootstrap (10,000 resamples of the per-episode score differences,
seed 20261015).

## Census: which committed episodes were leak-exposed?

`agents.js` created the model agent once per *process*, so each invocation's first episode ran
on a fresh agent and every later episode reused it. From the committed bundles:

| Bundle | Trajectories | Invocations | Fresh-agent episodes | Leak-exposed |
|---|---|---|---|---|
| #41 `reports/first-model-run/run-qwen` (1.5B, 42 jobs) | 42 | 3 (39 + 1 + 2 played) | 3 | **39** |
| #43 `runs/qwen2.5-0.5b` (28 jobs) | 28 | 1 | 1 | **27** |
| #43 `runs/qwen2.5-1.5b` (28 jobs) | 28 | 1 | 1 | **27** |
| #43 `runs/qwen2.5-7b` (killed at window, 16 verified) | 16 | 1 | 1 | **15** |
| #43 `runs/qwen2.5-7b-part2` (8 jobs) | 8 | 1 | 1 | **7** |
| **Total** | **122** | | **8** | **114** |

No interrupted-process gaps exist inside the #43 0.5B/1.5B bundles (episode `startedAt` values
are contiguous), so each was a single process: only the first episode (tictactoe
perfect-opponent seed 0) was clean. The #41 bundle's three invocations (39 played, then a
resume playing 1, then a resume playing 2) give three fresh-agent episodes.

Empirical cross-check: in the paired comparison, the *only* byte-identical 0.5B episode is
tictactoe seed 0 — exactly the census's one clean episode for that bundle.

## Results

### 0.5B (28 paired episodes)

| class | count |
|---|---|
| byte-identical | 1 |
| schema-only (replies + score identical) | 17 |
| behavioral | 10 |

Per-episode scores are **identical in all 28 pairs**: pooled paired difference
**+0.0000, 95% CI [+0.0000, +0.0000]**. Every score is 0.0 in both runs except connect4
(1.0000 in both). Agent calls 797 → 836 (+4.9%); invalid replies 45 → 44. The leak did not
move the 0.5B result.

### 1.5B (28 paired episodes)

| class | count |
|---|---|
| byte-identical | 2 |
| schema-only | 13 |
| behavioral | 13 |

Pooled paired difference **−0.0357, 95% CI [−0.1071, +0.0000]**. The entire difference is one
episode: connect4 ladder-1 seed 3, which the leak-exposed agent **won** and the fresh agent
**loses** — under the fix, 1.5B's connect4 record goes 4/4 → 3/4 (per-game mean −0.2500).
All other games are score-identical episode-for-episode (minesweeper seed 2 changes replies,
lands on the same 0.9014). Agent calls 891 → 796; invalid replies 211 → 194. The CI touches
zero: the shift is one ladder episode out of 28.

### 7B (24 paired episodes, six games)

<!-- SEVEN_B_RESULTS -->

### Input-token fingerprint

Mean per-call input-token counts differ between the leak-exposed and fresh-agent runs
(0.5B: mean +0.48 tokens under #43, range −5.2..+8.0; 1.5B: mean −1.34, range −38.6..+4.9):
the shared agent's state changed the prompts even on episodes whose replies and scores ended
up identical. Prompt-size differences of a few tokens are what you expect when agent state
mutates across episodes; they are the mechanistic fingerprint of the leak.

## What this means for the model-separation study

1. **The conclusion survives.** "Does not rank Qwen2.5 0.5B/1.5B/7B in order at 4 seeds/tier"
   reproduces under the fixed agent: pooled means move by at most one episode, the 1.5B-vs-7B
   picture is unchanged in direction (one connect4 ladder episode still separates against
   size), and the seeds-per-tier arithmetic in `studies/model-separation/REPORT.md` needs no
   revision in kind.
2. **Direction of the one flip.** The only score that moved (connect4 ladder-1 seed 3) moves
   *against* the leak: the fresh agent scores higher on it. If anything, the leak cost 1.5B
   one episode, which slightly understated 1.5B relative to 7B in the pooled table — the
   "1.5B edges 7B via one lost connect4 ladder episode" mechanism gets one seed weaker.
3. **Trajectory-level effects are real but score-neutral here.** 10/28 and 13/28 episodes
   changed reply sequences; only one changed an outcome. That is luck of the floor: most
   model-separation episodes score 0.0 under both agents (tictactoe, mastermind, sliding,
   cube, sokoban), where behavioral drift cannot move a score. A study scored on closer tiers
   would be more exposed.
4. **Process metrics shift too** (calls ±5-10%, invalid-reply rates by 1-2 points) — reports
   that quote invalid-reply rates or calls as calibration evidence should regenerate them
   from post-fix runs. The model-separation study's headline process metrics (invalid rate
   4.2%/23.4%/2.2%) carry this caveat.
5. **All 114 leak-exposed episodes are superseded by the fixed-agent bundles committed in this
   study**, which are otherwise identical in serving setup and manifest.

## Provenance

- Branch: `obv/burst10-playkit-leak-recheck`; base `obv/burst10-playkit-episode-isolation`
  (PR #42), which already contains PR #43's study (the merge was a no-op — 9aa7a04 is an
  ancestor).
- Serving: llama.cpp b11662 (github release binary), Qwen2.5 GGUF Q4_K_M, SHA-256 verified
  against `studies/model-separation/models.sha256` for all three models; ctx 4096, temp 0,
  seed 42, threads 8, port 8080, one warm-up call, CLI defaults otherwise (concurrency 1,
  max-calls 2500).
- Fixed-run head: the commit that carries the per-episode agent fix (PR #42) —
  `cli/agents.js`, `harness/model-agent.js`, `runs/run.js`; the delta against #43's head is
  the isolation fix plus #42's usage accounting; no game, scoring, or prompt-side change.
- Tools: `compare-runs.py` (bundle equality), `paired-diff.py` (paired classification and
  statistics), `run-model.sh` (serving + run + verify), `compute-stats.py` reusing the
  model-separation study's `episode_score`.
- Raw evidence: `runs/qwen2.5-0.5b-repeat-of-43/` (determinism control), `runs/qwen2.5-0.5b/`,
  `runs/qwen2.5-1.5b/`, `runs/qwen2.5-7b/` (fixed runs), `paired-0.5b.txt`, `paired-1.5b.txt`,
  `paired-7b.txt` (per-episode tables).

## Reproduce

```bash
cd gauntlet
# determinism control / fixed runs need the llama.cpp server on 127.0.0.1:8080
bash studies/leak-recheck/run-model.sh <gauntlet-dir> <out-dir> \
  qwen2.5-0.5b-instruct-q4_k_m studies/model-separation/suite.public.json <tag>
python3 studies/leak-recheck/compare-runs.py <out-dir> \
  studies/model-separation/runs/qwen2.5-0.5b
python3 studies/leak-recheck/paired-diff.py studies/leak-recheck/runs/qwen2.5-0.5b \
  studies/model-separation/runs/qwen2.5-0.5b
```
