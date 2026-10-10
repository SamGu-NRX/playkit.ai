// Native (non-WASM) build of the actual C++ solver for the solver-budgets
// study.
//
// This shim compiles the *unmodified* headers of the `2048-solver` submodule
// (game.hpp, heuristics.hpp, strategies/*.hpp) with a plain host compiler and
// exposes a minimal line protocol over stdin/stdout so the Node experiment
// runner can drive it. It mirrors the strategy-factory logic of
// solver/wasm/export_solver.cpp from the submodule (which cannot be included
// directly because it pulls in <emscripten/bind.h>) — the strategy types,
// heuristics and board encoding are the submodule's own code.
//
// Direction convention (C++ side, determined EMPIRICALLY against the pinned
// submodule commit via MAKE on known boards — see
// experiments/solver-budgets/tests/native-crosscheck.test.mjs):
//   0 = Right, 1 = Down, 2 = Left, 3 = Up.
// (This matches neither the project convention 0=Up,1=Right,2=Down,3=Left nor
// the MOVES = {'l','u','r','d'} comment in game.hpp.) The JS runner maps C++
// indices to project convention as JS = [1, 2, 3, 0][cpp]. The mapping is
// asserted by the cross-check test on random boards for all four directions.
//
// Protocol (one JSON-free line per request; fields separated by spaces):
//   CONFIG <type> <heuristic> <depth> <probability> [trials]
//       -> OK CONFIG
//   PICK <e0> <e1> ... <e15>          (row-major exponent array)
//       -> MOVE <dir> <elapsed_us>
//   MAKE <dir> <e0> ... <e15>         (C++-side move simulation, cross-check only)
//       -> BOARD <e0> ... <e15>
//   PING -> OK PING
//   QUIT -> OK QUIT (exits)
//
// Compiled with -DREQUIRE_DETERMINISTIC so Strategy.hpp seeds its RNG from a
// fixed constant instead of the wall clock (matters for Monte Carlo arms and
// makes every arm replayable).

#include <algorithm>
#include <chrono>
#include <cctype>
#include <iostream>
#include <memory>
#include <sstream>
#include <string>
#include <vector>

#include "game.hpp"
#include "heuristics.hpp"
#include "strategies/ExpectimaxDepthStrategy.hpp"
#include "strategies/ExpectimaxProbabilityStrategy.hpp"
#include "strategies/MonteCarloPlayer.hpp"
#include "strategies/RandomPlayer.hpp"
#include "strategies/RandomTrialsStrategy.hpp"

// Static member definitions copied from solver/wasm/export_solver.cpp — these
// are the submodule's own lookup-table initializers.
const std::array<row_t, ROWS> GameSimulator::shift = generate_shift();
const std::array<uint8_t, EMPTY_TILE_POSITIONS> GameSimulator::empty_tiles = generate_empty_tiles();
const std::array<int, EMPTY_MASKS> GameSimulator::empty_index = generate_empty_index();

namespace {

constexpr int kBoardTileCount = 16;
constexpr int kTileBitWidth = 4;
constexpr int kMaxExponent = 0xF;

std::string toLowerCopy(std::string value) {
  std::transform(value.begin(), value.end(), value.begin(), [](unsigned char ch) {
    return static_cast<char>(std::tolower(ch));
  });
  return value;
}

heuristic_t resolveHeuristic(const std::string& name) {
  const std::string key = toLowerCopy(name);

  if (key == "score") return heuristics::score_heuristic;
  if (key == "merge") return heuristics::merge_heuristic;
  if (key == "corner" || key == "corner_bias") return heuristics::corner_heuristic;
  if (key == "wall" || key == "strict_wall") return heuristics::strict_wall_heuristic;
  if (key == "wall_gap") return heuristics::wall_gap_heuristic;
  if (key == "full_wall") return heuristics::full_wall_heuristic;
  if (key == "skewed_corner") return heuristics::skewed_corner_heuristic;
  if (key == "monotonicity") return heuristics::monotonicity_heuristic;

  return heuristics::corner_heuristic;
}

int clampExponent(int value) {
  if (value < 0) return 0;
  if (value > kMaxExponent) return kMaxExponent;
  return value;
}

GameSimulator& simulator() {
  static GameSimulator instance;
  return instance;
}

std::unique_ptr<Strategy> makeStrategy(const std::string& type,
                                       heuristic_t evaluator,
                                       int depth,
                                       double probability,
                                       int trials) {
  const std::string key = toLowerCopy(type);

  if (key == "expectimax-depth" || key == "expectimax") {
    const int effectiveDepth = depth <= 0 ? 4 : depth;
    return std::make_unique<ExpectimaxDepthStrategy>(effectiveDepth, evaluator);
  }

  if (key == "expectimax-probability") {
    float prob = static_cast<float>(probability);
    if (!(prob > 0.0f)) {
      prob = 0.001f;
    }
    return std::make_unique<ExpectimaxProbabilityStrategy>(prob, evaluator);
  }

  if (key == "monte-carlo") {
    int iterations = trials > 0 ? trials : std::max(128, depth * 128);
    return std::make_unique<MonteCarloPlayer>(iterations);
  }

  if (key == "random-trials") {
    const int branchDepth = depth > 0 ? depth : 3;
    const int gamesPerMove = trials > 0 ? trials : 32;
    return std::make_unique<RandomTrialsStrategy>(gamesPerMove, branchDepth, 2);
  }

  if (key == "random") {
    return std::make_unique<RandomPlayer>();
  }

  // Fallback: expectimax depth strategy (same as export_solver.cpp).
  const int fallbackDepth = depth <= 0 ? 4 : depth;
  return std::make_unique<ExpectimaxDepthStrategy>(fallbackDepth, evaluator);
}

board_t boardFromArray(const std::vector<int>& tiles) {
  board_t board = 0;
  const size_t limit = std::min<size_t>(tiles.size(), kBoardTileCount);
  for (size_t i = 0; i < limit; ++i) {
    const board_t exponent = static_cast<board_t>(clampExponent(tiles[i]));
    board |= (exponent & kMaxExponent) << (i * kTileBitWidth);
  }
  return board;
}

std::vector<int> arrayFromBoard(board_t board) {
  std::vector<int> tiles(kBoardTileCount, 0);
  for (int i = 0; i < kBoardTileCount; ++i) {
    tiles[i] = static_cast<int>((board >> (i * kTileBitWidth)) & kMaxExponent);
  }
  return tiles;
}

}  // namespace

int main() {
  std::ios_base::sync_with_stdio(false);

  std::unique_ptr<Strategy> strategy;
  heuristic_t evaluator = heuristics::corner_heuristic;

  std::string line;
  while (std::getline(std::cin, line)) {
    if (line.empty()) continue;
    std::istringstream iss(line);
    std::string command;
    iss >> command;

    if (command == "QUIT") {
      std::cout << "OK QUIT" << std::endl;
      break;
    } else if (command == "PING") {
      std::cout << "OK PING" << std::endl;
    } else if (command == "CONFIG") {
      std::string type, heuristic;
      int depth = 4;
      double probability = 0.0025;
      int trials = 256;
      iss >> type >> heuristic >> depth >> probability >> trials;
      evaluator = resolveHeuristic(heuristic);
      strategy = makeStrategy(type, evaluator, depth, probability, trials);
      std::cout << "OK CONFIG" << std::endl;
    } else if (command == "PICK") {
      if (!strategy) {
        std::cout << "ERR no strategy configured" << std::endl;
        continue;
      }
      std::vector<int> tiles(kBoardTileCount, 0);
      bool parseError = false;
      for (int i = 0; i < kBoardTileCount; ++i) {
        if (!(iss >> tiles[i])) {
          parseError = true;
          break;
        }
      }
      if (parseError) {
        std::cout << "ERR bad board" << std::endl;
        continue;
      }
      const board_t board = boardFromArray(tiles);
      const auto t0 = std::chrono::steady_clock::now();
      const int move = strategy->pick_move(board);
      const auto t1 = std::chrono::steady_clock::now();
      const long long elapsedUs =
          std::chrono::duration_cast<std::chrono::microseconds>(t1 - t0).count();
      std::cout << "MOVE " << move << " " << elapsedUs << std::endl;
    } else if (command == "MAKE") {
      int direction = -1;
      std::vector<int> tiles(kBoardTileCount, 0);
      if (!(iss >> direction)) {
        std::cout << "ERR bad direction" << std::endl;
        continue;
      }
      bool parseError = false;
      for (int i = 0; i < kBoardTileCount; ++i) {
        if (!(iss >> tiles[i])) {
          parseError = true;
          break;
        }
      }
      if (parseError) {
        std::cout << "ERR bad board" << std::endl;
        continue;
      }
      const board_t board = boardFromArray(tiles);
      const board_t next = simulator().make_move(board, direction);
      const std::vector<int> out = arrayFromBoard(next);
      std::ostringstream outLine;
      outLine << "BOARD";
      for (int i = 0; i < kBoardTileCount; ++i) outLine << " " << out[i];
      std::cout << outLine.str() << std::endl;
    } else {
      std::cout << "ERR unknown command " << command << std::endl;
    }
  }
  return 0;
}
