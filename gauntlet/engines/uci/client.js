/**
 * A minimal UCI client for external chess engines, over `child_process`.
 *
 * This module is the one place in `gauntlet/` that is allowed to touch Node
 * builtins, and it does so carefully: the game overlay loads game modules in
 * a browser, so importing this module must never evaluate a `node:*` builtin.
 * Every Node builtin here is loaded through a computed dynamic import (which
 * bundlers cannot statically resolve), guarded at module top level and caught,
 * so the module imports cleanly in a browser and only fails — with a clear
 * message — if someone actually tries to run an engine outside Node.
 *
 * Reproducibility contract used by the Gauntlet (see games/chess/
 * chess-stockfish.js): the engine runs with Threads 1 and a fixed Hash, gets
 * `ucinewgame` once per episode, and is asked `go nodes N` — never
 * `go movetime` — so a given seed replays identically on the same binary.
 * The engine's `id name` line is captured and recorded in opponent ids and
 * trajectory metadata, because two Stockfish versions are not the same
 * opponent.
 *
 * Licensing note: engines driven through this client (Stockfish is GPL-3.0)
 * run as separate programs; nothing is vendored, downloaded, bundled or
 * linked. See README.md in this directory.
 *
 * @module
 */

/** The environment variable that overrides engine binary lookup. */
export const STOCKFISH_ENV_VAR = 'GAUNTLET_STOCKFISH';

/**
 * Directories probed after PATH when looking an engine up by name. Debian
 * and Ubuntu install game binaries to /usr/games, and a non-interactive
 * PATH (CI, cron, systemd) often omits that directory.
 *
 * @type {readonly string[]}
 */
export const ENGINE_EXTRA_DIRS = ['/usr/games', '/usr/local/games'];

/** Default transposition-table size (MiB) configured on spawned engines. */
export const DEFAULT_HASH_MB = 16;

/**
 * Node builtins, loaded lazily. In Node these resolve during module
 * evaluation; in a browser the dynamic imports reject, the catch leaves them
 * null, and only the functions that actually need Node throw.
 *
 * @type {typeof import('node:child_process') | null}
 */
let cp = null;
/** @type {typeof import('node:fs') | null} */
let fsMod = null;
/** @type {typeof import('node:path') | null} */
let pathMod = null;

try {
  // Computed specifier on purpose: a bundler must not try to resolve this at
  // build time. The await here is a top-level await (ES2022): importers simply
  // wait a microtask in Node, and the catch keeps browsers working.
  cp = /** @type {typeof import('node:child_process')} */ (
    await import('node:' + 'child_process')
  );
  fsMod = /** @type {typeof import('node:fs')} */ (await import('node:' + 'fs'));
  pathMod = /** @type {typeof import('node:path')} */ (await import('node:' + 'path'));
} catch {
  // Browser (or another non-Node runtime): keep the module importable.
}

/**
 * @param {string} what
 * @returns {Error}
 */
function nodeRequiredError(what) {
  return new Error(
    `${what} requires Node.js (this module is browser-import-safe but can only run engines under Node)`
  );
}

/**
 * Parse a UCI `id name ...` line. Returns null for anything else.
 *
 * @param {string} line
 * @returns {string | null} The engine's self-reported name, or null.
 */
export function parseIdName(line) {
  if (line.startsWith('id name ')) return line.slice('id name '.length).trim();
  return null;
}

/**
 * Parse a UCI `bestmove` line: `bestmove e2e4 ponder e7e5` or
 * `bestmove (none)` (no legal moves).
 *
 * @param {string} line
 * @returns {{ bestmove: string, ponder: string | null } | null}
 */
export function parseBestmove(line) {
  if (!line.startsWith('bestmove ')) return null;
  const parts = line.split(/\s+/);
  // ['bestmove', '<move>', 'ponder'?, '<move>'?]
  const bestmove = parts[1] ?? '(none)';
  const ponderIndex = parts.indexOf('ponder');
  return {
    bestmove,
    ponder: ponderIndex > 1 ? (parts[ponderIndex + 1] ?? null) : null,
  };
}

/**
 * Parse a UCI `info ...` line into its numeric fields plus the principal
 * variation. Unrecognised or missing fields become null.
 *
 * @param {string} line
 * @returns {UciInfo | null} Null when the line is not an info line.
 * @typedef {object} UciInfo
 * @property {number | null} depth Search depth.
 * @property {number | null} seldepth Selective search depth.
 * @property {number | null} multipv Multi-PV index (1-based).
 * @property {number | null} scoreCp Score in centipawns, from the engine's
 *   point of view.
 * @property {number | null} scoreMate Distance to mate in plies, signed.
 * @property {number | null} nodes Nodes searched so far.
 * @property {number | null} nps Reported nodes per second.
 * @property {number | null} timeMs Reported search wall time in milliseconds.
 * @property {string | null} pv The principal variation, space-separated UCI.
 */
export function parseInfoLine(line) {
  if (!line.startsWith('info ')) return null;
  /** @type {UciInfo} */
  const info = {
    depth: null,
    seldepth: null,
    multipv: null,
    scoreCp: null,
    scoreMate: null,
    nodes: null,
    nps: null,
    timeMs: null,
    pv: null,
  };
  const parts = line.split(/\s+/);
  for (let i = 1; i < parts.length; i++) {
    const next = parts[i + 1];
    switch (parts[i]) {
      case 'depth':
        info.depth = numberOrNull(next);
        break;
      case 'seldepth':
        info.seldepth = numberOrNull(next);
        break;
      case 'multipv':
        info.multipv = numberOrNull(next);
        break;
      case 'nodes':
        info.nodes = numberOrNull(next);
        break;
      case 'nps':
        info.nps = numberOrNull(next);
        break;
      case 'time':
        info.timeMs = numberOrNull(next);
        break;
      case 'pv': {
        const rest = parts.slice(i + 1).filter((p) => p !== 'upperbound' && p !== 'lowerbound');
        info.pv = rest.length > 0 ? rest.join(' ') : null;
        i = parts.length; // pv runs to end of line
        break;
      }
      case 'score':
        if (next === 'cp') info.scoreCp = numberOrNull(parts[i + 2]);
        else if (next === 'mate') info.scoreMate = numberOrNull(parts[i + 2]);
        break;
      default:
        break;
    }
  }
  return info;
}

/**
 * @param {string | undefined} text
 * @returns {number | null}
 */
function numberOrNull(text) {
  if (text === undefined) return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

/**
 * One engine-advertised UCI option.
 *
 * @typedef {object} UciOption
 * @property {string} name Option name (may contain spaces).
 * @property {string} type UCI type: check, spin, combo, button, string.
 * @property {string | null} defaultValue Raw default from the engine.
 * @property {number | null} min Spin minimum.
 * @property {number | null} max Spin maximum.
 * @property {string[]} vars Combo choices, in advertisement order.
 */

/**
 * Parse one `option name <name> type <type> [default v] [min n] [max n]
 * [var x]...` line. Option names may contain spaces: every token between the
 * `name` keyword and the `type` keyword belongs to the name. Returns null
 * for anything that is not a well-formed option line.
 *
 * @param {string} line
 * @returns {UciOption | null}
 */
export function parseOptionLine(line) {
  if (!line.startsWith('option ')) return null;
  const tokens = line.split(/\s+/);
  if (tokens[1] !== 'name') return null;
  let i = 2;
  const nameParts = [];
  while (i < tokens.length && tokens[i] !== 'type') {
    nameParts.push(tokens[i]);
    i++;
  }
  if (i >= tokens.length || nameParts.length === 0) return null;
  i++; // skip 'type'
  const type = tokens[i];
  if (type === undefined) return null;
  i++;
  /** @type {UciOption} */
  const option = {
    name: nameParts.join(' '),
    type,
    defaultValue: null,
    min: null,
    max: null,
    vars: [],
  };
  while (i < tokens.length) {
    const keyword = tokens[i];
    i++;
    if (keyword === 'default' || keyword === 'min' || keyword === 'max') {
      const value = tokens[i];
      if (value === undefined) return null;
      i++;
      if (keyword === 'default') option.defaultValue = value;
      else if (keyword === 'min') option.min = Number(value);
      else option.max = Number(value);
    } else if (keyword === 'var') {
      const value = tokens[i];
      if (value === undefined) return null;
      i++;
      option.vars.push(value);
    } else {
      return null;
    }
  }
  return option;
}

/**
 * Locate an engine binary. For Stockfish lookups (the default name)
 * `GAUNTLET_STOCKFISH` wins when set and must exist; the override is
 * deliberately scoped to the Stockfish name so one shared env var cannot
 * silently replace a different engine the caller asked for by name.
 * Otherwise PATH is scanned for `name` (plus a `.exe` variant), then
 * ENGINE_EXTRA_DIRS. Synchronous and Node-only.
 *
 * @param {string} [name] Executable name to look for on PATH. Default "stockfish".
 * @param {{ searchDirs?: readonly string[] }} [options] Overrides the
 *   directories probed after PATH (tests inject a temp dir here).
 * @returns {string | null} Absolute-ish path, or null when not configured and
 *   not found. Throws when GAUNTLET_STOCKFISH points at a missing file.
 */
export function findEngineBinary(name = 'stockfish', options = {}) {
  if (!cp || !fsMod || !pathMod) throw nodeRequiredError('locating an engine binary');
  const fromEnv = process.env[STOCKFISH_ENV_VAR];
  if (fromEnv !== undefined && fromEnv !== '' && name === 'stockfish') {
    if (!fsMod.existsSync(fromEnv)) {
      throw new Error(
        `${STOCKFISH_ENV_VAR} is set to "${fromEnv}" but that file does not exist`
      );
    }
    return fromEnv;
  }
  for (const dir of [
    ...(process.env.PATH || '').split(pathMod.delimiter),
    ...(options.searchDirs ?? ENGINE_EXTRA_DIRS),
  ]) {
    if (!dir) continue;
    for (const candidate of [pathMod.join(dir, name), pathMod.join(dir, `${name}.exe`)]) {
      try {
        fsMod.accessSync(candidate, fsMod.constants.X_OK);
        const stat = fsMod.statSync(candidate);
        if (stat.isFile()) return candidate;
      } catch {
        // Not here; keep scanning.
      }
    }
  }
  return null;
}

/** @type {Map<string, string | null>} */
const idNameCache = new Map();

/**
 * Ask an engine for its `id name` line synchronously: spawn it, speak the
 * handshake, quit. Cached per binary path so repeated `opponent()` calls do
 * not re-spawn. Node-only; returns null when the engine cannot be spawned or
 * says nothing (the caller falls back to an "unknown" id).
 *
 * @param {string | null} binaryPath
 * @returns {string | null}
 */
export function probeEngineIdSync(binaryPath) {
  if (!binaryPath) return null;
  if (idNameCache.has(binaryPath)) return /** @type {string | null} */ (idNameCache.get(binaryPath));
  if (!cp) throw nodeRequiredError('probing an engine id');
  /** @type {string | null} */
  let probed = null;
  try {
    const result = cp.spawnSync(binaryPath, [], {
      input: 'uci\nisready\nquit\n',
      timeout: 10000,
      encoding: 'utf8',
    });
    if (result.stdout) {
      for (const line of result.stdout.split('\n')) {
        const idName = parseIdName(line.trim());
        if (idName) {
          probed = idName;
          break;
        }
      }
    }
  } catch {
    probed = null;
  }
  idNameCache.set(binaryPath, probed);
  return probed;
}

/**
 * Slug an `id name` line for use in an agent id: the part before " by "
 * ("Stockfish 17.1 by the Stockfish developers (see AUTHORS file)" becomes
 * "stockfish-17.1"). Returns null when nothing usable remains.
 *
 * @param {string | null} idName
 * @returns {string | null}
 */
export function engineIdSlug(idName) {
  if (!idName) return null;
  const head = idName.split(' by ')[0];
  const slug = head
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug.length > 0 ? slug : null;
}

/** @type {Set<import('node:child_process').ChildProcess>} */
const liveChildren = new Set();
let exitHookInstalled = false;

function installExitHook() {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  // Engines are killed hard on process exit so a test run or harness can never
  // hang on an orphaned child's open stdio handles.
  process.on('exit', () => {
    for (const child of liveChildren) {
      try {
        child.kill('SIGKILL');
      } catch {
        // Already gone.
      }
    }
  });
}

/**
 * @typedef {object} UciEngineOptions
 * @property {string} binaryPath Path to the engine executable.
 * @property {string[]} [engineArgs] Extra argv after the binary path.
 * @property {number} [commandTimeoutMs] Deadline per handshake/config command.
 *   Default 30000.
 * @property {number} [searchTimeoutMs] Deadline per `go` search. Default
 *   300000 (five minutes): node-budget searches can legitimately take a while
 *   on throttled CPUs.
 * @property {number} [idleTimeoutMs] Kill the engine after this many
 *   milliseconds without a command (0 disables). Default 60000. The timer is
 *   unref'd, so it never keeps the event loop alive.
 */

/**
 * Result of one `go nodes` search: the engine's move, its optional ponder
 * hint, and the last parsed `info` line (search statistics).
 *
 * @typedef {object} UciGoResult
 * @property {string} bestmove The engine's move in UCI, or "(none)".
 * @property {string | null} ponder The ponder move, when offered.
 * @property {UciInfo | null} info The final info line of the search.
 * @property {string[]} infoLines The raw info lines the search emitted.
 */

/**
 * One spawned UCI engine process. Commands are serialized; each waits for its
 * protocol terminator (`uciok`, `readyok`, `bestmove`, ...) with a deadline. A
 * crash or a timeout fails the pending command with an error that names the
 * binary and what happened.
 */
export class UciEngine {
  /** @type {import('node:child_process').ChildProcessWithoutNullStreams | null} */
  #child = null;
  /** @type {string} */
  #binaryPath;
  /** @type {string[]} */
  #engineArgs;
  /** @type {number} */
  #commandTimeoutMs;
  /** @type {number} */
  #searchTimeoutMs;
  /** @type {number} */
  #idleTimeoutMs;
  /** @type {string | null} */
  #idName = null;
  /** @type {string[]} */
  #stderrTail = [];
  /** @type {{ code: number | null, signal: string | null } | null} */
  #exit = null;
  /** @type {Promise<void> | null} */
  #quitPromise = null;
  /** @type {NodeJS.Timeout | null} */
  #idleTimer = null;
  /** @type {((line: string) => boolean) | null} */
  #matcher = null;
  /** @type {(result: { lines: string[] }) => void} */
  #resolvePending = () => {};
  /** @type {(err: Error) => void} */
  #rejectPending = () => {};
  /** @type {string[]} */
  #pendingLines = [];
  /** @type {NodeJS.Timeout | null} */
  #pendingTimer = null;
  #buffer = '';

  /**
   * @param {UciEngineOptions} options
   */
  constructor(options) {
    if (!options.binaryPath) {
      throw new Error('UciEngine requires options.binaryPath');
    }
    this.#binaryPath = options.binaryPath;
    this.#engineArgs = options.engineArgs ?? [];
    this.#commandTimeoutMs = options.commandTimeoutMs ?? 30000;
    this.#searchTimeoutMs = options.searchTimeoutMs ?? 300000;
    this.#idleTimeoutMs = options.idleTimeoutMs ?? 60000;
  }

  /** Engine-advertised UCI options from the handshake, keyed by option name. */
  #options = /** @type {Map<string, UciOption>} */ (new Map());

  /** Engine-advertised UCI options, keyed by option name. */
  get options() {
    return this.#options;
  }

  /** The engine's self-reported `id name` line, captured during the handshake. */
  get idName() {
    return this.#idName;
  }

  /** The binary this client was pointed at. */
  get binaryPath() {
    return this.#binaryPath;
  }

  /**
   * Spawn the engine and run the UCI handshake (`uci`/`uciok`, then
   * `isready`/`readyok`).
   *
   * @returns {Promise<this>}
   */
  async start() {
    if (!cp) throw nodeRequiredError('starting an engine');
    installExitHook();
    let child;
    try {
      child = cp.spawn(this.#binaryPath, this.#engineArgs, {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      throw this.#spawnError(err);
    }
    this.#child = child;
    liveChildren.add(child);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => this.#onStdout(/** @type {string} */ (chunk)));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      const text = /** @type {string} */ (chunk);
      for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (trimmed) this.#stderrTail.push(trimmed);
      }
      if (this.#stderrTail.length > 20) this.#stderrTail.splice(0, this.#stderrTail.length - 20);
    });
    child.on('error', (err) => {
      // ENOENT and friends: the binary is missing or not executable.
      this.#exit = { code: null, signal: null };
      this.#failPending(this.#spawnError(err));
    });
    // A dead engine's stdin surfaces EPIPE here; fail the pending command
    // instead of throwing an unhandled stream error.
    child.stdin.on('error', (err) => {
      this.#failPending(this.#spawnError(err));
    });
    child.on('close', (code, signal) => {
      this.#exit = { code, signal };
      liveChildren.delete(child);
      this.#failPending(this.#exitError());
    });
    const uciReply = await this.#request(
      'uci',
      (line) => line === 'uciok',
      this.#commandTimeoutMs
    );
    // Remember what the engine advertises so callers can pin options only
    // where they exist (Stockfish builds differ: e.g. Contempt was removed).
    this.#options = new Map();
    for (const line of uciReply.lines) {
      const option = parseOptionLine(line);
      if (option) this.#options.set(option.name, option);
    }
    await this.#request('isready', (line) => line === 'readyok', this.#commandTimeoutMs);
    this.#armIdleTimer();
    return this;
  }

  /**
   * @param {unknown} err
   * @returns {Error}
   */
  #spawnError(err) {
    const detail = err instanceof Error ? err.message : String(err);
    return new Error(
      `could not spawn the engine binary at "${this.#binaryPath}": ${detail}. ` +
        `Set ${STOCKFISH_ENV_VAR} to a working engine binary or install the engine on PATH`
    );
  }

  /**
   * @returns {Error}
   */
  #exitError() {
    const tail = this.#stderrTail.length > 0 ? ` stderr tail: ${this.#stderrTail.join(' | ')}` : '';
    const exit = this.#exit ?? { code: null, signal: null };
    return new Error(
      `the engine at "${this.#binaryPath}" exited unexpectedly ` +
        `(code=${exit.code === null ? 'none' : exit.code}, signal=${exit.signal ?? 'none'})${tail}`
    );
  }

  /**
   * @param {string} chunk
   */
  #onStdout(chunk) {
    this.#buffer += chunk;
    let newline = this.#buffer.indexOf('\n');
    while (newline !== -1) {
      const line = this.#buffer.slice(0, newline).replace(/\r$/, '').trim();
      this.#buffer = this.#buffer.slice(newline + 1);
      if (line) this.#onLine(line);
      newline = this.#buffer.indexOf('\n');
    }
  }

  /**
   * @param {string} line
   */
  #onLine(line) {
    if (this.#idName === null) {
      const idName = parseIdName(line);
      if (idName) this.#idName = idName;
    }
    if (!this.#matcher) return;
    this.#pendingLines.push(line);
    if (this.#matcher(line)) {
      const lines = this.#pendingLines;
      this.#clearPending();
      this.#resolvePending({ lines });
    }
  }

  /**
   * Send one command and wait for its terminator line.
   *
   * @param {string} command
   * @param {(line: string) => boolean} match Recognises the terminator line.
   * @param {number} timeoutMs
   * @returns {Promise<{ lines: string[] }>}
   */
  #request(command, match, timeoutMs) {
    return new Promise((resolve, reject) => {
      if (this.#exit) {
        reject(this.#exitError());
        return;
      }
      if (this.#matcher) {
        reject(new Error(`a UCI command is already in flight; commands must be sent one at a time`));
        return;
      }
      const child = this.#child;
      if (!child || !child.stdin.writable) {
        reject(new Error(`the engine at "${this.#binaryPath}" has no writable stdin`));
        return;
      }
      this.#matcher = match;
      this.#pendingLines = [];
      this.#resolvePending = resolve;
      this.#rejectPending = reject;
      this.#pendingTimer = setTimeout(() => {
        const err = new Error(
          `the engine at "${this.#binaryPath}" did not respond to "${command}" within ${timeoutMs}ms`
        );
        // A timed-out command leaves the protocol desynced; the engine is dead
        // to us. Fail everything and kill it.
        this.#clearPending();
        reject(err);
        this.#dispose();
      }, timeoutMs);
      this.#cancelIdleTimer();
      child.stdin.write(`${command}\n`, (writeError) => {
        if (writeError) {
          this.#clearPending();
          reject(
            new Error(
              `writing "${command}" to the engine at "${this.#binaryPath}" failed: ${writeError.message}`
            )
          );
        }
      });
    });
  }

  #clearPending() {
    if (this.#pendingTimer) clearTimeout(this.#pendingTimer);
    this.#pendingTimer = null;
    this.#matcher = null;
    this.#pendingLines = [];
  }

  #armIdleTimer() {
    if (this.#idleTimeoutMs <= 0) return;
    this.#cancelIdleTimer();
    this.#idleTimer = setTimeout(() => {
      this.#dispose();
    }, this.#idleTimeoutMs);
    // Never keep the event loop (or a test process) alive just to reap.
    this.#idleTimer.unref();
  }

  #cancelIdleTimer() {
    if (this.#idleTimer) clearTimeout(this.#idleTimer);
    this.#idleTimer = null;
  }

  #dispose() {
    this.#clearPending();
    const child = this.#child;
    if (child) {
      liveChildren.delete(child);
      try {
        child.kill('SIGKILL');
      } catch {
        // Already gone.
      }
    }
  }

  /**
   * Raw write of one command line, no waiter. Used for response-less UCI
   * commands, which are confirmed by a following `isready`.
   *
   * @param {string} command
   */
  #write(command) {
    const child = this.#child;
    if (!child || this.#exit) throw this.#exitError();
    if (!child.stdin.writable) {
      throw new Error(`the engine at "${this.#binaryPath}" has no writable stdin`);
    }
    child.stdin.write(`${command}\n`);
  }

  /**
   * Fail the in-flight command, if any. Called when the engine crashes,
   * cannot be spawned, or its stdin breaks.
   *
   * @param {Error} err
   */
  #failPending(err) {
    if (!this.#matcher) return;
    const reject = this.#rejectPending;
    this.#clearPending();
    reject(err);
  }

  /**
   * Set a UCI option and confirm it landed with `isready`. Values are
   * stringified.
   *
   * @param {string} name
   * @param {string | number | boolean} value
   * @returns {Promise<void>}
   */
  async setoption(name, value) {
    const rendered = typeof value === 'boolean' ? (value ? 'true' : 'false') : String(value);
    this.#write(`setoption name ${name} value ${rendered}`);
    await this.#request('isready', (line) => line === 'readyok', this.#commandTimeoutMs);
  }

  /**
   * `ucinewgame`: clear engine state for a fresh episode, confirmed by
   * `isready`.
   *
   * @returns {Promise<void>}
   */
  async ucinewgame() {
    this.#write('ucinewgame');
    await this.#request('isready', (line) => line === 'readyok', this.#commandTimeoutMs);
  }

  /**
   * Send `position fen <fen> [moves ...]`. Fire-and-forget: correctness is
   * confirmed by the following search.
   *
   * @param {string} fen
   * @param {readonly string[]} [moves] UCI moves after the FEN.
   */
  position(fen, moves = []) {
    const child = this.#child;
    if (!child || this.#exit) throw this.#exitError();
    const suffix = moves.length > 0 ? ` moves ${moves.join(' ')}` : '';
    child.stdin.write(`position fen ${fen}${suffix}\n`);
  }

  /**
   * Send `position startpos [moves ...]`.
   *
   * @param {readonly string[]} [moves]
   */
  positionStart(moves = []) {
    const child = this.#child;
    if (!child || this.#exit) throw this.#exitError();
    const suffix = moves.length > 0 ? ` moves ${moves.join(' ')}` : '';
    child.stdin.write(`position startpos${suffix}\n`);
  }

  /**
   * Send `position fen <fen> [moves ...]`. Fire-and-forget: correctness is
   * confirmed by the following search's bestmove.
   *
   * @param {string} fen
   * @param {readonly string[]} [moves]
   */
  positionFen(fen, moves = []) {
    const child = this.#child;
    if (!child || this.#exit) throw this.#exitError();
    if (!child.stdin.writable) {
      throw new Error(`the engine at "${this.#binaryPath}" has no writable stdin`);
    }
    const suffix = moves.length > 0 ? ` moves ${moves.join(' ')}` : '';
    child.stdin.write(`position fen ${fen}${suffix}\n`);
  }

  /**
   * Search under a hard node budget: `go nodes <nodes>`. Never uses movetime,
   * so the result is a pure function of (binary, position, options, nodes).
   *
   * @param {number} nodes Positive integer node budget.
   * @param {{ searchTimeoutMs?: number }} [options]
   * @returns {Promise<UciGoResult>}
   */
  async goNodes(nodes, options = {}) {
    if (!Number.isInteger(nodes) || nodes <= 0) {
      throw new Error(`goNodes: nodes must be a positive integer, got ${nodes}`);
    }
    const timeoutMs = options.searchTimeoutMs ?? this.#searchTimeoutMs;
    const { lines } = await this.#request(
      `go nodes ${nodes}`,
      (line) => line.startsWith('bestmove'),
      timeoutMs
    );
    const bestmoveLine = lines.find((line) => line.startsWith('bestmove'));
    const parsed = bestmoveLine ? parseBestmove(bestmoveLine) : null;
    if (!parsed) {
      throw new Error(
        `the engine at "${this.#binaryPath}" ended its search without a bestmove line`
      );
    }
    const infoLines = lines.filter((line) => line.startsWith('info '));
    const withPv = [...infoLines].reverse().find((line) => line.includes(' pv '));
    const info = parseInfoLine(withPv ?? infoLines[infoLines.length - 1] ?? '');
    this.#armIdleTimer();
    return { bestmove: parsed.bestmove, ponder: parsed.ponder, info, infoLines };
  }

  /**
   * Ask the engine to quit; resolves when the process is gone (killed hard
   * after a grace period). Idempotent.
   *
   * @returns {Promise<void>}
   */
  quit() {
    if (this.#quitPromise) return this.#quitPromise;
    this.#cancelIdleTimer();
    this.#quitPromise = (async () => {
      const child = this.#child;
      if (!child || this.#exit) return;
      try {
        child.stdin.write('quit\n');
      } catch {
        // stdin already closed; the kill below handles it.
      }
      await new Promise((resolve) => {
        const done = () => resolve(undefined);
        if (this.#exit) {
          done();
          return;
        }
        const grace = setTimeout(done, 1000);
        grace.unref();
        child.once('close', () => {
          clearTimeout(grace);
          done();
        });
      });
      this.#dispose();
    })();
    return this.#quitPromise;
  }
}
