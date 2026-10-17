# PREREGISTRATION — example-confound study

Study: how much of the model-separation evidence comes from models **copying the
example action in a game's prompt** rather than playing the game?

Written and committed **before the first model run of this study** (git history
is the proof: this file's commit precedes every commit that contains bundles
under `runs/`). Serve method, models, seeds, arms and analysis are pinned here
and are not changed after runs start. Deviations, if any, are listed in
REPORT.md under "Deviations", never silently.

## Evidence being re-tested

All numbers below were read from the committed `stats.json` of the named merged
studies (not re-measured for this preregistration):

- **#81** (`studies/model-separation-v2/solo/stats.json`), mastermind/mini,
  official track: 0.5B mean 0, invalid-reply rate 1.000, n=8; 1.5B mean 0,
  invalid-reply rate 0.454545, n=8; 7B mean 0.5 (CI [0, 1]), invalid-reply rate
  0.018519, n=4. Random baseline 0.029847 (25 episodes, calibration table).
  Mastermind/mini is the tier where invalid replies "separate" the models and
  the only tier where 7B's mean beats random's.
- **#97** (`studies/assisted-harness/solo/stats.json`), mastermind/mini,
  assisted (community track, legal actions + 2 retries): 0.5B invalid-reply
  1.000 -> 1.000 (worse-or-equal), 1.5B 0.454545 -> 1.000 (WORSE — emits
  syntactically perfect `ACTION: guess ABCD` whose guess is the wrong length
  for a 3-peg tier); 7B invalid 0.018519 -> 0 and mean 0.5 unchanged.
- **#92** (`studies/model-separation-v2/versus/stats.json`), connect4/ladder-1,
  official track: 0.5B mean 0.916667 (CI [0.75, 1]), the only tier in that
  study that clears random — and the ordering is inverted (1.5B 0.75, 7B 0.75).
  Random 0.416667 (CI [0.166667, 0.666667]), n=12 per model. In all 12 of
  0.5B's committed ladder-1 games the model plays column 4 on every move.

## The confound mechanism

The observation the model reads on mastermind/mini carries a **4-letter
example on a 3-peg tier**, and connect4's rules carry a worked column-4 example
while ladder-1's random opponent never blocks the stack:

- mastermind observation (`games/mastermind/index.js:205`):
  `Action format: "guess" followed by the code letters, e.g. "guess ABAB".`
- mastermind rules (`games/mastermind/index.js:146`):
  `Action grammar: "guess" followed by the code in color letters, e.g. "guess ABCB" for a 4-peg tier.`
- mastermind empty-action feedback (`games/mastermind/index.js:291`):
  `empty action; use "guess" followed by the code letters, e.g. "guess ABAB"`
- connect4 rules (`games/connect4/index.js:170`):
  `the column number alone, e.g. "4" drops into column 4. Documented alternates: "column 4", "col 4", "play 4", "drop 4", "place 4", "move 4", uppercase letters, surrounding quotes or backticks, and surrounding whitespace are all accepted.`
- connect4 parse-error feedback (`games/connect4/index.js:328`):
  `use the column number 1-7, e.g. "4" or "column 4"`

(The unparseable-guess feedback on mastermind is already correct-length on mini
— the game echoes `ABCD.slice(0, pegs)` = `ABC` — so it needs no patch.)

**Scope note (preregistered deviation from the packet's literal replacement
list):** the packet names only the mastermind observation line. H1 is about "a
correct-length example", which cannot hold while the rules still show a 4-peg
example and the empty-action feedback still echoes a 4-letter one, so this
study patches all three wrong-length example surfaces on mastermind/mini. The
connect4 patches are exactly the packet's. All patches change **only example
text the model reads**; the referee, observation hash and trajectory are
untouched, and every bundle verifies with `gauntlet bundle verify`.

## Correction before the first model run (2026-10-17)

Committed before any bundle existed — git history is the proof: this correction
commit precedes every commit containing model runs. While writing the wrapper's
episode test, which plays a real episode through the wrapper and asserts every
preregistered replacement applies exactly once, the third mastermind patch
refused to apply: its target never reached the model.

Cause, from the runner source: `core/runner.js` `extractAction` takes the last
non-empty line of a reply and returns null when there is none, so an empty reply
is judged by `judgeReply` as `no action found in reply` — the game's own
`empty action; use "guess" followed by the code letters, e.g. "guess ABAB"`
(`games/mastermind/index.js:291`) is never called on that path. The string is
unreachable through the runner: there is no 4-letter example to retire from the
feedback surface.

Correction: the mastermind patch set is the observation and rules replacements
(two patches); the empty-action feedback patch is retired. H1 is unaffected and
the design is cleaner: after correcting rules and observation, no wrong-length
example reaches the model on any invalid-reply turn — the empty-reply feedback
carries no example at all, and the unparseable-guess feedback already carries a
correct-length one (`guess ABC`, the game echoes `ABCD.slice(0, pegs)`). The
connect4 patches are unchanged. Everything else in this preregistration is
unchanged.

## Hypotheses

- **H1** With a correct-length example, the 0.5B and 1.5B invalid-reply rates
  on mastermind/mini fall.
  - Arm 1 (corrected, official prompt otherwise) vs #81's official bundles,
    and arm 2 (corrected, inside the assisted wrapper) vs #97's assisted
    bundles, paired by seed.
- **H2** With the format fixed, mastermind/mini means order by size
  (0.5B < 1.5B < 7B) in the corrected official-prompt arm.
- **H3** With no column number to copy, 0.5B's connect4/ladder-1 win rate
  falls toward random's 0.416667.

## Statistic (pinned)

The same statistic #81 used: **paired-by-seed differences with a seeded
10,000-draw percentile bootstrap** (`core/rng.js` `streamFromSeed`; the
episode-wise transform is applied first, then the difference, then the
bootstrap — no timestamps anywhere). Per-arm means and CIs come from the
official scorer (`scoring/score.js`), whose own bootstrap CI is seeded from the
suite id, so `stats.json` is byte-for-byte reproducible via `reproduce.sh`.
Comparisons of an arm against an uncorrected study pair the committed bundles
of that study with this study's bundles by seed (same public seeds, same pinned
serve method, same models). Spearman rho for H2 is the tie-corrected rho over
the three per-model means, as in #81.

## Arms

Serve method (pinned, identical to #81/#97/#92): llama.cpp **b11662**,
`--ctx-size 4096 --temp 0.0 --seed 42 --threads 8`, one warm-up call, models
are the Qwen2.5-Instruct Q4_K_M GGUFs from `studies/model-separation-v2`'s
manifest, replay cap 256 output tokens, call timeout 60 s, concurrency 1.

1. **mastermind/mini, corrected example, official prompt otherwise** — 0.5B and
   1.5B, the 8 public seeds (#81's seed set). Community track (the prompt
   differs from the official one, so results self-report to the community
   table by construction).
2. **the same inside `community/assisted-agent.js` with retries=2** — 0.5B and
   1.5B, the same 8 seeds; compared against #97's assisted bundles.
3. **7B, corrected example, official prompt otherwise** — all 8 public seeds
   (#81 ran 4); compared against #81's 4-seed 7B bundles paired by seed, and
   reported at both n=4 (paired) and n=8 (mean).
4. **connect4/ladder-1, neutral rules text** — 0.5B and 1.5B on #92's 12
   public seeds; **7B only if time remains** (drop order if time runs short:
   arm 4's 7B first, then arm 3's extra seeds 4–7; any drop is reported).

The **uncorrected arms are not rerun**: they are #81's, #97's and #92's
committed bundles, read from `studies/model-separation-v2/solo/runs/`,
`studies/assisted-harness/solo/runs/` and `studies/model-separation-v2/versus/runs/`.

## Exact replacements (pinned)

Patch set `mastermind-mini-corrected` (applies to game `mastermind`, tier
`mini` only):

1. observation: `Action format: "guess" followed by the code letters, e.g. "guess ABAB".`
   -> `Action format: "guess" followed by 3 code letters, e.g. "guess ABA".`
2. rules: `Action grammar: "guess" followed by the code in color letters, e.g. "guess ABCB" for a 4-peg tier.`
   -> `Action grammar: "guess" followed by the code in color letters, e.g. "guess ABA" for a 3-peg tier.`
3. ~~feedback: `empty action; use "guess" followed by the code letters, e.g. "guess ABAB"`
   -> `empty action; use "guess" followed by the code letters, e.g. "guess ABA"`~~
   RETIRED pre-run — see "Correction before the first model run (2026-10-17)"
   below: the target string is unreachable through the runner, so the model can
   never see it.

Patch set `connect4-ladder-1-neutral` (applies to game `connect4`; the study
runs tier `ladder-1`):

4. rules: `the column number alone, e.g. "4" drops into column 4. Documented alternates: "column 4", "col 4", "play 4", "drop 4", "place 4", "move 4", uppercase`
   -> `the column number alone, 1 to 7. Documented alternates: "column N", "col N", "play N", "drop N", "place N", "move N" for a column number N, uppercase`
5. feedback: `use the column number 1-7, e.g. "4" or "column 4"` -> `use the column number 1-7`

Every replacement must apply exactly once per turn it is applicable; a missing
target string is an error naming the game and the string, never a silent
pass-through. Each applied change is recorded in the reply's `meta`
(`meta.examplePatch`), and `meta` never alters what the referee sees.

## What each outcome would mean (pinned before runs)

| Outcome | Meaning for the separation question |
| --- | --- |
| H1 **yes** (invalid rates fall) | The mastermind/mini invalid-reply "separation" #81 used as a discriminator is substantially a prompt-example artifact: small models copy the 4-letter example. The floor-profile decision (#36) and any size claim must be re-read on corrected prompts; the 1.5B assisted collapse (#97) was copying under a format instruction, not reasoning failure. |
| H1 **no** (invalid rates unchanged) | Wrong-length examples are not the driver: the floor is behavioral (format-insensitive), consistent with #97's finding that assistance does not rescue these models; the example-confound explanation is rejected for mastermind. |
| H2 **yes** (means order by size on corrected prompts) | Size ordering survives once the format trap is removed — evidence of real (if weak) discrimination, strengthening the case that mastermind/mini can separate models when prompts are honest. |
| H2 **no** (no size ordering) | Even with corrected examples there is no size separation on mini — consistent with #81/#97's above-random NO; the tier's apparent separation was invalid-reply rate, which H1 separately explains. |
| H3 **yes** (0.5B falls toward random) | The only above-random result in the small-model record (#92) was example-copying (column 4 every move): the "inverted ordering" dissolves, and the small-model picture becomes uniformly at-or-below random. |
| H3 **no** (0.5B stays above random) | 0.5B's ladder-1 edge survives prompt correction — the strongest candidate for genuine small-model play; re-examine the column-4 claim on the corrected bundles before dismissing it. |

"Not resolved at this n" is an allowed verdict per hypothesis; REPORT.md states
which verdict each hypothesis earned, with the interval that justifies it.

## Decision dependencies (unchanged, reported side by side if hit)

Sam has not decided: the floor profile (#36), whether invalid replies count
against a score in win/lose games, the pilot budget and cap, tic-tac-toe's
scored status, CI for `gauntlet/`, or the 2048 helper publication. This study
changes none of them; where a number would move under a pending decision,
REPORT.md shows the options side by side.
