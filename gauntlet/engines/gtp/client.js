/**
 * A minimal GTP client for external Go engines, over `child_process`. Built
 * for GNU Go (`gnugo --mode gtp --level N --seed S`, GPL-3), which runs as a
 * separate program: nothing is vendored, downloaded, bundled or linked.
 *
 * This module follows the `engines/uci/client.js` browser-safety pattern: the
 * game overlay loads game modules in a browser, so importing this module
 * must never evaluate a `node:*` builtin. Every Node builtin is loaded
 * through a computed dynamic import, guarded at module top level and caught,
 * so the module imports cleanly in a browser and only fails — with a clear
 * message — if someone actually tries to run an engine outside Node.
 *
 * Reproducibility contract used by the Gauntlet: the engine is spawned with a
 * fixed `--level` and a nonzero integer `--seed`, and a position is reached
 * by replaying the same move history — so a given seed and move sequence get
 * identical replies. Wall-clock speed is never part of a reply's meaning.
 *
 * @module
 */

/** The environment variable that overrides the gnugo binary lookup. */
export const GTP_ENV_VAR = 'GAUNTLET_GNUGO';

/**
 * Directories probed after PATH when looking an engine up by name. Debian
 * and Ubuntu install game binaries to /usr/games, and a non-interactive
 * PATH often omits that directory.
 *
 * @type {readonly string[]}
 */
export const GTP_EXTRA_DIRS = ['/usr/games', '/usr/local/games'];

/**
 * Node builtins, loaded lazily; null in a browser (see module doc).
 *
 * @type {typeof import('node:child_process') | null}
 */
let cp = null;
/** @type {typeof import('node:fs') | null} */
let fsMod = null;
/** @type {typeof import('node:path') | null} */
let pathMod = null;

try {
  cp = /** @type {typeof import('node:child_process')} */ (await import('node:' + 'child_process'));
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
 * Locate a GTP engine binary. For gnugo lookups (the default name)
 * `GAUNTLET_GNUGO` wins when set and must exist; the override is scoped to
 * the gnugo name so one shared env var cannot silently replace a different
 * engine. Otherwise PATH is scanned, then GTP_EXTRA_DIRS. Synchronous and
 * Node-only.
 *
 * @param {string} [name] Executable name to look up. Default "gnugo".
 * @param {{ searchDirs?: readonly string[] }} [options] Overrides the
 *   directories probed after PATH (tests inject a temp dir here).
 * @returns {string | null} The path, or null when not configured and not
 *   found. Throws when GAUNTLET_GNUGO points at a missing file.
 */
export function findGtpBinary(name = 'gnugo', options = {}) {
  if (!cp || !fsMod || !pathMod) throw nodeRequiredError('locating an engine binary');
  const fromEnv = process.env[GTP_ENV_VAR];
  if (fromEnv !== undefined && fromEnv !== '' && name === 'gnugo') {
    if (!fsMod.existsSync(fromEnv)) {
      throw new Error(`${GTP_ENV_VAR} is set to "${fromEnv}" but that file does not exist`);
    }
    return fromEnv;
  }
  for (const dir of [
    ...(process.env.PATH || '').split(pathMod.delimiter),
    ...(options.searchDirs ?? GTP_EXTRA_DIRS),
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

/**
 * A parsed GTP response: `= payload` on success, `? message` on failure.
 * GTP lets a command carry a numeric id, which the engine must echo
 * (`=3 payload`); `id` is set only when the response carries one.
 *
 * @typedef {object} GtpResponse
 * @property {boolean} ok
 * @property {number | undefined} id The echoed command id, when present.
 * @property {string} payload The text after the marker (and echoed id),
 *   with the trailing blank line removed.
 */

/**
 * Parse one complete GTP response block: the first line starts with `= `
 * (success) or `?` (failure); the block ends at a blank line. Lines before
 * the marker line (some engines print banners) are discarded.
 *
 * @param {string} block
 * @returns {GtpResponse | null} Null when the block holds no response line.
 */
export function parseGtpBlock(block) {
  const lines = block.split('\n');
  let head = 0;
  while (head < lines.length && !/^[=?]/.test(lines[head])) head++;
  if (head >= lines.length) return null;
  const first = lines[head];
  // A leading digit run after the marker is the echoed command id:
  // "=3 GNU Go" answers command "3 name".
  const m = /^([=?])(\d+)\s*(.*)$/.exec(first);
  const marker = m ? m[1] : first[0];
  const id = m ? Number(m[2]) : undefined;
  const headPayload = m ? m[3].trim() : first.slice(1).trim();
  if (marker === '?') {
    const failure = { ok: false, payload: headPayload || 'error' };
    if (id !== undefined) failure.id = id;
    return failure;
  }
  const rest = lines.slice(head + 1).filter((line) => line.trim().length > 0);
  const payload = [headPayload, ...rest].join('\n').trim();
  const response = { ok: true, payload };
  if (id !== undefined) response.id = id;
  return response;
}

/**
 * Children to SIGKILL on process exit, so a crashed run never leaves an
 * orphaned engine holding stdio handles.
 *
 * @type {Set<import('node:child_process').ChildProcess>}
 */
const liveChildren = new Set();
let exitHookInstalled = false;

function installExitHook() {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
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
 * @typedef {object} GtpEngineOptions
 * @property {string} binaryPath Path to the engine executable.
 * @property {string[]} [engineArgs] Full argv after the binary, e.g.
 *   ['--mode', 'gtp', '--level', '5', '--seed', '12345'].
 * @property {number} [commandTimeoutMs] Deadline per command. Default 30000.
 */

/**
 * One spawned GTP engine process. Commands are serialized; each waits for
 * the blank line that terminates a GTP response, with a deadline. A crash or
 * a timeout fails the pending command with an error naming the binary.
 */
export class GtpEngine {
  /** @type {import('node:child_process').ChildProcessByStdio<import('node:stream').Writable, import('node:stream').Readable, null> | null} */
  #child = null;
  /** @type {string} */
  #binaryPath;
  /** @type {string[]} */
  #engineArgs;
  /** @type {number} */
  #commandTimeoutMs;
  /** @type {string} */
  #buffer = '';
  /** @type {Promise<void>} */
  #queue = Promise.resolve();
  /** @type {{ resolve: (r: GtpResponse) => void, reject: (e: Error) => void, timer: NodeJS.Timeout | null, id: number } | null} */
  #pending = null;
  /** @type {string | null} */
  #idName = null;
  /** @type {number} */
  #nextCommandId = 0;
  /** @type {boolean} */
  #engineEchoesIds = false;

  /**
   * @param {GtpEngineOptions} options
   */
  constructor({ binaryPath, engineArgs = [], commandTimeoutMs = 30000 }) {
    if (!cp) throw nodeRequiredError('running a GTP engine');
    this.#binaryPath = binaryPath;
    this.#engineArgs = engineArgs;
    this.#commandTimeoutMs = commandTimeoutMs;
  }

  /** The engine's self-reported `name version`, captured at start. */
  get idName() {
    return this.#idName;
  }

  /**
   * stdin 'error' listener count (0 when not running). Pins the once-at-start
   * handler contract in the tests: it must not grow per command.
   *
   * @returns {number}
   */
  get stdinErrorListenerCount() {
    return this.#child ? this.#child.stdin.listenerCount('error') : 0;
  }

  /** The binary path this engine was spawned from. */
  get binaryPath() {
    return this.#binaryPath;
  }

  /**
   * Spawn the engine and capture its identity via `name` and `version`.
   *
   * @returns {Promise<void>}
   */
  async start() {
    if (!cp) throw nodeRequiredError('running a GTP engine');
    const child = cp.spawn(this.#binaryPath, this.#engineArgs, {
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    this.#child = child;
    installExitHook();
    liveChildren.add(child);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      this.#buffer += String(chunk);
      this.#drain();
    });
    // One protective no-op handler for the process lifetime: a dead engine
    // surfaces as EPIPE on stdin writes, and without any handler the write
    // error crashes the process. Attached once — not per command — so the
    // listener count stays flat across an episode's hundreds of commands.
    child.stdin.on('error', () => {});
    child.on('error', (err) => this.#failPending(new Error(`GTP engine "${this.#binaryPath}" failed to spawn: ${err.message}`)));
    child.on('exit', (code, signal) => {
      liveChildren.delete(child);
      this.#failPending(
        new Error(`GTP engine "${this.#binaryPath}" exited unexpectedly (code ${code ?? 'null'}, signal ${signal ?? 'null'})`)
      );
    });
    const nameResponse = await this.#send('name', this.#commandTimeoutMs);
    const version = await this.#send('version', this.#commandTimeoutMs);
    // The first command carries id 1; an echo means the engine speaks
    // id-tagged GTP and stale replies can be held to id discipline.
    this.#engineEchoesIds = nameResponse.id === 1;
    this.#idName = `${nameResponse.payload} ${version.payload}`.replace(/\s+/g, ' ').trim();
  }

  /**
   * Fail the in-flight command, if any.
   *
   * @param {Error} err
   * @returns {void}
   */
  #failPending(err) {
    const pending = this.#pending;
    if (!pending) return;
    this.#pending = null;
    if (pending.timer) clearTimeout(pending.timer);
    pending.reject(err);
  }

  /**
   * Extract complete response blocks from the buffer and settle the pending
   * command on the first one.
   *
   * @returns {void}
   */
  #drain() {
    for (;;) {
      const pending = this.#pending;
      if (!pending) return;
      const end = this.#buffer.indexOf('\n\n');
      if (end < 0) return;
      const block = this.#buffer.slice(0, end);
      this.#buffer = this.#buffer.slice(end + 2);
      const parsed = parseGtpBlock(block);
      if (!parsed) continue; // Banner-only block; keep scanning.
      // Id discipline: an engine that echoes ids answers in order, so a
      // block whose id predates the pending command is the late reply to a
      // timed-out command — drop it and keep scanning for the live id.
      // (A loop, not a single shot: one chunk can carry several blocks.)
      if (this.#engineEchoesIds && parsed.id !== undefined && parsed.id !== pending.id) continue;
      this.#pending = null;
      if (pending.timer) clearTimeout(pending.timer);
      if (parsed.ok) pending.resolve(parsed);
      else pending.reject(new Error(`GTP command failed: ${parsed.payload}`));
    }
  }

  /**
   * Send one GTP command and wait for its response. Commands are serialized
   * through a promise chain so concurrent callers cannot interleave writes,
   * and each carries an incrementing GTP id (echoed by GNU Go): when a
   * command times out, its late reply is discarded instead of settling the
   * next command.
   *
   * @param {string} text The command line, without a trailing newline.
   * @param {{ timeoutMs?: number }} [options]
   * @returns {Promise<string>} The response payload (text after `= `).
   */
  async command(text, options = {}) {
    const response = await this.#send(text, options.timeoutMs ?? this.#commandTimeoutMs);
    return response.payload;
  }

  /**
   * Queue one id-tagged command write and resolve with the parsed response.
   *
   * @param {string} text The command line, without a trailing newline.
   * @param {number} timeoutMs Deadline for this command.
   * @returns {Promise<GtpResponse>}
   */
  #send(text, timeoutMs) {
    const run = this.#queue.then(
      () =>
        new Promise((resolve, reject) => {
          if (!this.#child) {
            reject(new Error('GTP engine is not running (start() first, or it already quit)'));
            return;
          }
          const id = ++this.#nextCommandId;
          const timer = setTimeout(() => {
            this.#pending = null;
            reject(new Error(`GTP command "${text}" timed out after ${timeoutMs}ms on "${this.#binaryPath}"`));
          }, timeoutMs);
          if (typeof timer.unref === 'function') timer.unref();
          this.#pending = { resolve, reject, timer, id };
          // A dead engine surfaces as EPIPE on the write; the single no-op
          // stdin error handler from start() keeps the process alive, and
          // the write callback fails the pending command with a clear error.
          this.#child.stdin.write(`${id} ${text}\n`, (err) => {
            if (err) {
              this.#failPending(new Error(`GTP engine "${this.#binaryPath}" stdin write failed: ${err.message}`));
            }
          });
        })
    );
    this.#queue = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  /**
   * Set the board size.
   *
   * @param {number} size
   * @returns {Promise<void>}
   */
  async boardsize(size) {
    await this.command(`boardsize ${size}`);
  }

  /**
   * Clear the board (and, in GNU Go, the move history).
   *
   * @returns {Promise<void>}
   */
  async clearBoard() {
    await this.command('clear_board');
  }

  /**
   * Set komi.
   *
   * @param {number} komi
   * @returns {Promise<void>}
   */
  async komi(komi) {
    await this.command(`komi ${komi}`);
  }

  /**
   * Play a move for a colour.
   *
   * @param {'black' | 'white'} color
   * @param {string} vertex A GTP vertex like "D4", or "pass".
   * @returns {Promise<void>}
   */
  async play(color, vertex) {
    await this.command(`play ${color} ${vertex}`);
  }

  /**
   * Ask the engine for a move; the engine plays it on its own board.
   *
   * @param {'black' | 'white'} color
   * @param {{ timeoutMs?: number }} [options]
   * @returns {Promise<string>} A GTP vertex like "D4", or "PASS"/"RESIGN".
   */
  async genmove(color, options = {}) {
    return this.command(`genmove ${color}`, options);
  }

  /**
   * Quit the engine politely and resolve when the process is gone (or after
   * killing it on a short grace).
   *
   * @returns {Promise<void>}
   */
  async quit() {
    const child = this.#child;
    if (!child) return;
    this.#child = null;
    try {
      await this.command('quit', { timeoutMs: 2000 });
    } catch {
      // Engine may already be gone; the kill below settles it either way.
    }
    if (!child.killed && child.exitCode === null) {
      try {
        child.kill('SIGTERM');
      } catch {
        // Already gone.
      }
    }
    await /** @type {Promise<void>} */ (new Promise((resolve) => {
      const done = setTimeout(() => resolve(), 1500);
      if (typeof done.unref === 'function') done.unref();
      child.once('exit', () => {
        clearTimeout(done);
        resolve();
      });
    }));
  }

  /**
   * Shutdown alias used by the runner's dispose path.
   *
   * @returns {Promise<void>}
   */
  async dispose() {
    await this.quit();
  }
}
