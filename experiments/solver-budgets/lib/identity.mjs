/**
 * Source/binary identity and provenance recording. Every run commits an
 * identity file so results are traceable to exact code, binaries, seeds and
 * machine.
 */

import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export function sha256File(filePath) {
  const data = readFileSync(filePath);
  return createHash("sha256").update(data).digest("hex");
}

function git(args, repoRoot) {
  try {
    return execSync(`git ${args}`, { cwd: repoRoot, encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

/**
 * Build the identity record for a run.
 * @param {string} repoRoot       repository root
 * @param {object} manifest       parsed manifest (with __path relative to repoRoot)
 * @param {Array}  extraBinaries  [{ name, path }] binaries to hash
 */
export function buildIdentity(repoRoot, manifest, extraBinaries = []) {
  const identity = {
    recordedAt: new Date().toISOString(),
    machine: {
      hostname: os.hostname(),
      platform: os.platform(),
      release: os.release(),
      arch: os.arch(),
      cpuModel: os.cpus()[0]?.model ?? null,
      cpuCount: os.cpus().length,
      totalMemoryBytes: os.totalmem(),
      nodeVersion: process.version,
      note: "measurements are machine-specific; no universal latency claim is made",
    },
    git: {
      head: git("rev-parse HEAD", repoRoot),
      branch: git("rev-parse --abbrev-ref HEAD", repoRoot),
      submodules: git("submodule status", repoRoot),
      dirty: git("status --porcelain", repoRoot) !== "",
    },
    manifestSha256: sha256File(path.join(repoRoot, manifest.__path)),
    sources: {
      naiveSolver: sha256File(path.join(repoRoot, "src/solver/naive-solver.js")),
      wasmSolverEngine: sha256File(path.join(repoRoot, "src/solver/wasm-solver.js")),
      exportSolverCpp: sha256File(path.join(repoRoot, "solver/wasm/export_solver.cpp")),
      referenceModel: sha256File(path.join(repoRoot, "test/helpers/reference-2048.mjs")),
      spawnHistory: sha256File(path.join(repoRoot, "experiments/solver-budgets/spawn-history.json")),
      nativeShim: sha256File(path.join(repoRoot, "experiments/solver-budgets/native/shim.cpp")),
    },
    binaries: {},
  };

  for (const binary of extraBinaries) {
    const stats = statSync(binary.path, { throwIfNoEntry: false });
    if (stats) {
      identity.binaries[binary.name] = {
        sha256: sha256File(binary.path),
        bytes: stats.size,
      };
    } else {
      identity.binaries[binary.name] = { absent: true };
    }
  }

  return identity;
}
