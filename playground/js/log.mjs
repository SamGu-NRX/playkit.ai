/**
 * @fileoverview Versioned practice-game move log with strict, non-repairing
 * serialization, parsing, and replay verification.
 *
 * A log document is the only replayable record of a practice game: the
 * initial value-encoded board, every move (direction, resulting board, the
 * explicit user-selected spawn, merge-value score gain, and the observed
 * solver backend + move order), and the cumulative merge score.
 *
 * parseLog is deliberately strict: wrong, incomplete, and corrupt logs are
 * REFUSED with a machine-readable PracticeLogError code — never repaired,
 * defaulted, or silently accepted.
 */

import {
  applyMove,
  applySpawn,
  emptyCells,
  validateBoard,
  boardsEqual,
  BOARD_SIZE,
  DEFAULT_SPAWN_POLICY,
} from "./engine.mjs";

export const LOG_KIND = "playkit.practice-board.log";
export const LOG_VERSION = 1;
export const LOG_ENCODING = "values";

export class PracticeLogError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "PracticeLogError";
    this.code = code;
  }
}

const TOP_LEVEL_KEYS = new Set([
  "kind",
  "logVersion",
  "boardSize",
  "encoding",
  "spawnPolicy",
  "defaultSpawnPolicy",
  "createdUtc",
  "backendLabel",
  "initialBoard",
  "score",
  "moves",
]);

const MOVE_KEYS = new Set(["index", "direction", "boardAfter", "spawn", "scoreGain", "solver"]);

function isDirection(value) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 3;
}

function checkSolverRecord(solver, index) {
  if (!solver || typeof solver !== "object" || Array.isArray(solver)) {
    throw new PracticeLogError(
      "SOLVER_RECORD_MISSING",
      `move ${index}: solver record missing — every move records the observed backend (no silent substitution)`,
    );
  }
  if (typeof solver.backend !== "string" || !solver.backend.length) {
    throw new PracticeLogError("SOLVER_RECORD_MISSING", `move ${index}: solver.backend must be a non-empty string`);
  }
  if (solver.order !== undefined) {
    if (
      !Array.isArray(solver.order) ||
      solver.order.some((d) => !isDirection(d)) ||
      new Set(solver.order).size !== solver.order.length
    ) {
      throw new PracticeLogError("CORRUPT_LOG", `move ${index}: solver.order must be an array of unique directions 0..3`);
    }
  }
  if (solver.chosen !== undefined && solver.chosen !== null && !isDirection(solver.chosen)) {
    throw new PracticeLogError("CORRUPT_LOG", `move ${index}: solver.chosen must be a direction 0..3 or null`);
  }
}

/**
 * Create an empty log document for a given initial board.
 */
export function createLog({
  initialBoard,
  backendLabel = "unobserved",
  createdUtc = new Date().toISOString(),
  defaultSpawnPolicy = DEFAULT_SPAWN_POLICY,
}) {
  return {
    kind: LOG_KIND,
    logVersion: LOG_VERSION,
    boardSize: BOARD_SIZE,
    encoding: LOG_ENCODING,
    spawnPolicy: "explicit-user-selected",
    defaultSpawnPolicy,
    createdUtc,
    backendLabel,
    initialBoard: validateBoard(initialBoard),
    score: 0,
    moves: [],
  };
}

/**
 * Fold the document from its initial board through every recorded move and
 * spawn, recomputing each transition. Throws PracticeLogError on any
 * inconsistency. Used by parseLog (import refusal) and by the page's
 * "Verify replay" control.
 */
export function verifyDocument(doc) {
  let state = validateBoard(doc.initialBoard);
  let score = 0;
  const moves = doc.moves;
  if (!Array.isArray(moves)) {
    throw new PracticeLogError("FIELD_MISSING", "moves must be an array");
  }
  for (let i = 0; i < moves.length; i += 1) {
    const entry = moves[i];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new PracticeLogError("MOVE_MALFORMED", `move ${i}: entry must be an object`);
    }
    for (const key of Object.keys(entry)) {
      if (!MOVE_KEYS.has(key)) {
        throw new PracticeLogError("CORRUPT_LOG", `move ${i}: unknown field "${key}"`);
      }
    }
    if (!isDirection(entry.direction)) {
      throw new PracticeLogError(
        "UNKNOWN_DIRECTION",
        `move ${i}: direction must be an integer 0..3 (0=Up, 1=Right, 2=Down, 3=Left), got ${JSON.stringify(entry.direction)}`,
      );
    }
    checkSolverRecord(entry.solver, i);

    const expected = applyMove(state, entry.direction);
    if (!expected.moved) {
      throw new PracticeLogError(
        "ILLEGAL_TRANSITION",
        `move ${i}: direction ${entry.direction} is a no-op on the current board — no-op moves are never recorded and never spawn`,
      );
    }
    if (!entry.boardAfter || !Array.isArray(entry.boardAfter)) {
      throw new PracticeLogError("BOARD_MISMATCH", `move ${i}: boardAfter missing`);
    }
    if (!boardsEqual(expected.board, entry.boardAfter)) {
      let detail = "";
      outer: for (let r = 0; r < BOARD_SIZE; r += 1) {
        for (let c = 0; c < BOARD_SIZE; c += 1) {
          if (expected.board[r][c] !== entry.boardAfter[r][c]) {
            detail = ` first mismatch at [${r}][${c}]: expected ${expected.board[r][c]}, recorded ${entry.boardAfter[r][c]}`;
            break outer;
          }
        }
      }
      throw new PracticeLogError(
        "BOARD_MISMATCH",
        `move ${i}: recorded boardAfter does not match the recomputed transition from the previous state.${detail}`,
      );
    }
    if (!Number.isInteger(entry.scoreGain) || entry.scoreGain < 0) {
      throw new PracticeLogError("SCORE_MISMATCH", `move ${i}: scoreGain must be a non-negative integer`);
    }
    if (entry.scoreGain !== expected.scoreGain) {
      throw new PracticeLogError(
        "SCORE_MISMATCH",
        `move ${i}: recorded scoreGain ${entry.scoreGain} != recomputed merge gain ${expected.scoreGain} (scoring counts merged tile values, not tile mass)`,
      );
    }
    score += expected.scoreGain;

    const spawn = entry.spawn;
    if (spawn === null || spawn === undefined) {
      if (emptyCells(entry.boardAfter).length > 0) {
        throw new PracticeLogError(
          "INCOMPLETE_MOVE",
          `move ${i}: spawn missing while empty cells exist — an explicit-spawn log must record every spawn (refusing rather than guessing)`,
        );
      }
    } else {
      if (typeof spawn !== "object" || Array.isArray(spawn)) {
        throw new PracticeLogError("SPAWN_INVALID", `move ${i}: spawn must be {r, c, value} or null`);
      }
      const { r, c, value } = spawn;
      if (!Number.isInteger(r) || !Number.isInteger(c) || r < 0 || r >= BOARD_SIZE || c < 0 || c >= BOARD_SIZE) {
        throw new PracticeLogError("SPAWN_INVALID", `move ${i}: spawn cell [${r}][${c}] is outside the board`);
      }
      if (value !== 2 && value !== 4) {
        throw new PracticeLogError("SPAWN_INVALID", `move ${i}: spawn value must be 2 or 4, got ${JSON.stringify(value)}`);
      }
      if (entry.boardAfter[r][c] !== 0) {
        throw new PracticeLogError(
          "SPAWN_INVALID",
          `move ${i}: spawn cell [${r}][${c}] is occupied in boardAfter (value ${entry.boardAfter[r][c]})`,
        );
      }
    }

    state = entry.spawn ? applySpawn(entry.boardAfter, entry.spawn).board : entry.boardAfter;
  }
  if (!Number.isInteger(doc.score) || doc.score < 0) {
    throw new PracticeLogError("SCORE_MISMATCH", `cumulative score must be a non-negative integer, got ${JSON.stringify(doc.score)}`);
  }
  if (doc.score !== score) {
    throw new PracticeLogError("SCORE_MISMATCH", `cumulative score ${doc.score} != sum of recorded merge gains ${score}`);
  }
  return { agrees: true, finalBoard: state.map((row) => row.slice()), score };
}

/**
 * Fold the document to its final board. Runs the full verification (it
 * calls verifyDocument) so a caller never restores an illegal state.
 */
export function finalBoardOf(doc) {
  return verifyDocument(doc).finalBoard;
}

/**
 * Fold the document to its CURRENT live board (initial + moves + spawns),
 * without full re-verification — used by appendMove on a document this
 * module has been maintaining (every prior append already verified the
 * transition it recorded).
 */
export function currentBoard(doc) {
  let state = validateBoard(doc.initialBoard);
  for (const entry of doc.moves) {
    let next = entry.boardAfter;
    if (entry.spawn) next = applySpawn(next, entry.spawn).board;
    state = next;
  }
  return state;
}

/**
 * Append one move to the log. The document is authoritative: the transition
 * (boardAfter + merge-value scoreGain) is recomputed from the log's own
 * state, the spawn is validated against it, and the cumulative score is
 * updated. Returns the appended record. Optional solver fields (order,
 * chosen) are omitted when undefined so serialized logs round-trip
 * byte-identically.
 *
 * @param {object} doc live log document
 * @param {{direction: number, spawn: {r: number, c: number, value: number}|null,
 *          solver: {backend: string, order?: number[], chosen?: number|null}}} entry
 */
export function appendMove(doc, entry) {
  if (!doc || doc.kind !== LOG_KIND) {
    throw new PracticeLogError("KIND_MISMATCH", "appendMove: not a practice-board log document");
  }
  if (!isDirection(entry?.direction)) {
    throw new PracticeLogError("UNKNOWN_DIRECTION", `direction must be an integer 0..3, got ${JSON.stringify(entry?.direction)}`);
  }
  checkSolverRecord(entry.solver, doc.moves.length);

  const state = currentBoard(doc);
  const expected = applyMove(state, entry.direction);
  if (!expected.moved) {
    throw new PracticeLogError(
      "ILLEGAL_TRANSITION",
      `direction ${entry.direction} is a no-op on the current board — nothing is recorded, nothing spawns`,
    );
  }

  const spawn = entry.spawn ?? null;
  if (spawn === null) {
    if (emptyCells(expected.board).length > 0) {
      throw new PracticeLogError(
        "INCOMPLETE_MOVE",
        "spawn missing while empty cells exist — choose a spawn (explicit spawn history is required for replay)",
      );
    }
  } else {
    applySpawn(expected.board, spawn); // validates cell + value, throws SPAWN_INVALID
  }

  const solverRecord = { backend: entry.solver.backend };
  if (entry.solver.order !== undefined) solverRecord.order = [...entry.solver.order];
  if (entry.solver.chosen !== undefined) solverRecord.chosen = entry.solver.chosen;

  const record = {
    index: doc.moves.length,
    direction: entry.direction,
    boardAfter: expected.board,
    spawn: spawn ? { r: spawn.r, c: spawn.c, value: spawn.value } : null,
    scoreGain: expected.scoreGain,
    solver: solverRecord,
  };
  doc.moves.push(record);
  doc.score += expected.scoreGain;
  return record;
}

/**
 * Canonical serialization: two-space JSON + trailing newline. Export and
 * import are byte-identical through serializeLog(parseLog(text)).
 */
export function serializeLog(doc) {
  return `${JSON.stringify(doc, null, 2)}\n`;
}

/**
 * Strict parse. Refuses (never repairs) anything that is not exactly a
 * value-encoded v1 practice-board log whose every transition, spawn, score,
 * and solver record checks out.
 */
export function parseLog(text) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (error) {
    throw new PracticeLogError("SYNTAX_INVALID", `not valid JSON: ${error.message}`);
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    throw new PracticeLogError("DOCUMENT_INVALID", "log must be a JSON object");
  }
  for (const key of Object.keys(doc)) {
    if (!TOP_LEVEL_KEYS.has(key)) {
      throw new PracticeLogError("CORRUPT_LOG", `unknown top-level field "${key}" — refusing rather than ignoring it`);
    }
  }
  if (doc.kind !== LOG_KIND) {
    throw new PracticeLogError("KIND_MISMATCH", `expected kind "${LOG_KIND}", got ${JSON.stringify(doc.kind)} — this is not a practice-board log`);
  }
  if (doc.logVersion !== LOG_VERSION) {
    throw new PracticeLogError("VERSION_UNSUPPORTED", `log version ${JSON.stringify(doc.logVersion)} is not supported (expected ${LOG_VERSION}) — refusing rather than guessing`);
  }
  if (doc.encoding !== LOG_ENCODING) {
    throw new PracticeLogError("ENCODING_MISMATCH", `expected encoding "values", got ${JSON.stringify(doc.encoding)} — encoding is declared, never guessed`);
  }
  if (doc.boardSize !== BOARD_SIZE) {
    throw new PracticeLogError("DIMENSIONS_MISMATCH", `expected boardSize ${BOARD_SIZE}, got ${JSON.stringify(doc.boardSize)}`);
  }
  if (doc.spawnPolicy !== "explicit-user-selected") {
    throw new PracticeLogError("FIELD_MISSING", `spawnPolicy must be "explicit-user-selected", got ${JSON.stringify(doc.spawnPolicy)}`);
  }
  if (!Array.isArray(doc.moves)) {
    throw new PracticeLogError("FIELD_MISSING", "moves must be an array");
  }
  const valid = validateBoard(doc.initialBoard);
  if (JSON.stringify(valid) !== JSON.stringify(doc.initialBoard)) {
    throw new PracticeLogError("INVALID_BOARD", "initialBoard is not a legal value-encoded 4x4 board");
  }
  verifyDocument(doc);
  return doc;
}
