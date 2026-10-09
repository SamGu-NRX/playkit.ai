#!/usr/bin/env node
/**
 * Static file server for the local browser benchmark.
 *
 * Zero dependencies (the repo has no package.json on purpose). Serves the
 * repository root so bench fixtures can import ../src/* modules and the
 * extension bundle over same-origin HTTP, which dynamic import() requires.
 *
 * Usage: node scripts/serve-bench.mjs [port]   (default 8765)
 *
 * WASM note: solver.wasm is not committed (gitignored *.wasm). Requests for it
 * 404 on purpose — that is the "WASM unavailable -> fallback" scenario the
 * benchmark exercises. If you build solver.wasm locally
 * (node scripts/build-wasm.js --release), serve this same tree and the
 * benchmark will run the real WASM path instead.
 */

import { createServer } from "node:http";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const PORT = Number(process.argv[2]) || 8765;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".svg": "image/svg+xml",
  ".md": "text/markdown; charset=utf-8",
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    // Results sink: the runner POSTs benchmark JSON here and it lands on disk.
    if (req.method === "POST" && url.pathname === "/api/results") {
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 20 * 1024 * 1024) {
          res.writeHead(413).end("payload too large");
          return;
        }
        chunks.push(chunk);
      }
      const raw = Buffer.concat(chunks).toString("utf8");
      JSON.parse(raw); // reject garbage before writing
      const outDir = join(ROOT, "bench", "results");
      await mkdir(outDir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      await writeFile(join(outDir, `run-${stamp}.json`), raw);
      await writeFile(join(outDir, "last-run.json"), raw);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, saved: `bench/results/run-${stamp}.json` }));
      return;
    }

    let pathname = decodeURIComponent(url.pathname);
    if (pathname.endsWith("/")) pathname += "index.html";

    // Path-traversal guard: normalize and require the result to stay in ROOT.
    const filePath = normalize(join(ROOT, pathname));
    if (!filePath.startsWith(ROOT)) {
      res.writeHead(403).end("forbidden");
      return;
    }

    let info;
    try {
      info = await stat(filePath);
    } catch {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end(`404: ${pathname}`);
      return;
    }
    if (info.isDirectory()) {
      res.writeHead(301, { Location: url.pathname + "/" });
      res.end();
      return;
    }

    const body = await readFile(filePath);
    res.writeHead(200, {
      "Content-Type": MIME[extname(filePath).toLowerCase()] || "application/octet-stream",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
    });
    res.end(body);
  } catch (error) {
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end(`500: ${error.message}`);
  }
});

server.listen(PORT, () => {
  console.log(`bench server: http://localhost:${PORT}/ (root: ${ROOT})`);
  console.log(`benchmark page: http://localhost:${PORT}/bench/runner.html`);
});
