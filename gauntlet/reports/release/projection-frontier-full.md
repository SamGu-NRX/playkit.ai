# Release frontier cost projection — pilot (49 episodes) and full public suite (929 episodes)

Qwen call-ratio vs estimator low basis: median 0.82x (games with low basis: 8); per-game span 0.06x-15.97x

| Model | $/MTok in | $/MTok out | Pilot floor | Pilot corrected | Full floor | Full corrected | Full budget cap |
|---|---:|---:|---:|---:|---:|---:|---:|
| anthropic/claude-opus-5-5 | 4 | 20 | 1.14 | 1.28 | 40.04 | 58.07 | 132.10 |
| openai/gpt-6-astra | 10 | 50 | 2.86 | 3.21 | 100.11 | 145.17 | 330.25 |
| openai-chat/gemini-4-argon | 2 | 10 | 0.57 | 0.64 | 20.02 | 29.03 | 66.05 |

Per-game inputs (seeds, calls/episode, tokens/call):

| game | seeds | est calls low/ep | est calls high/ep | est tok/call | measured calls/ep | qwen ratio |
|---|---:|---:|---:|---:|---:|---:|
| 2048 | 80 | — | 1125.0 | 0 | 163.5 | 0.82 |
| tictactoe | 8 | 5 | 20.0 | 261 | 3 | 0.6 |
| chess | 20 | 51.5 | 150.0 | 490 | 3.3 | 0.06 |
| chess-endgames | 40 | 2 | 49.0 | 464 | 6.3 | 3.13 |
| chess-stockfish | 25 | — | 150.0 | 0 | 5.2 | 0.82 |
| chess-puzzles | 360 | — | 8.0 | 0 | 2.2 | 0.82 |
| cube | 18 | 7 | 35.0 | 806 | 35 | 5 |
| minesweeper | 100 | — | 288.3 | 0 | 2.5 | 0.82 |
| sliding | 32 | 27.75 | 185.0 | 526 | 23.3 | 0.84 |
| sokoban | 75 | 12 | 191.7 | 464 | 191.7 | 15.97 |
| connect4 | 60 | 11.6 | 30.0 | 384 | 4.2 | 0.36 |
| mastermind | 75 | — | 36.7 | 0 | 5.3 | 0.82 |
| holdem | 36 | 168.66666666666666 | 400.0 | 1338 | 135.3 | 0.8 |
