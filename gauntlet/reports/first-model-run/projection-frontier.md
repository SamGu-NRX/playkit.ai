# Frontier cost projection — first-model suite (42 episodes)

Qwen call-ratio vs estimator low basis: median 0.7x (completed games: 8)

| Model | $/MTok in | $/MTok out | USD floor | USD qwen-corrected |
|---|---:|---:|---:|---:|
| anthropic/claude-opus-5-5 | 4 | 20 | 2.81 | 3.17 |
| openai/gpt-6-astra | 10 | 50 | 7.03 | 7.93 |
| openai-chat/gemini-4-argon | 2 | 10 | 1.41 | 1.59 |

Per-game estimator inputs:

| game | eps | est calls low/ep | est calls high/ep | est tok/call | measured calls/ep | qwen ratio |
|---|---:|---:|---:|---:|---:|---:|
| tictactoe | 1 | 5 | 20 | 261 | 3 | 0.6 |
| cube | 3 | 7 | 35 | 782 | 35 | 5 |
| mastermind | 3 | — | 36.7 | 577 | 11 | 0.7 |
| connect4 | 5 | 10.2 | 30 | 381 | 3.6 | 0.35 |
| chess-endgames | 4 | 2 | 49 | 464 | 18.5 | 9.25 |
| sokoban | 3 | 12 | 191.7 | 464 | 191.7 | 15.97 |
| chess | 4 | 58.3 | 150 | 527 | 4.3 | 0.07 |
| chess-stockfish | 4 | — | 150 | 580 | 5.8 | 0.7 |
| sliding | 4 | 27.8 | 185 | 526 | 9 | 0.32 |
| minesweeper | 4 | — | 288.3 | 1293 | 3.8 | 0.7 |
| holdem | 3 | 118.7 | 400 | 1279 | 95 | 0.8 |
| 2048 | 4 | — | 1125 | 559 | 111.8 | 0.7 |
