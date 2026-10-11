/**
 * Replay-log reader tests — zero-dependency node:test suite.
 * Run: node --test tools/game-replay-viewer/tests/*.test.mjs
 *
 * Covers: container refusals, per-event corruption codes, missing
 * observations, source identity, the never-mutates / never-repairs
 * contract, and the accepted/refused counts of the committed synthetic
 * fixture set.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  FORMAT_ID,
  PROBLEM_CODES,
  REFUSAL_CODES,
  readReplayLog,
  validateBoard,
} from "../lib/replay-reader.mjs";
import { applyMoveWithSpawn, cloneBoard, mulberry32, spawnRandomTile } from "../../../test/helpers/reference-2048.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, "..", "fixtures");

/** Build a self-consistent N-move history with the reference API. */
function syntheticMoves(seed, count) {
  const rng = mulberry32(seed);
  let board = [0, 1, 2, 3].map(() => [0, 0, 0, 0]);
  spawnRandomTile(board, rng);
  spawnRandomTile(board, rng);
  const moves = [];
  for (let i = 0; i < count; i += 1) {
    // find a valid move the simple way: try each direction until the board changes
    let chosen = null;
    for (const d of [2, 1, 3, 0]) {
      const before = cloneBoard(board);
      const step = applyMoveWithSpawn(board, d, rng);
      if (step.moved) {
        moves.push({
          id: `m${String(i + 1).padStart(4, "0")}`,
          dir: d,
          before,
          after: cloneBoard(step.board),
          spawn: step.spawn,
          gained: null,
          score: null,
        });
        board = step.board;
        chosen = d;
        break;
      }
    }
    if (chosen === null) throw new Error(`no valid move at step ${i}`);
  }
  return moves;
}

function envelope(moves, source = { name: "test log", seed: 1 }) {
  return { format: FORMAT_ID, synthetic: true, source, moves };
}

function deepFreeze(value) {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

// ---------------------------------------------------------------- refusals

test("refuses non-object logs (string, number, null)", () => {
  for (const raw of ["just a string", 42, null]) {
    const result = readReplayLog(raw);
    assert.equal(result.status, "refused");
    assert.equal(result.events.length, 0, "a refused log yields no events to render");
    assert.equal(result.refusals[0].code, REFUSAL_CODES.NOT_AN_OBJECT);
  }
});

test("refuses an object without a format field", () => {
  const result = readReplayLog({ source: { name: "x" }, moves: [] });
  assert.equal(result.status, "refused");
  assert.equal(result.refusals[0].code, REFUSAL_CODES.FORMAT_REQUIRED);
});

test("refuses an unsupported format id without reinterpreting it", () => {
  const result = readReplayLog({ format: "other-tool/9", moves: [] });
  assert.equal(result.status, "refused");
  assert.equal(result.refusals[0].code, REFUSAL_CODES.FORMAT_UNKNOWN);
});

test("refuses missing or non-array moves", () => {
  const missing = readReplayLog({ format: FORMAT_ID, source: { name: "x" } });
  assert.equal(missing.status, "refused");
  assert.equal(missing.refusals[0].code, REFUSAL_CODES.MOVES_MISSING);

  const notArray = readReplayLog({ format: FORMAT_ID, source: { name: "x" }, moves: "eight moves" });
  assert.equal(notArray.status, "refused");
  assert.equal(notArray.refusals[0].code, REFUSAL_CODES.MOVES_NOT_ARRAY);
});

// ----------------------------------------------------------- accepted logs

test("accepts a valid envelope and records its source identity", () => {
  const result = readReplayLog(envelope(syntheticMoves(7, 4), { name: "valid run", seed: 7, scenario: "normal" }));
  assert.equal(result.status, "accepted");
  assert.equal(result.shape, "envelope");
  assert.equal(result.synthetic, true);
  assert.equal(result.source.identityState, "recorded");
  assert.equal(result.source.name, "valid run");
  assert.equal(result.source.seed, 7);
  assert.equal(result.counts.events, 4);
  assert.deepEqual(
    result.counts,
    { events: 4, ok: 4, missing: 0, corrupt: 0 },
  );
  for (const event of result.events) {
    assert.deepEqual(event.problems, []);
    assert.equal(event.state, "ok");
    assert.equal(event.dirState, "ok");
  }
});

test("accepts the legacy bare move array and reports identity as unknown", () => {
  const moves = syntheticMoves(21, 3);
  delete moves[0].id; // existing engine entries carry no id
  const result = readReplayLog(moves);
  assert.equal(result.status, "accepted");
  assert.equal(result.shape, "legacy-moveLog");
  assert.equal(result.source.identityState, "unknown");
  assert.equal(result.source.name, null);
  assert.equal(result.events[0].id, "e0", "reader assigns e<i> when the log has no ids");
  assert.equal(result.events[0].idAssigned, true);
});

test("reports identity as unknown (never invented) when source.name is absent", () => {
  const result = readReplayLog(envelope(syntheticMoves(3, 2), { seed: 3 }));
  assert.equal(result.status, "accepted");
  assert.equal(result.source.identityState, "unknown");
  assert.equal(result.source.name, null);
});

// ------------------------------------------------- missing observations

test("marks absent boards as missing observations, not empty boards", () => {
  const moves = syntheticMoves(9, 3);
  moves[1].after = null;
  const result = readReplayLog(envelope(moves));
  assert.equal(result.status, "accepted");
  assert.equal(result.events[1].state, "missing");
  assert.equal(result.events[1].after, null);
  assert.equal(result.events[1].afterState, "missing");
  assert.equal(result.events[1].beforeState, "present");
  assert.deepEqual(result.counts, { events: 3, ok: 2, missing: 1, corrupt: 0 });
});

test("an event with only its action recorded (no boards, no spawn) is missing, not corrupt", () => {
  const moves = syntheticMoves(9, 3);
  moves[2] = { id: "m0003", dir: moves[2].dir, before: null, after: null, spawn: null };
  const result = readReplayLog(envelope(moves));
  assert.equal(result.events[2].state, "missing");
  assert.equal(result.events[2].dirState, "ok");
});

// ------------------------------------------------------- corrupt events

test("unknown and missing directions are corrupt events, never guessed", () => {
  const moves = syntheticMoves(13, 3);
  moves[1].dir = 7;
  const unknown = readReplayLog(envelope(moves));
  assert.equal(unknown.events[1].state, "corrupt");
  assert.equal(unknown.events[1].dirState, "unknown");
  assert.equal(unknown.events[1].problems[0].code, PROBLEM_CODES.DIR_UNKNOWN);

  const gone = { id: "m0002", dir: null, before: moves[1].before, after: moves[1].after, spawn: moves[1].spawn };
  const missing = readReplayLog(envelope([moves[0], gone, moves[2]]));
  assert.equal(missing.events[1].dirState, "missing");
  assert.equal(missing.events[1].problems[0].code, PROBLEM_CODES.DIR_MISSING);
});

test("board validation: shape, ambiguous 1, and out-of-domain values are rejected", () => {
  assert.equal(validateBoard([[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]]), null);

  const shape = validateBoard([[2, 4, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]]);
  assert.equal(shape.code, PROBLEM_CODES.BOARD_SHAPE);

  for (const bad of [1, 3, -2, 2 ** 16, 0.5, "2"]) {
    const board = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];
    board[2][1] = bad;
    const problem = validateBoard(board);
    assert.equal(problem.code, PROBLEM_CODES.BOARD_VALUE, `value ${JSON.stringify(bad)} must be rejected`);
  }
});

test("chain break: before[i] not continuing after[i-1] is reported, not resynced", () => {
  const moves = syntheticMoves(13, 3);
  moves[2].before = cloneBoard(moves[2].before);
  moves[2].before[3][3] = moves[2].before[3][3] === 2 ? 4 : 2;
  const result = readReplayLog(envelope(moves));
  assert.equal(result.events[2].state, "corrupt");
  assert.equal(result.events[2].problems[0].code, PROBLEM_CODES.CHAIN_BREAK);
  assert.ok(result.events[2].problems[0].message.includes("gap or an edit"));
});

test("spawn value contradicting the after board is a SPAWN_MISMATCH", () => {
  const moves = syntheticMoves(13, 2);
  const entry = moves[1];
  outer: for (let r = 0; r < 4; r += 1) {
    for (let c = 0; c < 4; c += 1) {
      if (entry.after[r][c] !== 0 && !(entry.spawn && entry.spawn.r === r && entry.spawn.c === c)) {
        entry.spawn = { r, c, value: entry.after[r][c] === 2 ? 4 : 2 };
        break outer;
      }
    }
  }
  const result = readReplayLog(envelope(moves));
  assert.equal(result.events[1].problems.some((p) => p.code === PROBLEM_CODES.SPAWN_MISMATCH), true);
});

test("a spawn on a cell the slide vacated is legal — the reader does not false-positive", () => {
  const moves = syntheticMoves(7, 8);
  const result = readReplayLog(envelope(moves));
  assert.equal(result.counts.corrupt, 0, "reference-generated histories must read clean");
});

test("duplicate move ids are reported", () => {
  const moves = syntheticMoves(13, 2);
  moves[1].id = moves[0].id;
  const result = readReplayLog(envelope(moves));
  assert.equal(result.events[1].problems.some((p) => p.code === PROBLEM_CODES.ID_DUPLICATE), true);
});

// --------------------------------------------- never mutates, never repairs

test("reader does not mutate a deep-frozen input log", () => {
  const raw = deepFreeze(envelope(syntheticMoves(31, 3)));
  const before = JSON.stringify(raw);
  const result = readReplayLog(raw, { fileName: "frozen.json" });
  assert.equal(result.status, "accepted");
  assert.equal(JSON.stringify(raw), before);
});

test("reader never fills missing observations with invented boards", () => {
  const moves = syntheticMoves(9, 2);
  moves[1].after = null;
  const result = readReplayLog(envelope(moves));
  assert.equal(result.events[1].after, null, "the gap stays a gap");
  assert.equal(result.events[1].state, "missing");
});

// --------------------------------------------- committed fixture set counts

test("committed synthetic fixtures classify as 6 accepted / 3 refused", () => {
  const files = readdirSync(fixturesDir).filter((f) => f.endsWith(".json")).sort();
  const accepted = [];
  const refused = [];
  for (const file of files) {
    const raw = JSON.parse(readFileSync(join(fixturesDir, file), "utf8"));
    const result = readReplayLog(deepFreeze(raw), { fileName: file });
    (result.status === "accepted" ? accepted : refused).push(file);
  }

  assert.deepEqual(accepted, [
    "corrupt-events.json",
    "diverged-chain.json",
    "hostile-labels.json",
    "legacy-moveLog.json",
    "missing-observations.json",
    "valid-seed7.json",
  ]);
  assert.deepEqual(refused, [
    "refused-format-unknown.json",
    "refused-moves-not-array.json",
    "refused-not-object.json",
  ]);

  console.log(`fixture counts: accepted=${accepted.length} refused=${refused.length} of ${files.length}`);
});

test("fixture expectations: per-log counts stay as documented", () => {
  const load = (name) =>
    readReplayLog(deepFreeze(JSON.parse(readFileSync(join(fixturesDir, name), "utf8"))), { fileName: name });

  const valid = load("valid-seed7.json");
  assert.deepEqual(valid.counts, { events: 8, ok: 8, missing: 0, corrupt: 0 });

  const missing = load("missing-observations.json");
  assert.deepEqual(missing.counts, { events: 6, ok: 3, missing: 3, corrupt: 0 });

  const corrupt = load("corrupt-events.json");
  assert.deepEqual(corrupt.counts, { events: 8, ok: 2, missing: 0, corrupt: 6 });
  const codes = new Set(corrupt.events.flatMap((e) => e.problems.map((p) => p.code)));
  assert.deepEqual(
    [...codes].sort(),
    ["BOARD_SHAPE", "BOARD_VALUE", "CHAIN_BREAK", "DIR_UNKNOWN", "ID_DUPLICATE", "SPAWN_MISMATCH"].sort(),
  );

  const diverged = load("diverged-chain.json");
  assert.deepEqual(diverged.counts, { events: 5, ok: 5, missing: 0, corrupt: 0 });

  const hostile = load("hostile-labels.json");
  assert.equal(hostile.status, "accepted");
  assert.match(hostile.source.name, /<img/);
});
