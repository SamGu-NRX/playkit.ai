# Gauntlet run estimate — gauntlet-public-first1 (public split)

**Estimate, not a measurement.** Manifest sha256 `61fddda7a4a933e8abb68c76647a1abefd726c129f0b02b1db1ca5368bdbd75c`. Priced with `openai-chat/qwen2.5-1.5b-instruct-q4_k_m` from the provided prices file.

Estimates, not measurements. Low calls: the game engine/greedy baseline's mean agent actions on two seeds of the tier, or the episode par where no baseline exists. High calls: the tier's maxActions. Tokens per call: the official system prompt plus the per-turn official user message (harness/official.js) rendered along the baseline episode at 4 characters per token. Real runs may cost more.

| Game | Episodes | Calls low | Calls high | USD low | USD high |
|---|---:|---:|---:|---:|---:|
| 2048 | 4 | — | 4500 | — | — |
| tictactoe | 1 | 5 | 20 | 0.00 | 0.01 |
| chess | 4 | 206 | 600 | 0.10 | 0.32 |
| chess-endgames | 4 | 8 | 196 | 0.00 | 0.09 |
| chess-stockfish | 5 | 420 | 750 | 0.26 | 0.53 |
| chess-puzzles | 6 | — | 48 | — | — |
| cube | 3 | 21 | 105 | 0.02 | 0.08 |
| minesweeper | 4 | — | 1153 | — | — |
| sliding | 4 | 111 | 740 | 0.06 | 0.39 |
| sokoban | 3 | 36 | 575 | 0.02 | 0.27 |
| connect4 | 5 | 58 | 150 | 0.02 | 0.06 |
| mastermind | 3 | — | 110 | — | — |
| holdem | 3 | 506 | 1200 | 0.68 | 2.45 |
| **Total** | **49** | **—** | **10147** | **—** | **—** |

- `tictactoe/perfect-opponent/tictactoe/perfect-opponent/public/0`: low = the tictactoe engine baseline's mean agent actions over 1 seed(s) of this tier
- `chess/paper/chess/paper/public/0`: low = the chess engine baseline's mean agent actions over 1 seed(s) of this tier
- `chess/wood/chess/wood/public/0`: low = the chess engine baseline's mean agent actions over 1 seed(s) of this tier
- `chess/steel/chess/steel/public/0`: low = the chess engine baseline's mean agent actions over 1 seed(s) of this tier
- `chess/granite/chess/granite/public/0`: low = the chess engine baseline's mean agent actions over 1 seed(s) of this tier
- `chess-endgames/kqk/chess-endgames/kqk/public/0`: low = the chess-endgames engine baseline's mean agent actions over 1 seed(s) of this tier
- `chess-endgames/krk/chess-endgames/krk/public/0`: low = the chess-endgames engine baseline's mean agent actions over 1 seed(s) of this tier
- `chess-endgames/kbbk/chess-endgames/kbbk/public/0`: low = the chess-endgames engine baseline's mean agent actions over 1 seed(s) of this tier
- `chess-endgames/kbnk/chess-endgames/kbnk/public/0`: low = the chess-endgames engine baseline's mean agent actions over 1 seed(s) of this tier
- `chess-stockfish/sf-250/chess-stockfish/sf-250/public/0`: low = the chess-stockfish engine baseline's mean agent actions over 1 seed(s) of this tier
- `chess-stockfish/sf-1k/chess-stockfish/sf-1k/public/0`: low = the chess-stockfish engine baseline's mean agent actions over 1 seed(s) of this tier
- `chess-stockfish/sf-10k/chess-stockfish/sf-10k/public/0`: low = the chess-stockfish engine baseline's mean agent actions over 1 seed(s) of this tier
- `chess-stockfish/sf-100k/chess-stockfish/sf-100k/public/0`: low = the chess-stockfish engine baseline's mean agent actions over 1 seed(s) of this tier
- `chess-stockfish/sf-1m/chess-stockfish/sf-1m/public/0`: low = the chess-stockfish engine baseline's mean agent actions over 1 seed(s) of this tier
- `cube/cube-5/cube/cube-5/public/0`: low = the episode par (5 on the first probed seed); no baseline agent exists for this game
- `cube/cube-7/cube/cube-7/public/0`: low = the episode par (7 on the first probed seed); no baseline agent exists for this game
- `cube/cube-9/cube/cube-9/public/0`: low = the episode par (9 on the first probed seed); no baseline agent exists for this game
- `sliding/p8/sliding/p8/public/0`: low = the episode par (11 on the first probed seed); no baseline agent exists for this game
- `sliding/p15-short/sliding/p15-short/public/0`: low = the episode par (24 on the first probed seed); no baseline agent exists for this game
- `sliding/p15-mid/sliding/p15-mid/public/0`: low = the episode par (32 on the first probed seed); no baseline agent exists for this game
- `sliding/p15-long/sliding/p15-long/public/0`: low = the episode par (44 on the first probed seed); no baseline agent exists for this game
- `sokoban/two-box/sokoban/two-box/public/0`: low = the episode par (6 on the first probed seed); no baseline agent exists for this game
- `sokoban/three-box/sokoban/three-box/public/0`: low = the episode par (13 on the first probed seed); no baseline agent exists for this game
- `sokoban/four-box/sokoban/four-box/public/0`: low = the episode par (17 on the first probed seed); no baseline agent exists for this game
- `connect4/ladder-1/connect4/ladder-1/public/0`: low = the connect4 engine baseline's mean agent actions over 1 seed(s) of this tier
- `connect4/ladder-2/connect4/ladder-2/public/0`: low = the connect4 engine baseline's mean agent actions over 1 seed(s) of this tier
- `connect4/ladder-3/connect4/ladder-3/public/0`: low = the connect4 engine baseline's mean agent actions over 1 seed(s) of this tier
- `connect4/ladder-4/connect4/ladder-4/public/0`: low = the connect4 engine baseline's mean agent actions over 1 seed(s) of this tier
- `connect4/forced-win/connect4/forced-win/public/0`: low = the connect4 engine baseline's mean agent actions over 1 seed(s) of this tier
- `holdem/station/holdem/station/public/0`: low = the holdem engine baseline's mean agent actions over 1 seed(s) of this tier
- `holdem/rules/holdem/rules/public/0`: low = the holdem engine baseline's mean agent actions over 1 seed(s) of this tier
- `holdem/equity/holdem/equity/public/0`: low = the holdem engine baseline's mean agent actions over 1 seed(s) of this tier
