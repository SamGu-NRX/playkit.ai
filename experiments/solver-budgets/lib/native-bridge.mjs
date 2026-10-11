/**
 * Persistent-process bridge to the native C++ solver shim
 * (experiments/solver-budgets/native/shim.cpp).
 *
 * One child process per ARM (not per game/move) so the strategy's internal
 * caches persist across a game exactly like the real runtime's StrategyWrapper
 * does. Requests are strictly sequential (the shim answers one line per
 * request). Latency is measured as JS round-trip; the shim separately reports
 * its own compute time in microseconds.
 */

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { performance } from "node:perf_hooks";

export class NativeSolverBridge {
  constructor(binaryPath) {
    this.binaryPath = binaryPath;
    this.child = null;
    this.rl = null;
    this._waiters = [];
  }

  async start() {
    this.child = spawn(this.binaryPath, [], {
      stdio: ["pipe", "pipe", "inherit"],
    });
    this.rl = createInterface({ input: this.child.stdout });
    this.rl.on("line", (line) => {
      const waiter = this._waiters.shift();
      if (waiter) waiter(line);
    });
    this.child.on("exit", (code) => {
      // Fail all pending and future waiters loudly.
      const waiters = this._waiters.splice(0);
      for (const waiter of waiters) waiter(null);
      this.child = null;
      this.exitCode = code;
    });
    await this.request("PING");
  }

  /** Send one line, await the next response line. Returns null on child death. */
  request(line) {
    if (!this.child) {
      throw new Error("native solver bridge: child not running");
    }
    return new Promise((resolve) => {
      this._waiters.push((response) => resolve(response));
      this.child.stdin.write(`${line}\n`);
    });
  }

  /**
   * Configure the strategy (mirrors StrategyWrapper::configure).
   */
  async configure(type, heuristic, depth, probability, trials) {
    const t0 = performance.now();
    const response = await this.request(
      `CONFIG ${type} ${heuristic} ${depth} ${probability} ${trials ?? 256}`,
    );
    const latencyMs = performance.now() - t0;
    if (!response || !response.startsWith("OK CONFIG")) {
      throw new Error(`native solver CONFIG failed: ${response}`);
    }
    return latencyMs;
  }

  /**
   * pickMove on a row-major exponent array.
   * Returns { cppDir, jsDir, computeUs, roundTripMs } or { error }.
   * JS = [1, 2, 3, 0][cpp]  (cpp: 0=Right, 1=Down, 2=Left, 3=Up — empirically
   * pinned by tests/native-crosscheck.test.mjs).
   */
  async pickMove(exponents) {
    const CPP_TO_JS = [1, 2, 3, 0];
    const t0 = performance.now();
    const response = await this.request(`PICK ${exponents.join(" ")}`);
    const roundTripMs = performance.now() - t0;
    if (response === null) {
      return { error: "native solver exited unexpectedly" };
    }
    const parts = response.split(/\s+/);
    if (parts[0] !== "MOVE") {
      return { error: response };
    }
    const cppDir = Number(parts[1]);
    const computeUs = Number(parts[2]);
    return {
      cppDir,
      jsDir: CPP_TO_JS[cppDir],
      computeUs,
      roundTripMs,
    };
  }

  /**
   * C++-side move simulation for the convention cross-check test ONLY.
   * The study harness never uses this to advance games — game state advances
   * exclusively through the independent JS reference model.
   */
  async makeMoveCpp(cppDir, exponents) {
    const response = await this.request(`MAKE ${cppDir} ${exponents.join(" ")}`);
    if (!response || !response.startsWith("BOARD")) {
      throw new Error(`native solver MAKE failed: ${response}`);
    }
    return response.split(/\s+/).slice(1).map(Number);
  }

  async close() {
    if (!this.child) return;
    try {
      await this.request("QUIT");
    } catch {
      // child already dead
    }
    this.child.kill();
    this.child = null;
  }
}
