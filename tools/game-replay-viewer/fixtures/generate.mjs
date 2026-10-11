/**
 * Deterministic generator for the synthetic replay-log fixtures.
 *
 * EVERY committed fixture in this directory (except the generator itself and
 * this notice) is produced by this script: replayable, seed-fixed, labelled
 * synthetic. Regenerate with:
 *
 *   node tools/game-replay-viewer/fixtures/generate.mjs
 *
 * Fixtures use the repo's reference rules (test/helpers/reference-2048.mjs)
 * to fabricate self-consistent move histories — no real play session, no
 * live page, no personal data. Corruptions are injected deliberately so the
 * reader and viewer have honest cases to classify.
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyMoveWithSpawn,
  cloneBoard,
  isValidMove,
  mulberry32,
  spawnRandomTile,
} from "../../../test/helpers/reference-2048.mjs";

const here = dirname(fileURLToPath(import.meta.url));

function emptyBoard() {
  return [0, 1, 2, 3].map(() => [0, 0, 0, 0]);
}

function firstValidDir(board, order = [2, 1, 3, 0]) {
  for (const dir of order) {
    if (isValidMove(board, dir)) return dir;
  }
  throw new Error("generator: no valid move on a board that should have one");
}

/** Play `count` reference moves from an empty board, recording every step. */
function syntheticMoves(seed, count) {
  const rng = mulberry32(seed);
  let board = emptyBoard();
  spawnRandomTile(board, rng);
  spawnRandomTile(board, rng);
  const moves = [];
  for (let i = 0; i < count; i += 1) {
    const dir = firstValidDir(board);
    const before = cloneBoard(board);
    const step = applyMoveWithSpawn(board, dir, rng);
    moves.push({
      id: `m${String(i + 1).padStart(4, "0")}`,
      dir,
      before,
      after: cloneBoard(step.board),
      spawn: step.spawn,
      gained: null,
      score: null,
    });
    board = step.board;
  }
  return moves;
}

function envelope(source, moves) {
  return {
    format: "playkit-replay-log/1",
    synthetic: true,
    source: { seed: null, scenario: null, recordedBy: null, ...source },
    moves,
  };
}

const SOURCE_BASE = {
  name: "synthetic replay for viewer tests",
  scenario: "normal",
  recordedBy: "bench/fixtures/game-engine.js moveLog shape (xorshift32 in the real fixture; mulberry32 here)",
};

function write(name, value) {
  writeFileSync(join(here, name), `${JSON.stringify(value, null, 2)}\n`);
}

// --- 1. valid-seed7.json — accepted, all observations present, all ok -----
{
  const moves = syntheticMoves(7, 8);
  write(
    "valid-seed7.json",
    envelope({ ...SOURCE_BASE, name: "synthetic replay: valid run, seed 7", seed: 7 }, moves),
  );
}

// --- 2. missing-observations.json — accepted with explicit missing states --
{
  const moves = syntheticMoves(9, 6);
  moves[1].after = null; // move 2: post-move board not recorded
  moves[3].before = null; // move 4: pre-move board not recorded
  moves[4].before = null; // move 5: nothing recorded but the action
  moves[4].after = null;
  moves[4].spawn = null;
  write(
    "missing-observations.json",
    envelope({ ...SOURCE_BASE, name: "synthetic replay: gaps in board observation", seed: 9 }, moves),
  );
}

// --- 3. corrupt-events.json — accepted, six corrupt events, one per code ---
{
  const moves = syntheticMoves(13, 7);

  moves[1].dir = 7; // DIR_UNKNOWN

  moves[2].after = [[2, 4, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]]; // BOARD_SHAPE (3 rows)

  const withAmbiguous = cloneBoard(moves[3].before);
  withAmbiguous[0][0] = 1; // BOARD_VALUE (1 is ambiguous under values encoding)
  moves[3].before = withAmbiguous;

  { // CHAIN_BREAK on move 5: edit one cell of before[4] away from after[3]
    const entry = moves[4];
    const spawn = entry.spawn;
    for (let r = 0; r < 4; r += 1) {
      for (let c = 0; c < 4; c += 1) {
        if (entry.before[r][c] !== 0 && !(spawn && spawn.r === r && spawn.c === c)) {
          entry.before = cloneBoard(entry.before);
          entry.before[r][c] = entry.before[r][c] === 2 ? 4 : 2;
          r = 4; // break outer
          break;
        }
      }
    }
  }

  { // SPAWN_MISMATCH on move 6: claim a spawn value the after board contradicts
    const entry = moves[5];
    outer: for (let r = 0; r < 4; r += 1) {
      for (let c = 0; c < 4; c += 1) {
        if (entry.after[r][c] !== 0 && !(entry.spawn && entry.spawn.r === r && entry.spawn.c === c)) {
          entry.spawn = { r, c, value: entry.after[r][c] === 2 ? 4 : 2 };
          break outer;
        }
      }
    }
  }

  moves[6].id = moves[5].id; // ID_DUPLICATE

  write(
    "corrupt-events.json",
    envelope({ ...SOURCE_BASE, name: "synthetic replay: six injected corruptions", seed: 13 }, moves),
  );
}

// --- 4. diverged-chain.json — accepted, internally consistent, but the ------
//     observed board at move 3 carries an extra tile the reference replay
//     does not produce (timeline marks it diverged; reader sees no problem).
{
  const moves = syntheticMoves(17, 5);
  const entry = moves[2];
  const spawn = entry.spawn;
  outer: for (let r = 0; r < 4; r += 1) {
    for (let c = 0; c < 4; c += 1) {
      if (entry.after[r][c] === 0 && !(spawn && spawn.r === r && spawn.c === c)) {
        entry.after = cloneBoard(entry.after);
        entry.after[r][c] = 2;
        moves[3].before = cloneBoard(entry.after); // keep the observed chain consistent
        break outer;
      }
    }
  }
  write(
    "diverged-chain.json",
    envelope({ ...SOURCE_BASE, name: "synthetic replay: observed history diverges from the reference replay", seed: 17 }, moves),
  );
}

// --- 5. legacy-moveLog.json — the EXISTING bench fixture shape --------------
//     (bare array of moveLog entries; no in-band source identity)
write("legacy-moveLog.json", syntheticMoves(21, 5));

// --- 6. hostile-labels.json — valid history, hostile source/move strings ----
//     Used to prove the viewer renders labels inertly (text only, no HTML).
{
  const moves = syntheticMoves(11, 4);
  moves[0].id = '"><svg onload="alert(1)">';
  write(
    "hostile-labels.json",
    envelope(
      {
        name: '<img src=x onerror="window.__replayPwned=1">',
        scenario: '"><script>alert(1)</script>',
        recordedBy: "javascript:alert(1)",
        seed: 11,
      },
      moves,
    ),
  );
}

// --- 7-9. refused-*: containers the reader must reject without rendering ---
write("refused-not-object.json", "just a string, not a log");
write("refused-format-unknown.json", {
  format: "other-tool/9",
  synthetic: true,
  source: { name: "not our format" },
  moves: [],
});
write("refused-moves-not-array.json", {
  format: "playkit-replay-log/1",
  synthetic: true,
  source: { name: "moves field is not an array", seed: 3 },
  moves: "eight moves",
});

console.log("fixtures regenerated (deterministic; seeds 7/9/13/17/21/11)");
