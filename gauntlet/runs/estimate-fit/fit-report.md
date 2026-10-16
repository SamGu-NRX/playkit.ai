# Estimator fit — method and hold-out error

Data: 239 committed real-model episodes, 7884 agent calls, sources: first-model-run, board-v2, model-separation-0.5b, model-separation-1.5b, model-separation-7b, model-separation-7b-part2, leak-recheck-0.5b, leak-recheck-1.5b, leak-recheck-7b. Every call's token counts are the provider's recorded usage; prompt sizes are reconstructed by replaying each trajectory against the current game specs (hash-verified prefix; 91% of calls verified).

## What the fit changes

The old estimator guessed a weak model's episode length from the game's own engine baseline (which plays well and finishes fast or slow for reasons unrelated to a model that forfeits or flails) and priced tokens at 4 characters per token along that baseline episode. The fit replaces both assumptions with the runs' measured per-call usage and per-episode call counts, and keeps the tier budget as the worst case.

## Hold-out error (leave-one-model-out), per game

For each model, the fit is rebuilt without that model's episodes and applied to them. Ratios are predicted/measured, episode-weighted geometric means over the game's tiers; 1.0 is perfect. `—` = no basis (the old estimator had no low basis for the game, or the tier has no fitted episodes outside the held-out model).

### Held out: qwen0.5b

| game | eps | calls before | calls after | in-tokens before | in-tokens after |
|---|---:|---:|---:|---:|---:|
| connect4 | 8 | 2.133× | 1.229× | 0.854× | 0.996× |
| cube | 8 | — | 1× | 0.867× | 1× |
| mastermind | 8 | — | 4.813× | — | 1.209× |
| minesweeper | 8 | — | 2.685× | — | 1.098× |
| sliding | 8 | — | 0.321× | 0.979× | 1× |
| sokoban | 8 | — | 15× | 1.027× | 1.008× |
| tictactoe | 8 | 1.379× | 0.75× | 0.807× | 0.992× |

### Held out: qwen1.5b

| game | eps | calls before | calls after | in-tokens before | in-tokens after |
|---|---:|---:|---:|---:|---:|
| 2048 | 8 | — | — | — | — |
| chess | 8 | 11.963× | — | 0.696× | — |
| chess-endgames | 8 | 0.175× | — | 0.695× | — |
| chess-puzzles | 6 | — | — | — | — |
| chess-stockfish | 9 | 15.486× | — | 0.843× | — |
| connect4 | 18 | 2.889× | 0.944× | 0.857× | 1.002× |
| cube | 14 | — | 1× | 0.867× | 1× |
| holdem | 6 | 1.462× | — | 0.893× | — |
| mastermind | 14 | — | 1.37× | — | 1.111× |
| minesweeper | 16 | — | 0.28× | — | 0.883× |
| sliding | 16 | — | 20.395× | 0.936× | 0.986× |
| sokoban | 14 | — | 0.067× | 1.023× | 0.992× |
| tictactoe | 10 | 1.852× | 1.181× | 0.815× | 1.006× |

### Held out: qwen7b

| game | eps | calls before | calls after | in-tokens before | in-tokens after |
|---|---:|---:|---:|---:|---:|
| connect4 | 8 | 1.684× | 0.878× | 0.858× | 1.002× |
| cube | 4 | — | 1× | 0.867× | 1× |
| mastermind | 8 | — | 0.294× | — | 0.859× |
| minesweeper | 4 | — | 2.702× | — | 1.158× |
| sliding | 4 | — | 0.472× | 0.98× | 1.002× |
| tictactoe | 8 | 1.818× | 1.131× | 0.813× | 1.003× |

## Within-2x verdict

The acceptance criterion: an estimate right within 2x of a held-out real run. Per game, the worst fold-change (max of r and 1/r) of the leave-one-model-out ratios across the models with data. `n/a` = the game has no cross-model episodes, so only its same-model run-to-run spread exists to check (see the hold-out tables) — those games are not verified across models and their worst case is the tier budget.

| game | models | in-tokens worst | tokens within 2x | calls worst | calls within 2x |
|---|---:|---:|---|---:|---|
| 2048 | 0 | — | n/a | — | n/a |
| chess | 0 | — | n/a | — | n/a |
| chess-endgames | 0 | — | n/a | — | n/a |
| chess-puzzles | 0 | — | n/a | — | n/a |
| chess-stockfish | 0 | — | n/a | — | n/a |
| connect4 | 3 | 1× | yes | 1.23× | yes |
| cube | 3 | 1× | yes | 1× | yes |
| holdem | 0 | — | n/a | — | n/a |
| mastermind | 3 | 1.21× | yes | 4.81× | no |
| minesweeper | 3 | 1.16× | yes | 3.57× | no |
| sliding | 3 | 1.01× | yes | 20.4× | no |
| sokoban | 2 | 1.01× | yes | 15× | no |
| tictactoe | 3 | 1.01× | yes | 1.33× | yes |

## Input tokens as a function of prompt size

Per game, least squares of the calls' recorded input tokens on the reconstructed official prompt characters (hash-verified calls only). The old estimator assumed the tokenizer splits prompts at 4 characters per token; the fitted ratio is what these models actually saw.

| game | calls | tokens/char | intercept | r² | implied chars/token |
|---|---:|---:|---:|---:|---:|
| 2048 | 1101 | 0.29495 | 13.2 | 0.382 | 3.39 |
| chess | 30 | 0.52867 | -246 | 0.884 | 1.89 |
| chess-endgames | 99 | 0.6289 | -513.5 | 0.896 | 1.59 |
| chess-puzzles | 13 | 0.6164 | -978 | 0.93 | 1.62 |
| chess-stockfish | 49 | 0.48585 | -257.3 | 0.86 | 2.06 |
| connect4 | 142 | 0.23569 | 84.9 | 0.805 | 4.24 |
| cube | 0 | — | — | — | too few hash-verified calls for a fit |
| holdem | 700 | 0.36035 | -264.6 | 0.999 | 2.78 |
| mastermind | 302 | 0.42867 | -325.4 | 0.99 | 2.33 |
| minesweeper | 186 | 0.64538 | -856.4 | 0.966 | 1.55 |
| sliding | 2039 | 0.36659 | -228.8 | 0.822 | 2.73 |
| sokoban | 2430 | 0.23385 | 16.5 | 0.953 | 4.28 |
| tictactoe | 75 | 0.21816 | 90.2 | 0.672 | 4.58 |

## Fitted tiers

| game/tier | eps | models | calls expected | calls cap | in exp | in worst | out exp | out worst | invalid | budget-bound |
|---|---:|---|---:|---:|---:|---:|---:|---:|---:|---|
| 2048/t1024 | 2 | qwen1.5b | 203 | 1200 | 562 | 584 | 2 | 2 | 0.7% | no |
| 2048/t2048 | 2 | qwen1.5b | 119.5 | 2400 | 558.1 | 576 | 2 | 2 | 3.4% | no |
| 2048/t256 | 2 | qwen1.5b | 130 | 300 | 558.6 | 576 | 2 | 2 | 1.1% | no |
| 2048/t512 | 2 | qwen1.5b | 98 | 600 | 556.1 | 572 | 2 | 2 | 1.5% | no |
| chess-endgames/kbbk | 2 | qwen1.5b | 5 | 48 | 690.7 | 722 | 5 | 5 | 60.0% | no |
| chess-endgames/kbnk | 2 | qwen1.5b | 13 | 83 | 648.4 | 673 | 5 | 5 | 34.6% | no |
| chess-endgames/kqk | 2 | qwen1.5b | 5 | 25 | 715.2 | 735 | 5.1 | 6 | 50.0% | no |
| chess-endgames/krk | 2 | qwen1.5b | 26.5 | 40 | 633.4 | 679 | 4.96 | 5 | 11.3% | no |
| chess-puzzles/r0400 | 1 | qwen1.5b | 3 | 8 | 1065 | 1072 | 5 | 5 | 100.0% | no |
| chess-puzzles/r1000 | 1 | qwen1.5b | 3 | 8 | 1025 | 1032 | 5 | 5 | 100.0% | no |
| chess-puzzles/r1400 | 1 | qwen1.5b | 1 | 8 | 874 | 874 | 5 | 5 | 0.0% | no |
| chess-puzzles/r1800 | 1 | qwen1.5b | 2 | 8 | 1010.5 | 1033 | 4 | 5 | 50.0% | no |
| chess-puzzles/r2200 | 1 | qwen1.5b | 3 | 8 | 1070 | 1093 | 4.33 | 5 | 66.7% | no |
| chess-puzzles/r2600 | 1 | qwen1.5b | 1 | 8 | 988 | 988 | 5 | 5 | 0.0% | no |
| chess-stockfish/sf-100k | 2 | qwen1.5b | 8.5 | 150 | 707.8 | 748 | 4.41 | 5 | 58.8% | no |
| chess-stockfish/sf-10k | 2 | qwen1.5b | 4.5 | 150 | 738.9 | 762 | 3.89 | 5 | 88.9% | no |
| chess-stockfish/sf-1k | 2 | qwen1.5b | 6 | 150 | 700.5 | 735 | 3.67 | 5 | 75.0% | no |
| chess-stockfish/sf-1m | 2 | qwen1.5b | 4 | 150 | 674.8 | 705 | 4.5 | 5 | 75.0% | no |
| chess-stockfish/sf-250 | 1 | qwen1.5b | 3 | 150 | 683 | 690 | 5 | 5 | 100.0% | no |
| chess/granite | 2 | qwen1.5b | 3 | 150 | 704.7 | 720 | 3 | 3 | 100.0% | no |
| chess/paper | 2 | qwen1.5b | 4.5 | 150 | 690.9 | 720 | 3.44 | 5 | 77.8% | no |
| chess/steel | 2 | qwen1.5b | 3.5 | 150 | 699.6 | 731 | 3.86 | 5 | 85.7% | no |
| chess/wood | 2 | qwen1.5b | 4 | 150 | 643.5 | 669 | 3.5 | 5 | 87.5% | no |
| connect4/forced-win | 2 | qwen1.5b | 1 | 30 | 469 | 470 | 2 | 2 | 0.0% | no |
| connect4/ladder-1 | 26 | qwen0.5b+qwen1.5b+qwen7b | 4.35 | 30 | 443.2 | 446 | 2.53 | 4 | 0.0% | no |
| connect4/ladder-2 | 2 | qwen1.5b | 4.5 | 30 | 442.3 | 444 | 2 | 2 | 0.0% | no |
| connect4/ladder-3 | 2 | qwen1.5b | 6 | 30 | 443.4 | 446 | 2 | 2 | 0.0% | no |
| connect4/ladder-4 | 2 | qwen1.5b | 3.5 | 30 | 442.3 | 443 | 2 | 2 | 0.0% | no |
| cube/cube-5 | 22 | qwen0.5b+qwen1.5b+qwen7b | 25 | 25 | 929 | 1011 | 2.66 | 6 | 0.5% | yes |
| cube/cube-7 | 2 | qwen1.5b | 35 | 35 | 930 | 933 | 3.13 | 4 | 0.0% | yes |
| cube/cube-9 | 2 | qwen1.5b | 45 | 45 | 929.5 | 935 | 3.02 | 4 | 0.0% | yes |
| holdem/equity | 2 | qwen1.5b | 130.5 | 400 | 1505.9 | 2423 | 2.51 | 4 | 0.0% | no |
| holdem/rules | 2 | qwen1.5b | 92 | 400 | 1456.7 | 2411 | 2.33 | 4 | 0.0% | no |
| holdem/station | 2 | qwen1.5b | 127.5 | 400 | 1520.1 | 2474 | 2.36 | 4 | 0.0% | no |
| mastermind/classic | 26 | qwen0.5b+qwen1.5b+qwen7b | 10.92 | 25 | 570.3 | 816 | 4.32 | 5 | 27.8% | no |
| mastermind/deep | 2 | qwen1.5b | 3 | 45 | 483.5 | 499 | 4.67 | 5 | 100.0% | no |
| mastermind/wide | 2 | qwen1.5b | 6 | 40 | 495.9 | 544 | 4.92 | 6 | 58.3% | no |
| minesweeper/beginner | 22 | qwen0.5b+qwen1.5b+qwen7b | 7.77 | 101 | 849.1 | 933 | 6.17 | 7 | 53.2% | no |
| minesweeper/expert | 2 | qwen1.5b | 2.5 | 500 | 1710.4 | 1724 | 6 | 6 | 60.0% | no |
| minesweeper/intermediate | 2 | qwen1.5b | 3.5 | 276 | 1225.1 | 1236 | 6 | 6 | 85.7% | no |
| minesweeper/torus | 2 | qwen1.5b | 3.5 | 276 | 1300 | 1347 | 6 | 6 | 85.7% | no |
| sliding/p15-long | 2 | qwen1.5b | 36.5 | 245 | 565.2 | 594 | 2.04 | 3 | 37.0% | no |
| sliding/p15-mid | 2 | qwen1.5b | 7.5 | 195 | 568.5 | 597 | 2.4 | 4 | 53.3% | no |
| sliding/p15-short | 2 | qwen1.5b | 7.5 | 145 | 568.8 | 597 | 2.4 | 4 | 53.3% | no |
| sliding/p8 | 22 | qwen0.5b+qwen1.5b+qwen7b | 88 | 155 | 527.9 | 607 | 2.02 | 45 | 1.9% | no |
| sokoban/four-box | 2 | qwen1.5b | 225 | 225 | 452.6 | 473 | 2 | 2 | 1.3% | yes |
| sokoban/three-box | 2 | qwen1.5b | 200 | 200 | 452.4 | 473 | 2 | 2 | 9.3% | yes |
| sokoban/two-box | 18 | qwen0.5b+qwen1.5b | 87.78 | 150 | 447.6 | 466 | 2 | 2 | 22.0% | no |
| tictactoe/perfect-opponent | 26 | qwen0.5b+qwen1.5b+qwen7b | 3 | 20 | 321.5 | 336 | 3.37 | 4 | 17.9% | no |

## What the fit cannot do

- The fit is a Qwen2.5-family prior (0.5B/1.5B/7B, local server, official track). A frontier model may forfeit less and flail differently; the worst case (budget × per-call maxima) is the number a dollar cap should be set from, and it does not depend on the fit.
- Seven short-game tiers have cross-model coverage; the strategy games are 1.5B-only, so their hold-out column measures run-to-run spread (first-model-run vs board-v2), not model transfer.
- Output-token maxima are the observed worst reply. On tiers where a 7B rambled to the harness reply cap, that cap is the fitted worst case.
