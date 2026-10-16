# Frontier cost projection — first-model suite (42 episodes)

Qwen call-ratio vs estimator low basis: median 0.82x (completed games: 9)

| Model | $/MTok in | $/MTok out | USD floor | USD qwen-corrected |
|---|---:|---:|---:|---:|
| anthropic/claude-opus-5-5 | 4 | 20 | 4.68 | 4.02 |
| openai/gpt-6-astra | 10 | 50 | 11.69 | 10.06 |
| openai-chat/gemini-4-argon | 2 | 10 | 2.34 | 2.01 |

Per-game estimator inputs:

| game | eps | est calls low/ep | est calls high/ep | est tok/call | measured calls/ep | qwen ratio |
|---|---:|---:|---:|---:|---:|---:|
| 2048 | 4 | — | 1125 | 563 | 163.5 | 0.82 |
| tictactoe | 1 | 5 | 20 | 261 | 3 | 0.6 |
| chess | 4 | 51.5 | 150 | 490 | 3.3 | 0.06 |
| chess-endgames | 4 | 2 | 49 | 464 | 6.3 | 3.13 |
| chess-stockfish | 5 | 84 | 150 | 615 | 5.2 | 0.06 |
| chess-puzzles | 6 | — | 8 | 1033 | 2.2 | 0.82 |
| cube | 3 | 7 | 35 | 782 | 35 | 5 |
| minesweeper | 4 | — | 288.3 | 1143 | 2.5 | 0.82 |
| sliding | 4 | 27.8 | 185 | 526 | 23.3 | 0.84 |
| sokoban | 3 | 12 | 191.7 | 464 | 191.7 | 15.97 |
| connect4 | 5 | 11.6 | 30 | 384 | 4.2 | 0.36 |
| mastermind | 3 | — | 36.7 | 499 | 5.3 | 0.82 |
| holdem | 3 | 168.7 | 400 | 1338 | 138.3 | 0.82 |
