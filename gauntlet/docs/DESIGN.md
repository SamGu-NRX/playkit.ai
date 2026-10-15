# PlayKit Gauntlet — design

Status: draft, 2026-10-15. Companion code lives on `obv/burst5-playkit-gauntlet-core`; the environment contract below (section 3) summarizes `gauntlet/core/types.js` on that branch, and this doc defers to the code wherever the two disagree. At the time of writing, the core branch had no open PR yet, so section 3 reflects the agreed contract rather than a read of the file; the core PR body and this doc must be reconciled when that PR lands.

**Load-bearing assumption.** Gauntlet's premise is that turn-based play of *known, popular* games with fixed rules — scored for both outcome and action efficiency — produces a benchmark signal that separates frontier agents from each other and from trivial baselines, and does not saturate quickly. No measured run exists yet, so this is unvalidated. It would be confirmed by model scores that sit clearly above the random/greedy baselines and clearly below engine ceilings, with spread across games. It would be broken by any of: scores clustering near a baseline (perception or formatting failures drowning out play quality), rapid saturation by a single frontier model, or seeds leaking into training data. Sections 7 and 8 are the mitigations; if a first measured run shows clustering, the fix is more smoke-testing of the official prompt, not a scoring change.

Readers: an engineer adding a game (sections 3, 4, 9 are yours), and a researcher deciding whether the scores mean anything (sections 1, 2, 5, 6, 7, 8 are yours).

## 1. What it measures, and what it does not

Gauntlet is a suite of difficult, popular games that AI agents play under fixed rules, measured the way ARC-AGI measures puzzle solving: every episode is seeded, replayable, and scored, and the headline number is a mean over a full manifest of episodes.

Because the games are known — chess, Minesweeper, 2048, and so on — prior knowledge is allowed. An agent that has read a chess book is not cheating; that is the point. This is the deliberate difference from ARC-AGI-3, whose environments are novel at evaluation time and measure whether an agent can *acquire* skill on unseen tasks. Gauntlet measures **play quality in known domains**: planning ahead, deductive inference, exploiting a forced win, adversarial play against an opponent under rules both sides know. It does not measure skill acquisition on novel tasks, it does not measure perception (observations are text, not pixels), and it does not measure real-time reaction (all games are turn-based).

Terms used throughout:

- **Game**: a rules engine with a spec (roster entry) and tiers.
- **Tier**: one difficulty level of a game, with a rank, a scoring kind, a seed set, and an action budget.
- **Seed**: a number that fully determines an episode's initial state, so episodes are reproducible.
- **Episode**: one agent playing one seed of one tier, from reset to outcome, recorded as a **trajectory** (the full action/observation log, verifiable by replay).
- **Par**: a reference action count for an episode — either **optimal** (computed by an exact solver) or **reference** (achieved by a fixed reference strategy), used to score efficiency.
- **Entry**: one agent (model + harness configuration) submitting scores for the whole suite.

## 2. Lessons from earlier benchmarks

Every source below was opened and read for this design; the URL is the citation, and all numbers are quoted from the source named in the row.

| Source | Finding (as stated in the source) | Design decision it led to |
|---|---|---|
| [ARC-AGI-2 paper](https://arxiv.org/abs/2505.11831) | Before test-time adaptation, ARC-AGI-1 SOTA "hovered around 34%"; o3 in private testing reached "76% (low-compute; estimated cost: $200 per task) and 88% (high-compute; estimated cost: $20,000 per task)" on the Semi-Private set. A 2020 meta-analysis found "49% of the Private Evaluation set was successfully solved by at least one team" via brute-force search. | Calibrate difficulty with a reference measure (our pars and engine ladders), not intuition; report cost next to score; remove instances solvable by brute force where an exact solver exists (forced-win positions get par-based scoring so the efficient win beats the long one). |
| [ARC-AGI-2 site](https://arcprize.org/arc-agi/2) | Eval sets are "calibrated" (120 tasks each, public / semi-private / private), "all tasks solved pass@2 by at least two humans"; cost is the efficiency metric "because it is the most directly comparable between human and AI performance". | Human-verify solvability of every seed before it ships; require entries to cover the whole manifest before they are ranked; publish USD cost alongside every score. |
| [ARC-AGI-3 technical report](https://arcprize.org/media/ARC_AGI_3_Technical_Report.pdf) | Scoring is RHAE: per level, `S = min(1.15, (h/a)^2)` where `a` is the agent's action count and `h` the human baseline; levels weighted by index (`w_l = l`); action budget "five times the human-baseline median action count per level". | Adopted the squared-ratio efficiency form with a cap (section 5), rank-weighted tier aggregation, and the 5×par budget rule (section 8). |
| ARC-AGI-3 technical report (sets) | Private set is split into a "semi-private set" (external API testing, small leakage risk) and a "fully private set" for competition; the public set is "strictly … a demonstration" and is never reported on the official leaderboard. | Public seeds in-repo for development; eval seeds kept secret behind a published SHA-256 commitment (section 7). |
| ARC-AGI-3 technical report (harnesses) | The official leaderboard "will not use a harness"; all runs share one system prompt; hand-built harnesses score bimodally across environments — "in a variant of environment TR87, Opus 4.6 scores 0.0% with no harness and 97.1% with the Duke harness … yet in environment BP35, Opus 4.6 scores 0.0% under both configurations". Harness results go to a self-reported community leaderboard the foundation "will not verify". | The official track fixes the system prompt, forbids tools, and carries the previous reply forward (section 6); harness-driven results land in a separate community table, self-reported. |
| [BALROG](https://arxiv.org/abs/2411.13543) | Uses "fine-grained metrics to measure performance" (progression, not just win/loss); "several models perform worse when visual representations of the environments are provided". | Score partial progress (efficiency tiers, forced-win length), not just outcomes; official-track observations are text, so perception skill is not a confound. |
| [GameArena](https://arxiv.org/abs/2412.06394) | Collected "over 2000 game sessions"; prompt bias was reduced by "five optimized system prompts using DSPy" randomly assigned per session; ">85% of game sessions from [GameArena] contain[ed] useful data" vs "less than 5%" of Chatbot Arena sessions yielding meaningful votes. | Prompt variance is a real error source: the official track pins one fixed system prompt and puts the rules text in every episode, so nothing depends on the model's phrasing luck. |
| [TextArena](https://arxiv.org/abs/2504.11442) | "57+ unique environments" (74 as of publication) with "real-time TrueSkill™ scores" from live play. | We keep absolute, seed-fixed scores instead of a relative rating: relative skill has no saturation ceiling but is not replayable or auditable, and it measures the opponent pool as much as the agent. We do copy the breadth lesson — the suite spans many reasoning types (section 4) — and duplicate deals for two-seat variance reduction. |
| [VideoGameBench](https://arxiv.org/abs/2505.18134) | "Inference latency [is] a major limitation of frontier models in the real-time setting"; best models complete "only 0.48% of VideoGameBench and 1.6% of VideoGameBench Lite" (Lite pauses the game during inference). | Turn-based games only, so latency never enters the measurement. The paused-Lite result shows that removing real-time pressure reveals planning ability; that is the regime Gauntlet measures. |
| [lmgame-Bench](https://arxiv.org/abs/2505.15146) | Dropping LLMs into games directly fails for "three reasons: brittle vision perception, prompt sensitivity, and potential data contamination". | Same three mitigations, each made structural: text observations, a pinned prompt, and contamination-controlled splits (section 7). |
| [Kaggle Game Arena](https://blog.google/technology/ai/kaggle-game-arena/) | "Game harnesses … as well as the game environments are all open-sourced"; final rankings come from an all-play-all system running "over a hundred matches between every pair of models". | Open-source the runner, harness, and public seeds so anyone can reproduce an episode; use many seeds per tier in place of many matches per pair. |
| Note: [VGBench](https://arxiv.org/abs/2407.10972) is a *vector-graphics* benchmark (4,279 understanding + 5,845 generation samples over SVG/TikZ/Graphviz), not a game benchmark. It predates the similar-sounding VideoGameBench and will surface in searches for "VGBench"; it has no influence on this design. | | |

## 3. Environment contract

Normative source: `gauntlet/core/types.js` on the core branch (see the status note above). Summary for reviewers; the code is the contract.

A game is a set of **pure functions over a JSON-serializable state**. No clocks, no I/O, no global mutable state — every function takes state (and inputs) and returns new data, which is what makes trajectories replayable and verifiable.

- `reset(tier, seed)` → the initial state for that tier and seed.
- `toAct(state)` → the seat whose turn it is.
- `observe(state, seat)` → that seat's observation: full state minus hidden information (other seats' cards, hidden mines). The official track shows the agent exactly this text.
- `legalActions(state)` → canonical action strings (the agent must answer with one of these).
- `parseAction(state, replyText)` → extracts the action from a model reply: the runner takes the action from the reply's **last line** and matches it against `legalActions`.
- `step(state, action)` → the next state.
- `outcome(state)` → per-seat results, each carrying a `normalized` score in [0, 1].
- `truncate(state)` → true when the episode must end without a decisive outcome (budget or move cap reached); truncated episodes score 0 on outcome tiers and are unsolved on efficiency tiers.
- `opponent(state)` → for two-seat games, the built-in opponent (engine) and its policy; one-seat games omit it.

Tiers carry: a **rank** (difficulty weight, section 5), a **scoring kind** (`outcome` or `efficiency`), an **action budget** (`maxActions`), and — for efficiency tiers — a **par** and its `parKind` (`optimal` or `reference`).

The runner enforces the interaction loop: one model call per action; **invalid attempts count toward the action budget** (an invalid action consumes the call, is logged, and the same state is re-presented); **three consecutive invalid actions forfeit the episode** (score 0).

Every episode produces a trajectory — the seeded initial state, every observation, every raw reply, every parsed action, and the final outcome — such that replaying the actions through the pure functions reproduces the outcome exactly; `verifyTrajectory(trajectory)` does this check and must pass for an entry to be ranked (section 5).

## 4. Game roster

Legend: info = perfect / imperfect; seats = number of decision-making seats (the agent plus built-in opponents); horizon = typical agent actions per episode; reasoning = the dominant faculty the game isolates.

| Game | Info | Chance | Seats | Horizon | Reasoning | Tiers (rank) | Why it is hard for models |
|---|---|---|---|---|---|---|---|
| Tic-tac-toe | perfect | none | 2 | ≤ 9 | adversarial | outcome (1) — smoke test only, `benchmark: false` | It isn't; that is its job. Verifies plumbing: parsing, trajectory replay, forfeit rules. |
| Chess vs built-in engine ladder | perfect | none | 2 | long | adversarial planning | three ladder rungs, outcome (1, 2, 4) | Long-horizon tactical calculation without search tools; models blunder pieces under the pinned prompt. |
| Chess vs Stockfish by node budget | perfect | none | 2 | long | adversarial planning | three node budgets, outcome (1, 2, 4) — optional, ships only where the Stockfish binary is present | Same, with a principled opponent-strength dial (nodes) instead of hand-tuned depth. |
| Lichess chess puzzles (rating bands) | perfect | none | 1 (agent plays the winning side) | ≤ 12 moves | tactical deduction | three rating bands, outcome (1, 2, 3) | Finding the only winning continuation, every move a forced sequence; public data, so memorization is the threat (section 7). |
| Minesweeper (no-guess boards) | imperfect (hidden mines) | none at decision time (boards guaranteed solvable without guessing) | 1 | ≈ board cells | deductive constraint solving | 9×9 (1), 16×16 (2), 12×12 torus wraparound variant (3), outcome | Requiring no-guess boards makes it pure deduction; the torus variant breaks edge-of-board priors memorized from training data. |
| 2048 | perfect | spawn randomness | 1 | hundreds | long-horizon planning under chance | outcome: tile ≥ 1024 (1); efficiency vs reference par (2) | Scoring is open-ended efficiency — survival moves vs the reference solver's move count — so there is no "win", only better play. |
| Sliding 8- and 15-puzzle | perfect | none | 1 | ≤ 31 (8-puzzle worst case), larger for 15 | optimal planning | 8-puzzle (1), 15-puzzle (3), efficiency with optimal par | Optimal par punishes solvers that reach the goal slowly; the 15-puzzle horizon defeats unaided lookahead. |
| Sokoban | perfect | none | 1 | tens | planning with deadlock avoidance | two level sets, efficiency with optimal par (1, 3) | Irreversible mistakes (deadlocks) end the episode; optimal par rewards planning over trial and error. |
| Connect Four | perfect | none | 2 | ≤ 42 | adversarial + deduction | engine ladder (2); forced-win positions, efficiency with optimal par = winning-line length (3) | Forced-win positions isolate whether the agent can *prove* and *efficiently execute* a win it is told exists. |
| Mastermind | imperfect (hidden code) | fixed hidden code per seed | 1 | ≤ 8 guesses | information-gain deduction | classic 4-peg/6-color, efficiency with reference-strategy par (2) | Each guess is an experiment; par is set by a reference information-theoretic strategy, so guessing patterns is measurable. |
| Heads-up limit Texas hold'em | imperfect | card deal | 2 | tens of acts per hand | decision-making under uncertainty | duplicate matches, outcome (3) | Opponent modeling and variance control; duplicate deals (same cards both ways) cancel luck, isolating play quality. |

All games except tic-tac-toe have `spec.benchmark: true` and enter the benchmark score B. The Stockfish tiers are marked optional in the manifest: on a machine without the binary they are skipped, and an entry is ranked against the manifest *as shipped for that run* (the manifest records which optional tiers were included).

## 5. Scoring

These rules are the specification; the runner implements them literally.

- **Episode score e.** On an outcome tier, `e = outcome.normalized[agentSeat]`. On an efficiency tier, `e = solved ? min(cap, (par / agentActions)^2) : 0`, where `agentActions` counts every attempt including invalid ones, and `cap` is 1.0 when `parKind` is `"optimal"` and 1.15 when it is `"reference"`. (ARC-AGI-3's RHAE squares the ratio and caps it at 1.15 — see section 2.)
- **Tier score T.** The mean of `e` over the tier's seeds. On an efficiency tier, `T = min(solvedFraction, mean e)` — inefficiency cannot outscore solving.
- **Game score G.** `G = sum(rank_t * T_t) / sum(rank_t)` over the game's tiers, so harder tiers weigh more. (ARC-AGI-3 weights level l by l.)
- **Benchmark score B.** The unweighted mean of `G` over the suite's games whose `spec.benchmark` is true.
- **Uncertainty.** Percentile bootstrap 95% intervals from 10,000 seeded resamples of episodes within each tier, carried to `G` and `B` by resampling every tier together (one joint resample per draw preserves within-entry tier correlation).
- **Ranking eligibility.** An entry is ranked only if it covers every game, tier and seed in the suite manifest, every trajectory passes `verifyTrajectory`, and none is a dry run. Cost — the sum of `usage.costUsd`, or `"unknown"` if any step's cost is null — is reported next to the score, as the ARC Prize leaderboard does.

What a researcher should take from this: `e` rewards efficient success and cannot be gamed by padding; `T` punishes failing seeds twice on efficiency tiers (once in the mean, once via `solvedFraction`); `G` lets a game be hard but legible (a weak tier can't hide behind a strong one); `B` treats games as equally important so a model that is a chess specialist but a Minesweeper disaster cannot top the table. The bootstrap interval is over seeds, the only sampling unit — it does not cover prompt-seed sensitivity, which the fixed official prompt bounds by construction (section 6).

## 6. Tracks

Three tracks, one leaderboard each, no mixing.

- **Official.** Fixed system prompt (adapted from ARC-AGI-3's official leaderboard), the game's rules text and the observation text only, no tools, and the previous reply carried forward in full each turn. Nothing else may be conditioned on the game beyond what every entry gets identically. The system prompt is versioned in the repo; a prompt change bumps the manifest version and old entries are marked as scored under the previous prompt.
- **Community.** Any harness — memory, retrieval, search tools, game-specific scaffolding — self-reported, in a separate table, never merged into the official ranking. This follows ARC-AGI-3's finding that harness results do not transfer across environments and its separation of harness research onto an unverified community leaderboard. Harness authors are encouraged to publish their trajectories for spot-verification.
- **Baseline.** Random, greedy, and engine agents run by the repo on every release. These are the floor and the sanity check: if a frontier model scores below greedy on a game, the game's observation format is suspect before the model is.

## 7. Splits and contamination

- **Public seeds** live in the repo, per tier, for development and harness work. Public-seed scores are demonstration only and never ranked, mirroring ARC-AGI-3's treatment of its public set.
- **Eval seeds** are drawn from a secret salt; the repo publishes a SHA-256 commitment to (salt, manifest version) — and, at release, the derived seed list's hash — so the split is auditable after the fact but unknowable before. Scores that count toward B come from eval seeds only.
- **Lichess puzzles are public data and may be memorized.** The eval sample is therefore drawn at run time from the current CC0 database within the tier's rating band, and the puzzle IDs seen are recorded in the manifest. A model can train on every puzzle that exists today; the measured question is whether it solves *drawn-at-run-time* puzzles, which turns memorization into a distribution-level property rather than a seed-level leak.
- **Procedurally generated instances** (Minesweeper, 2048, sliding puzzle, Sokoban, Mastermind) cannot be memorized: a seed names an instance that did not exist until generated, so contamination can only affect *strategy*, which is exactly what the benchmark is allowed to reward.

## 8. Budgets and cost

**Action budgets.** Where a par exists, `maxActions = 5 × par` — the same 5× allowance ARC-AGI-3 grants over the human median. Outcome tiers without a par get a manifest `maxActions`. Initial manifest values (proposals, tunable before the first measured run):

| Tier | maxActions | Basis |
|---|---|---|
| Tic-tac-toe | 9 | board is 9 cells; forfeit rules still apply |
| Chess (all tiers) | 200 | agent actions; engine replies do not consume the budget |
| Lichess puzzles | 2 × solution length | slack for an unnecessary but non-losing move |
| Minesweeper | board cell count (81 / 256 / 144) | each action reveals or flags one cell |
| 2048 | 5 × reference par | efficiency rule |
| Sliding puzzle | 5 × optimal par | efficiency rule |
| Sokoban | 5 × optimal par | efficiency rule |
| Connect Four | 42 | board holds 42 pieces |
| Mastermind | 5 × reference par | efficiency rule |
| Hold'em | 64 acts per hand | limit betting tree caps a hand well below this |

**Model calls per episode (estimate — no measured run exists; this is arithmetic from `maxActions`, not observation).** One model call is consumed per action attempt, including invalid ones, so estimated calls per episode ≈ `maxActions`, and fewer when the episode ends early. Engine opponents (chess ladder, Stockfish, Connect Four ladder, hold'em dealer policies) consume no calls. The expensive tiers by this estimate are the efficiency tiers with large pars (2048, Sokoban, 15-puzzle), where 5×par lands in the hundreds to low thousands of calls per episode. A full-manifest entry run is bounded by the sum over all tiers and seeds; the runner enforces a per-entry wall-clock ceiling (value: open question, section 11). Cost in USD is reported per section 5 regardless, so budget risk is visible per entry rather than assumed.

## 9. Licensing

- **chess.js** (BSD-2-Clause) is a normal dependency of the runner — permissive, no obligations beyond its notice.
- **Stockfish** is GPL-3.0. It is run as a **separate program** invoked by the optional Stockfish tiers and is **never bundled, linked, or copied into the repo**; the runner talks to it over its UCI-style interface as an external process. Distribution of Gauntlet does not include Stockfish; users install their own binary. This keeps the GPL out of the Apache-2.0-licensed repo.
- **Lichess puzzle database** is CC0 (public domain dedication); puzzles are used as data with no restrictions beyond recording provenance in the manifest.
- **Why not python-chess:** it is GPL-3.0, and this repo is Apache-2.0; shipping it as a dependency would impose GPL terms on the combined work. The runner is JavaScript and uses chess.js for move generation anyway. Python agents connect through the stdio protocol (the runner speaks JSON over stdin/stdout to any agent process), so a Python agent may use python-chess *on its own side of the protocol* freely — the GPL never enters this codebase.

## 10. Bridge to the overlay

The 2048 bridge is the proof that Gauntlet agents and the PlayKit overlay are the same runtime story: the Gauntlet 2048 rules engine acts as the **referee** — the authoritative state that the trajectory is verified against — while a live page (`play2048.co` or equivalent) displays the game. The overlay's existing adapter reads the board from the DOM into the referee, the driver dispatches the Gauntlet agent's chosen move back to the page, and the referee validates every transition. If the page ever disagrees with the referee, the episode is marked invalid rather than silently reconciled. This keeps the agent's play measurable (the referee, not the DOM, is the source of truth) while exercising the real integration path the overlay ships to users.

## 11. Open questions for Sam

1. **Seed counts per tier.** The bootstrap needs enough seeds per tier to be informative; we propose 25 public + 25 eval per tier, but the full-manifest cost scales with this. Is the budget there for 25, or should v1 start at 10?
2. **Engine ladder calibration.** Which strengths for the chess and Connect Four ladders — chess.js search depths (fast, weak-ish) versus fixed Elo targets (legible, needs calibration matches)? Calibrated Elo targets cost setup time we have not budgeted.
3. **Stockfish tiers in v1?** The optional-gating handles machines without the binary, but ranking comparability across runs weakens if the optional tiers drop in and out. Ship them in v1 or defer to v1.1?
4. **2048 reference par.** Which solver run defines "reference" — the repo's expectimax at what think time? It must be pinned in the manifest or `par` drifts with hardware.
5. **Hold'em in v1?** Duplicate matches control variance but double episode count, and outcome scoring on poker is noisy even duplicated. Defer to v2, or in at reduced match count?
6. **Official track and built-in tools.** Some frontier models cannot fully disable built-in browsing/code execution. ARC-AGI-3's position is that models "will not be given tools" but their own internals are their own. We adopt the same stance; confirm you're comfortable ranking entries whose internal tool use we cannot observe or price.
7. **Per-entry spend ceiling.** Section 8 reports cost but caps nothing. Should the official track refuse entries above a USD ceiling per full run, and at what number?
8. **Community trajectory uploads.** Optional or required for a community-table listing? Required would make the community table the only self-reported-but-verifiable one in the space; it also raises the contribution bar.
