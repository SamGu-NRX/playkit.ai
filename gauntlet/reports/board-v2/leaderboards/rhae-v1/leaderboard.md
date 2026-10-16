# PlayKit Gauntlet leaderboard

- Suite: `gauntlet-public-first1` (split `public`, salt commitment: none)
- Generated: 2026-10-16T06:24:02.621Z

## Official track

| Rank | Agent | Benchmark score (95% CI) | Cost (USD) | Cost/episode (USD) | Invalid actions | Mean agent actions | Chess rating (95% CI) |
|---:|---|---:|---:|---:|---:|---:|---:|
| 1 | model:openai-chat/qwen2.5-1.5b-instruct-q4_k_m (qwen2.5-1.5b-instruct-q4_k_m @ openai-chat) | 0.0301 [0.0301, 0.0301] | 0.0000 | 0.0000 | 7.2% | 40.2 | — (loses-everything) |

### Score versus cost — official track

| Agent | Rank | Benchmark score | Cost (USD) | Cost/episode (USD) |
|---|---:|---:|---:|---:|
| model:openai-chat/qwen2.5-1.5b-instruct-q4_k_m (qwen2.5-1.5b-instruct-q4_k_m @ openai-chat) | 1 | 0.0301 | 0.0000 | 0.0000 |

## Community track

_No entries._

## Baseline track

| Rank | Agent | Benchmark score (95% CI) | Cost (USD) | Cost/episode (USD) | Invalid actions | Mean agent actions | Chess rating (95% CI) |
|---:|---|---:|---:|---:|---:|---:|---:|
| 1 | random | 0.0392 [0.0392, 0.0392] | unknown | unknown | 0.0% | 53.3 | — (loses-everything) |
| — | 2048-engine-d2 | — | unknown | unknown | 0.0% | 362.5 | — |
| — | 2048-greedy | — | unknown | unknown | 0.0% | 237.0 | — |
| — | engine | — | unknown | unknown | 0.0% | 6.0 | — |
| — | engine-d8 | — | unknown | unknown | 0.0% | 8.8 | — |
| — | engine-granite | — | unknown | unknown | 0.0% | 16.0 | — |
| — | engine-paper | — | unknown | unknown | 0.0% | 56.0 | — (loses-everything) |
| — | engine-steel | — | unknown | unknown | 0.0% | 54.0 | — |
| — | engine-wood | — | unknown | unknown | 0.0% | 80.0 | — (loses-everything) |
| — | greedy | — | unknown | unknown | 0.0% | 7.9 | — |
| — | greedy-baseline | — | unknown | unknown | 0.0% | 24.0 | — (loses-everything) |
| — | holdem-engine | — | unknown | unknown | 0.0% | 166.7 | — |
| — | holdem-greedy | — | unknown | unknown | 0.0% | 174.0 | — |
| — | minesweeper-deduction | — | unknown | unknown | 0.0% | 164.0 | — |
| — | minesweeper-probability | — | unknown | unknown | 0.0% | 164.0 | — |
| — | sliding-solver | — | unknown | unknown | 0.0% | 27.8 | — |
| — | sokoban-engine | — | unknown | unknown | 0.0% | 12.0 | — |
| — | sokoban-greedy | — | unknown | unknown | 0.0% | 191.7 | — |

### Unranked — baseline track

| Agent | Reason |
|---|---|
| 2048-engine-d2 | missing episodes: tictactoe/perfect-opponent/tictactoe/perfect-opponent/public/0, chess/paper/chess/paper/public/0, chess/wood/chess/wood/public/0 (+42 more) |
| 2048-greedy | missing episodes: tictactoe/perfect-opponent/tictactoe/perfect-opponent/public/0, chess/paper/chess/paper/public/0, chess/wood/chess/wood/public/0 (+42 more) |
| engine | missing episodes: 2048/t256/2048/t256/public/0, 2048/t512/2048/t512/public/0, 2048/t1024/2048/t1024/public/0 (+43 more) |
| engine-d8 | missing episodes: 2048/t256/2048/t256/public/0, 2048/t512/2048/t512/public/0, 2048/t1024/2048/t1024/public/0 (+41 more) |
| engine-granite | missing episodes: 2048/t256/2048/t256/public/0, 2048/t512/2048/t512/public/0, 2048/t1024/2048/t1024/public/0 (+45 more) |
| engine-paper | missing episodes: 2048/t256/2048/t256/public/0, 2048/t512/2048/t512/public/0, 2048/t1024/2048/t1024/public/0 (+45 more) |
| engine-steel | missing episodes: 2048/t256/2048/t256/public/0, 2048/t512/2048/t512/public/0, 2048/t1024/2048/t1024/public/0 (+45 more) |
| engine-wood | missing episodes: 2048/t256/2048/t256/public/0, 2048/t512/2048/t512/public/0, 2048/t1024/2048/t1024/public/0 (+45 more) |
| greedy | missing episodes: 2048/t256/2048/t256/public/0, 2048/t512/2048/t512/public/0, 2048/t1024/2048/t1024/public/0 (+38 more) |
| greedy-baseline | missing episodes: 2048/t256/2048/t256/public/0, 2048/t512/2048/t512/public/0, 2048/t1024/2048/t1024/public/0 (+42 more) |
| holdem-engine | missing episodes: 2048/t256/2048/t256/public/0, 2048/t512/2048/t512/public/0, 2048/t1024/2048/t1024/public/0 (+43 more) |
| holdem-greedy | missing episodes: 2048/t256/2048/t256/public/0, 2048/t512/2048/t512/public/0, 2048/t1024/2048/t1024/public/0 (+43 more) |
| minesweeper-deduction | missing episodes: 2048/t256/2048/t256/public/0, 2048/t512/2048/t512/public/0, 2048/t1024/2048/t1024/public/0 (+42 more) |
| minesweeper-probability | missing episodes: 2048/t256/2048/t256/public/0, 2048/t512/2048/t512/public/0, 2048/t1024/2048/t1024/public/0 (+42 more) |
| sliding-solver | missing episodes: 2048/t256/2048/t256/public/0, 2048/t512/2048/t512/public/0, 2048/t1024/2048/t1024/public/0 (+42 more) |
| sokoban-engine | missing episodes: 2048/t256/2048/t256/public/0, 2048/t512/2048/t512/public/0, 2048/t1024/2048/t1024/public/0 (+43 more) |
| sokoban-greedy | missing episodes: 2048/t256/2048/t256/public/0, 2048/t512/2048/t512/public/0, 2048/t1024/2048/t1024/public/0 (+43 more) |

### Score versus cost — baseline track

| Agent | Rank | Benchmark score | Cost (USD) | Cost/episode (USD) |
|---|---:|---:|---:|---:|
| random | 1 | 0.0392 | unknown | unknown |

