/**
 * Fixture 2048 game engine — the page-side game under test.
 *
 * This is an INDEPENDENT implementation of standard 2048 rules, written
 * differently from both the solver's move simulators (bit rotations) and the
 * benchmark's reference arbiter (line extraction). It uses a per-cell sweep
 * toward the direction of travel and a different PRNG (xorshift32 vs the
 * reference's mulberry32). When engine and reference agree, the rules are
 * verified from two directions.
 *
 * The engine holds STATE ONLY. Rendering is delegated to an onRender callback
 * supplied by the fixture page (each DOM shape renders itself).
 *
 * Every input the page receives and every move the engine applies is logged
 * for benchmark attribution (window.__BENCH__ exposure happens in bootstrap).
 */

/**
 * xorshift32 PRNG — deliberately NOT mulberry32 (the reference arbiter's
 * PRNG), so fixture spawns and reference replays are independent streams that
 * must still agree because the schedule is fully recorded.
 */
export function xorshift32(seed) {
  let s = seed >>> 0 || 0x9e3779b9;
  return function nextRandom() {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
}

const DIRECTION_VECTORS = [
  [-1, 0], // 0 = Up
  [0, 1], //  1 = Right
  [1, 0], //  2 = Down
  [0, -1], // 3 = Left
];

const KEY_TO_DIRECTION = {
  ArrowUp: 0,
  ArrowRight: 1,
  ArrowDown: 2,
  ArrowLeft: 3,
};

export function directionFromKey(key) {
  const dir = KEY_TO_DIRECTION[key];
  return dir === undefined ? null : dir;
}

export class FixtureGame {
  /**
   * @param {object} options
   * @param {number} options.seed PRNG seed for spawns and scripted history
   * @param {number[][]} [options.initialBoard] fixed starting board (values)
   * @param {string} [options.scenario] normal | late | gameover | vanish | swap
   * @param {(state: {board:number[][], score:number, gameOver:boolean, won:boolean}) => void} options.onRender
   */
  constructor({ seed = 1, initialBoard = null, scenario = "normal", onRender }) {
    this.rng = xorshift32(seed);
    this.seed = seed;
    this.scenario = scenario;
    this.onRender = onRender || (() => {});
    this.board = initialBoard
      ? initialBoard.map((row) => row.slice())
      : Array.from({ length: 4 }, () => [0, 0, 0, 0]);
    this.score = 0;
    this.gameOver = false;
    this.won = false;
    /** Every input event the page received (filled by bootstrap wiring). */
    this.inputLog = [];
    /** Every applied move: {dir, before, after, spawn, score, t} */
    this.moveLog = [];
    /** Keydowns the game received but that did not change the board. */
    this.ignoredKeydowns = 0;

    if (!initialBoard) {
      this.spawnRandomTile();
      this.spawnRandomTile();
    }

    if (scenario === "late") {
      // Advance with scripted valid moves so the game starts mid-run.
      const steps = 6 + Math.floor(this.rng() * 6);
      for (let i = 0; i < steps; i += 1) {
        const dirs = [0, 1, 2, 3].filter((d) => this.isValid(d));
        if (!dirs.length) break;
        this.applyMove(dirs[Math.floor(this.rng() * dirs.length)], {
          record: false,
        });
      }
    }

    if (scenario === "gameover") {
      // Dead board: no empty cells, no adjacent equal tiles.
      this.board = [
        [2, 4, 2, 4],
        [4, 2, 4, 2],
        [2, 4, 2, 4],
        [4, 2, 4, 2],
      ];
      this.score = 1284;
      this.gameOver = true;
    }

    this.revalidateGameOver();
    this.render();
  }

  cloneBoard(board = this.board) {
    return board.map((row) => row.slice());
  }

  boardCopy() {
    return this.cloneBoard();
  }

  spawnRandomTile() {
    const empty = [];
    for (let r = 0; r < 4; r += 1) {
      for (let c = 0; c < 4; c += 1) {
        if (this.board[r][c] === 0) empty.push([r, c]);
      }
    }
    if (!empty.length) return null;
    const [r, c] = empty[Math.floor(this.rng() * empty.length)];
    const value = this.rng() < 0.9 ? 2 : 4;
    this.board[r][c] = value;
    return { r, c, value };
  }

  /** Simulate (on a scratch board) whether `dir` changes anything. */
  isValid(dir) {
    const scratch = this.cloneBoard();
    return this.sweepBoard(scratch, dir).changed;
  }

  /**
   * Slide-and-merge sweep on an arbitrary board toward `dir`.
   * Returns {changed, gained}.
   */
  sweepBoard(board, dir) {
    const [dr, dc] = DIRECTION_VECTORS[dir];
    const rows = dr === 1 ? [3, 2, 1, 0] : [0, 1, 2, 3];
    const cols = dc === 1 ? [3, 2, 1, 0] : [0, 1, 2, 3];
    const merged = Array.from({ length: 4 }, () => [false, false, false, false]);
    let changed = false;
    let gained = 0;

    for (const r of rows) {
      for (const c of cols) {
        const v = board[r][c];
        if (!v) continue;
        let nr = r;
        let nc = c;
        let merge = false;
        for (;;) {
          const tr = nr + dr;
          const tc = nc + dc;
          if (tr < 0 || tr > 3 || tc < 0 || tc > 3) break;
          if (board[tr][tc] === 0) {
            nr = tr;
            nc = tc;
            continue;
          }
          if (board[tr][tc] === v && !merged[tr][tc]) {
            nr = tr;
            nc = tc;
            merge = true;
          }
          break;
        }
        if (nr !== r || nc !== c) {
          changed = true;
          board[r][c] = 0;
          board[nr][nc] = merge ? v * 2 : v;
          if (merge) {
            merged[nr][nc] = true;
            gained += v * 2;
          }
        }
      }
    }
    return { changed, gained };
  }

  revalidateGameOver() {
    if (this.gameOver) return;
    const anyValid = [0, 1, 2, 3].some((d) => this.isValid(d));
    if (!anyValid) {
      this.gameOver = true;
      this.render();
    }
  }

  /**
   * Apply a move if it changes the board; on success spawn the next tile.
   * @param {0|1|2|3} dir
   * @param {{record?: boolean}} [options]
   * @returns {{changed: boolean}}
   */
  applyMove(dir, options = {}) {
    const record = options.record !== false;
    const before = this.boardCopy();
    const scratch = this.cloneBoard(before);
    const { changed, gained } = this.sweepBoard(scratch, dir);

    if (changed) {
      this.board = scratch;
      this.score += gained;
      const spawn = this.spawnRandomTile();
      this.won =
        this.won || this.board.some((row) => row.some((v) => v >= 2048));
      if (record) {
        this.moveLog.push({
          dir,
          before,
          after: this.boardCopy(),
          spawn,
          gained,
          score: this.score,
          t: performance.now(),
        });
      }
      if (this.won && this.board.flat().includes(2048) && !this._winReported) {
        // Real play2048.co adds a .game-won class when 2048 is first reached.
        this._winReported = true;
      }
      this.revalidateGameOver();
      this.render();
    }
    return { changed };
  }

  /** Handle a keyboard event; returns the direction applied (or null). */
  handleKeydown(key) {
    const dir = directionFromKey(key);
    if (dir === null) return null;
    const { changed } = this.applyMove(dir);
    if (!changed) this.ignoredKeydowns += 1;
    return changed ? dir : null;
  }

  /** Handle a swipe; returns the direction applied (or null). */
  handleSwipe(dir) {
    const { changed } = this.applyMove(dir);
    return changed ? dir : null;
  }

  replaceWithNewGame(newSeed) {
    this.seed = newSeed;
    this.rng = xorshift32(newSeed);
    this.board = Array.from({ length: 4 }, () => [0, 0, 0, 0]);
    this.score = 0;
    this.gameOver = false;
    this.won = false;
    this.spawnRandomTile();
    this.spawnRandomTile();
    this.render();
  }

  detachBoardDom() {
    // Renderer hook: fixture pages assign this to remove the board element.
    if (typeof this.onVanish === "function") this.onVanish();
    this.render();
  }

  render() {
    this.onRender({
      board: this.boardCopy(),
      score: this.score,
      gameOver: this.gameOver,
      won: this.won,
    });
  }
}
