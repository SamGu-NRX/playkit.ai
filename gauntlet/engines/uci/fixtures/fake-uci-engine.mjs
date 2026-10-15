#!/usr/bin/env node
/**
 * A fake UCI engine for protocol tests. Speaks enough UCI to exercise a
 * client: the uci/uciok and isready/readyok handshake, id name, setoption
 * tolerance, ucinewgame, position, and go → info → bestmove. Failure modes
 * are opt-in via argv so tests can drive crashes, hangs and garbage output.
 *
 * Modes:
 *   (default)          proper handshake; `go` answers info lines + bestmove
 *   --bestmove=MOVE    the move `go` answers with (default e7e5)
 *   --crash-handshake  exit(3) immediately, before speaking any UCI
 *   --crash-on-go      handshake completes, then exit(7) on the first `go`
 *   --hang-on-go       handshake completes, then never answer `go`
 *   --garbage          emit junk lines around the handshake and during `go`
 *
 * Executable on purpose (shebang + exec bit): the game-level wiring tests
 * point GAUNTLET_STOCKFISH straight at this file, which is only possible for
 * a directly runnable binary.
 */

import readline from 'node:readline';

const argv = process.argv.slice(2);
/** @param {string} flag */
const has = (flag) => argv.includes(flag);
const bestmoveArg = argv.find((a) => a.startsWith('--bestmove='));
const BESTMOVE = bestmoveArg ? bestmoveArg.slice('--bestmove='.length) : 'e7e5';

if (has('--crash-handshake')) {
  process.exit(3);
}

const out = (line) => process.stdout.write(`${line}\n`);

if (has('--garbage')) {
  out('this is not a uci line');
  out('info neither is this');
}

out('id name FakeFish 1.0');
out('id author fake');
out('uciok');

const crashOnGo = has('--crash-on-go');
const hangOnGo = has('--hang-on-go');

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  const text = line.trim();
  if (!text) return;
  if (text === 'isready') {
    out('readyok');
    return;
  }
  if (text === 'uci') {
    out('id name FakeFish 1.0');
    out('uciok');
    return;
  }
  if (text.startsWith('setoption') || text === 'ucinewgame' || text.startsWith('position')) {
    // No response per the UCI protocol.
    return;
  }
  if (text.startsWith('go')) {
    if (crashOnGo) {
      process.exit(7);
    }
    if (hangOnGo) {
      return; // Never answer: the client must time out.
    }
    if (has('--garbage')) {
      out('nonsense without a terminator');
    }
    out('info depth 8 seldepth 11 multipv 1 score cp 34 nodes 500 nps 50000 time 10 pv e7e5 e2e4');
    out('info depth 9 seldepth 12 multipv 1 score cp 41 nodes 900 nps 60000 time 15 pv e7e5');
    out(`bestmove ${BESTMOVE} ponder g1f3`);
    return;
  }
  if (text === 'quit') {
    rl.close();
    process.exit(0);
    return;
  }
  // Unknown commands are ignored, as engines do.
});
