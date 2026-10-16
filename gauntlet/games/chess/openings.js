/**
 * The chess opening book: named mainline SAN sequences the game uses to
 * start episodes deterministically. Provenance: the ECO table of Wikipedia's
 * "List of chess openings" (https://en.wikipedia.org/wiki/List_of_chess_openings),
 * retrieved this session — the A/B/C code lines below follow that page's
 * mainlines directly; the D/E lines follow the same list's standard
 * continuations. Treat the exact move orders as reference, not gospel: every
 * line is verified legal from the start position by chess.test.js.
 *
 * @module
 */

/**
 * @typedef {object} OpeningLine
 * @property {string} name
 * @property {string[]} san SAN moves from the standard start position.
 */

/** @type {OpeningLine[]} */
export const OPENINGS = [
  // A: flank and queen's-pawn openings (retrieved ECO lines).
  { name: 'Réti Opening', san: ['Nf3', 'd5', 'c4'] },
  { name: 'English Opening', san: ['c4'] },
  { name: 'Symmetrical English', san: ['c4', 'c5'] },
  { name: 'English, Reversed Sicilian', san: ['c4', 'e5', 'Nc3'] },
  { name: 'Nimzo-Larsen Attack', san: ['b3'] },
  { name: 'Bird Opening', san: ['f4'] },
  { name: 'Dutch Defence', san: ['d4', 'f5'] },
  { name: 'Dutch, Leningrad System', san: ['d4', 'f5', 'c4', 'Nf6', 'g3', 'g6', 'Bg2', 'Bg7', 'Nf3'] },
  { name: 'Benko Gambit', san: ['d4', 'Nf6', 'c4', 'c5', 'd5', 'b5', 'cxb5', 'a6'] },
  { name: 'Modern Benoni', san: ['d4', 'Nf6', 'c4', 'c5', 'd5', 'e6', 'Nc3', 'exd5', 'cxd5', 'd6', 'Nf3', 'g6'] },
  { name: 'Budapest Gambit', san: ['d4', 'Nf6', 'c4', 'e5'] },
  { name: 'Old Indian Defence', san: ['d4', 'Nf6', 'c4', 'd6', 'Nc3'] },

  // B: semi-open games (retrieved ECO lines).
  { name: 'Sicilian Defence', san: ['e4', 'c5'] },
  { name: 'Alapin Sicilian', san: ['e4', 'c5', 'c3'] },
  { name: 'Open Sicilian', san: ['e4', 'c5', 'Nf3', 'Nc6', 'd4'] },
  { name: 'Sveshnikov Sicilian', san: ['e4', 'c5', 'Nf3', 'Nc6', 'd4', 'cxd4', 'Nxd4', 'Nf6', 'Nc3'] },
  { name: 'Scheveningen Sicilian', san: ['e4', 'c5', 'Nf3', 'd6', 'd4', 'cxd4', 'Nxd4', 'Nf6', 'Nc3', 'e6'] },
  { name: 'Classical Sicilian', san: ['e4', 'c5', 'Nf3', 'd6', 'd4', 'cxd4', 'Nxd4', 'Nf6', 'Nc3', 'Nc6'] },
  { name: 'Dragon Sicilian', san: ['e4', 'c5', 'Nf3', 'd6', 'd4', 'cxd4', 'Nxd4', 'Nf6', 'Nc3', 'g6'] },
  { name: 'Dragon, Yugoslav Attack', san: ['e4', 'c5', 'Nf3', 'd6', 'd4', 'cxd4', 'Nxd4', 'Nf6', 'Nc3', 'g6', 'Be3', 'Bg7', 'f3', 'O-O', 'Qd2'] },
  { name: 'Najdorf Sicilian', san: ['e4', 'c5', 'Nf3', 'd6', 'd4', 'cxd4', 'Nxd4', 'Nf6', 'Nc3', 'a6'] },
  { name: 'Najdorf, Main Line', san: ['e4', 'c5', 'Nf3', 'd6', 'd4', 'cxd4', 'Nxd4', 'Nf6', 'Nc3', 'a6', 'Bg5', 'e6'] },
  { name: 'Najdorf, Poisoned Pawn', san: ['e4', 'c5', 'Nf3', 'd6', 'd4', 'cxd4', 'Nxd4', 'Nf6', 'Nc3', 'a6', 'Bg5', 'e6', 'f4', 'Qb6'] },
  { name: 'Caro-Kann Defence', san: ['e4', 'c6', 'd4', 'd5'] },
  { name: 'Caro-Kann, Advance', san: ['e4', 'c6', 'd4', 'd5', 'e5'] },
  { name: 'Caro-Kann, Classical', san: ['e4', 'c6', 'd4', 'd5', 'Nc3', 'dxe4', 'Nxe4', 'Bf5', 'Ng3'] },
  { name: 'Scandinavian Defence', san: ['e4', 'd5'] },
  { name: 'Alekhine Defence', san: ['e4', 'Nf6', 'e5', 'Nd5', 'd4'] },
  { name: 'Pirc Defence', san: ['e4', 'd6', 'd4', 'Nf6', 'Nc3', 'g6'] },
  { name: 'Modern Defence', san: ['e4', 'g6', 'd4', 'Bg7'] },

  // C: open games and the French (retrieved ECO lines).
  { name: 'King’s Pawn Game', san: ['e4'] },
  { name: 'Centre Game', san: ['e4', 'e5', 'd4', 'exd4', 'Qxd4', 'Nc6'] },
  { name: 'Bishop’s Opening', san: ['e4', 'e5', 'Bc4'] },
  { name: 'Vienna Game', san: ['e4', 'e5', 'Nc3', 'Nf6'] },
  { name: 'King’s Gambit', san: ['e4', 'e5', 'f4'] },
  { name: 'King’s Gambit Accepted', san: ['e4', 'e5', 'f4', 'exf4', 'Nf3', 'g5', 'h4'] },
  { name: 'Falkbeer Countergambit', san: ['e4', 'e5', 'f4', 'd5'] },
  { name: 'Philidor Defence', san: ['e4', 'e5', 'Nf3', 'd6'] },
  { name: 'Petrov Defence', san: ['e4', 'e5', 'Nf3', 'Nf6', 'Nxe5', 'd6'] },
  { name: 'Scotch Game', san: ['e4', 'e5', 'Nf3', 'Nc6', 'd4', 'exd4', 'Nxd4'] },
  { name: 'Four Knights Game', san: ['e4', 'e5', 'Nf3', 'Nc6', 'Nc3', 'Nf6', 'd4'] },
  { name: 'Italian Game', san: ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4'] },
  { name: 'Giuoco Pianissimo', san: ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5', 'c3', 'Nf6', 'd4', 'exd4', 'cxd4'] },
  { name: 'Evans Gambit', san: ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5', 'b4', 'Bxb4', 'c3', 'Ba5'] },
  { name: 'Two Knights Defence', san: ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Nf6', 'Ng5', 'd5'] },
  { name: 'Ruy Lopez', san: ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5'] },
  { name: 'Ruy Lopez, Berlin Defence', san: ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'Nf6'] },
  { name: 'Ruy Lopez, Open Variation', san: ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'Nf6', 'O-O', 'Nxe4', 'Re1', 'Nd6'] },
  { name: 'Ruy Lopez, Exchange', san: ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'a6', 'Bxc6', 'dxc6', 'O-O'] },
  { name: 'Ruy Lopez, Closed', san: ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'a6', 'Ba4', 'Nf6', 'O-O', 'Be7', 'Re1', 'b5', 'Bb3', 'd6', 'c3'] },
  { name: 'Ruy Lopez, Zaitsev', san: ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'a6', 'Ba4', 'Nf6', 'O-O', 'Be7', 'Re1', 'b5', 'Bb3', 'd6', 'c3', 'O-O', 'h3'] },
  { name: 'Ruy Lopez, Marshall Attack', san: ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'a6', 'Ba4', 'Nf6', 'O-O', 'Be7', 'Re1', 'b5', 'Bb3', 'O-O', 'c3', 'd5'] },
  { name: 'French Defence', san: ['e4', 'e6', 'd4', 'd5'] },
  { name: 'French, Advance', san: ['e4', 'e6', 'd4', 'd5', 'e5', 'c5'] },
  { name: 'French, Tarrasch', san: ['e4', 'e6', 'd4', 'd5', 'Nd2'] },
  { name: 'French, Classical', san: ['e4', 'e6', 'd4', 'd5', 'Nc3', 'Nf6'] },
  { name: 'French, Winawer', san: ['e4', 'e6', 'd4', 'd5', 'Nc3', 'Bb4'] },
  { name: 'French, Winawer Main Line', san: ['e4', 'e6', 'd4', 'd5', 'Nc3', 'Bb4', 'e5', 'c5', 'a3', 'Bxc3+', 'bxc3'] },

  // D/E: closed and Indian defences (standard ECO mainlines).
  { name: 'Queen’s Pawn Game', san: ['d4', 'd5'] },
  { name: 'Queen’s Gambit', san: ['d4', 'd5', 'c4'] },
  { name: 'Queen’s Gambit Accepted', san: ['d4', 'd5', 'c4', 'dxc4', 'Nf3', 'Nf6', 'e3'] },
  { name: 'Queen’s Gambit Declined', san: ['d4', 'd5', 'c4', 'e6', 'Nc3', 'Nf6'] },
  { name: 'Queen’s Gambit, Exchange', san: ['d4', 'd5', 'c4', 'e6', 'Nc3', 'Nf6', 'cxd5', 'exd5'] },
  { name: 'Albin Countergambit', san: ['d4', 'd5', 'c4', 'e5'] },
  { name: 'Slav Defence', san: ['d4', 'd5', 'c4', 'c6', 'Nf3', 'Nf6', 'Nc3'] },
  { name: 'Semi-Slav Defence', san: ['d4', 'd5', 'c4', 'c6', 'Nf3', 'Nf6', 'Nc3', 'e6'] },
  { name: 'Grünfeld Defence', san: ['d4', 'Nf6', 'c4', 'g6', 'Nc3', 'd5'] },
  { name: 'Grünfeld, Exchange', san: ['d4', 'Nf6', 'c4', 'g6', 'Nc3', 'd5', 'cxd5', 'Nxd5', 'e4', 'Nxc3', 'bxc3', 'Bg7'] },
  { name: 'Nimzo-Indian Defence', san: ['d4', 'Nf6', 'c4', 'e6', 'Nc3', 'Bb4'] },
  { name: 'Nimzo-Indian, Rubinstein', san: ['d4', 'Nf6', 'c4', 'e6', 'Nc3', 'Bb4', 'e3', 'O-O'] },
  { name: 'Queen’s Indian Defence', san: ['d4', 'Nf6', 'c4', 'e6', 'Nf3', 'b6'] },
  { name: 'Bogo-Indian Defence', san: ['d4', 'Nf6', 'c4', 'e6', 'Nf3', 'Bb4+'] },
  { name: 'Catalan Opening', san: ['d4', 'Nf6', 'c4', 'e6', 'g3', 'd5', 'Bg2', 'Be7'] },
  { name: 'King’s Indian Defence', san: ['d4', 'Nf6', 'c4', 'g6', 'Nc3', 'Bg7', 'e4', 'd6'] },
  { name: 'King’s Indian, Sämisch', san: ['d4', 'Nf6', 'c4', 'g6', 'Nc3', 'Bg7', 'e4', 'd6', 'f3'] },
];

/**
 * @param {string} name
 * @returns {OpeningLine | null}
 */
export function findOpening(name) {
  return OPENINGS.find((opening) => opening.name === name) ?? null;
}
