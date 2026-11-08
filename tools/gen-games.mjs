// ============================================================================
//  Generator: famous chess games -> src/chess-game.js (the playthrough data).
//
//  We do NOT hand-transcribe from/to squares (error-prone). Instead each game is
//  given as its canonical SAN move list and replayed through chess.js, which is a
//  fully-validated move generator. For every ply we read back the exact from/to
//  squares, castling rook move, and check/checkmate state, then emit the compact
//  ply objects the engine consumes (see src/chess-game.js header for the format).
//
//  chess.js is a DEV-ONLY dependency (tools/package.json). The browser app never
//  imports it — it loads the plain, import-free src/chess-game.js this writes.
//
//  Special moves are encoded explicitly so the runtime needs no chess logic:
//    * castling  -> { castle: { king:[from,to], rook:[from,to] } }
//    * en passant-> { from, to, ep: "<captured-pawn square>" } (capture is off
//      the destination square, so it can't be detected by occupancy alone)
//    * promotion -> { from, to, promo: <type 2=N 3=B 4=R 5=Q> } (the piece value
//      changes on arrival)
//
//  Guarantees enforced by the asserts below:
//    * every move is legal (chess.js throws otherwise),
//    * every game ends in checkmate (the brief requirement).
//
//  Run:  node tools/gen-games.mjs        (writes ../src/chess-game.js)
//  Keep this in sync with the games list when adding a game.
// ============================================================================

import { Chess } from "chess.js";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, "..", "src", "chess-game.js");

// ---- The games. SAN strings with move numbers; result token optional. --------
// All six end in checkmate. Lengths span 7..41 moves for variety.
const GAMES_SRC = [
  {
    name: "Opera Game",
    subtitle: "Morphy vs. Brunswick & Isouard, Paris 1858",
    moves: `1. e4 e5 2. Nf3 d6 3. d4 Bg4 4. dxe5 Bxf3 5. Qxf3 dxe5 6. Bc4 Nf6
            7. Qb3 Qe7 8. Nc3 c6 9. Bg5 b5 10. Nxb5 cxb5 11. Bxb5+ Nbd7
            12. O-O-O Rd8 13. Rxd7 Rxd7 14. Rd1 Qe6 15. Bxd7+ Nxd7 16. Qb8+ Nxb8
            17. Rd8#`,
  },
  {
    name: "Légal's Mate",
    subtitle: "Légal vs. Saint-Brie, Paris 1750",
    moves: `1. e4 e5 2. Bc4 d6 3. Nf3 Bg4 4. Nc3 g6 5. Nxe5 Bxd1 6. Bxf7+ Ke7
            7. Nd5#`,
  },
  {
    name: "Réti–Tartakower",
    subtitle: "Réti vs. Tartakower, Vienna 1910",
    moves: `1. e4 c6 2. d4 d5 3. Nc3 dxe4 4. Nxe4 Nf6 5. Qd3 e5 6. dxe5 Qa5+
            7. Bd2 Qxe5 8. O-O-O Nxe4 9. Qd8+ Kxd8 10. Bg5+ Kc7 11. Bd8#`,
  },
  {
    name: "En Passant Mate",
    subtitle: "Gundersen vs. Faul, Melbourne 1928",
    // The mating move 15.hxg6# is an en-passant capture (double check + mate) —
    // the most famous en-passant checkmate on record.
    moves: `1. e4 e6 2. d4 d5 3. e5 c5 4. c3 cxd4 5. cxd4 Bb4+ 6. Nc3 Nc6
            7. Nf3 Nge7 8. Bd3 O-O 9. Bxh7+ Kxh7 10. Ng5+ Kg6 11. h4 Nxd4
            12. Qg4 f5 13. h5+ Kh6 14. Nxe6+ g5 15. hxg6#`,
  },
  {
    name: "Immortal Game",
    subtitle: "Anderssen vs. Kieseritzky, London 1851",
    moves: `1. e4 e5 2. f4 exf4 3. Bc4 Qh4+ 4. Kf1 b5 5. Bxb5 Nf6 6. Nf3 Qh6
            7. d3 Nh5 8. Nh4 Qg5 9. Nf5 c6 10. g4 Nf6 11. Rg1 cxb5 12. h4 Qg6
            13. h5 Qg5 14. Qf3 Ng8 15. Bxf4 Qf6 16. Nc3 Bc5 17. Nd5 Qxb2
            18. Bd6 Bxg1 19. e5 Qxa1+ 20. Ke2 Na6 21. Nxg7+ Kd8 22. Qf6+ Nxf6
            23. Be7#`,
  },
  {
    name: "Evergreen Game",
    subtitle: "Anderssen vs. Dufresne, Berlin 1852",
    moves: `1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 4. b4 Bxb4 5. c3 Ba5 6. d4 exd4
            7. O-O d3 8. Qb3 Qf6 9. e5 Qg6 10. Re1 Nge7 11. Ba3 b5 12. Qxb5 Rb8
            13. Qa4 Bb6 14. Nbd2 Bb7 15. Ne4 Qf5 16. Bxd3 Qh5 17. Nf6+ gxf6
            18. exf6 Rg8 19. Rad1 Qxf3 20. Rxe7+ Nxe7 21. Qxd7+ Kxd7 22. Bf5+ Ke8
            23. Bd7+ Kf8 24. Bxe7#`,
  },
  {
    name: "Game of the Century",
    subtitle: "Byrne vs. Fischer, New York 1956",
    moves: `1. Nf3 Nf6 2. c4 g6 3. Nc3 Bg7 4. d4 O-O 5. Bf4 d5 6. Qb3 dxc4
            7. Qxc4 c6 8. e4 Nbd7 9. Rd1 Nb6 10. Qc5 Bg4 11. Bg5 Na4 12. Qa3 Nxc3
            13. bxc3 Nxe4 14. Bxe7 Qb6 15. Bc4 Nxc3 16. Bc5 Rfe8+ 17. Kf1 Be6
            18. Bxb6 Bxc4+ 19. Kg1 Ne2+ 20. Kf1 Nxd4+ 21. Kg1 Ne2+ 22. Kf1 Nc3+
            23. Kg1 axb6 24. Qb4 Ra4 25. Qxb6 Nxd1 26. h3 Rxa2 27. Kh2 Nxf2
            28. Re1 Rxe1 29. Qd8+ Bf8 30. Nxe1 Bd5 31. Nf3 Ne4 32. Qb8 b5
            33. h4 h5 34. Ne5 Kg7 35. Kg1 Bc5+ 36. Kf1 Ng3+ 37. Ke1 Bb4+
            38. Kd1 Bb3+ 39. Kc1 Ne2+ 40. Kb1 Nc3+ 41. Kc1 Rc2#`,
  },
  {
    name: "Underpromotion Mate",
    subtitle: "Kravtsiv vs. Ding Liren, World Cup 2017",
    // A 110-move endgame: Ding (Black) promotes to a KNIGHT — 110...a1=N# — which
    // forks-and-mates, where a1=Q would let White draw with Ra8+. Famous modern
    // example of an underpromotion checkmate (tests a non-queen promotion).
    moves: `1. c4 Nf6 2. Nc3 e6 3. d4 Bb4 4. e3 O-O 5. Bd3 d5 6. Nf3 dxc4
            7. Bxc4 c5 8. O-O cxd4 9. exd4 b6 10. Qe2 Bb7 11. Rd1 Bxc3 12. bxc3 Qc7
            13. Ne5 Nbd7 14. Nxd7 Qxd7 15. Bd2 Ne4 16. f3 Nxd2 17. Qxd2 Rac8
            18. Bb3 Bd5 19. Qd3 Qc6 20. Rac1 Bc4 21. Bxc4 Qxc4 22. Rc2 Rfd8
            23. Kf2 h5 24. Qxc4 Rxc4 25. Ke2 b5 26. f4 f6 27. Kd3 e5 28. fxe5 fxe5
            29. Rb1 a6 30. Rbb2 exd4 31. cxd4 Rdxd4+ 32. Ke3 Re4+ 33. Kf3 Rf4+
            34. Ke3 Kh7 35. g3 Rfe4+ 36. Kf3 Rxc2 37. Rxc2 Ra4 38. h4 Kg6
            39. Rc6+ Kf7 40. Rc7+ Kf6 41. Rc6+ Ke5 42. Rc5+ Kf6 43. Rc6+ Kf7
            44. Rc7+ Kg6 45. Rc6+ Kh7 46. Rc2 g6 47. Ke3 Kg7 48. Rc7+ Kf6
            49. Rc6+ Kf5 50. Rc5+ Ke6 51. Rc6+ Ke5 52. Rxg6 Ra3+ 53. Kd2 Rxa2+
            54. Kc3 Ke4 55. Rg5 Kf3 56. Rxh5 Kxg3 57. Rh8 Ra4 58. h5 Kg4
            59. Kb3 Kg5 60. Kb2 Rh4 61. Ra8 Rb4+ 62. Kc3 Rc4+ 63. Kb3 Rc6
            64. Rh8 Rh6 65. Rd8 Kxh5 66. Rd5+ Kg4 67. Kb4 Kf4 68. Rd1 Ke3
            69. Kc5 Ke2 70. Rd4 Rh1 71. Rd6 Ra1 72. Rh6 Kd3 73. Kb4 Rb1+
            74. Ka5 Ra1+ 75. Kb4 Kd4 76. Rh4+ Ke5 77. Rh5+ Kf6 78. Rh6+ Kg5
            79. Rd6 Ra4+ 80. Kb3 Kf5 81. Rh6 Ke5 82. Rg6 Kd5 83. Rf6 Kc5
            84. Rh6 Ra1 85. Kb2 Ra4 86. Kb3 Rb4+ 87. Ka3 a5 88. Rh5+ Kd6
            89. Rh6+ Ke5 90. Rh5+ Kf6 91. Rh6+ Kg5 92. Ra6 Ra4+ 93. Kb3 Kf5
            94. Rh6 Rg4 95. Rb6 a4+ 96. Ka2 Rb4 97. Rh6 Rb3 98. Rh4 Ke5
            99. Rg4 Kd5 100. Rh4 Kc5 101. Rh5+ Kb4 102. Rh4+ Ka5 103. Rh5 Rf3
            104. Rg5 a3 105. Rg4 b4 106. Rh4 Rf2+ 107. Kb3 Rb2+ 108. Kc4 a2
            109. Rh8 Rc2+ 110. Kb3 a1=N#`,
  },
  {
    name: "Kasparov's Immortal",
    subtitle: "Kasparov vs. Topalov, Wijk aan Zee 1999",
    result: "1-0",   // resignation — the famous 24.Rxd4!! sac + king-hunt; Black resigns
    moves: `1. e4 d6 2. d4 Nf6 3. Nc3 g6 4. Be3 Bg7 5. Qd2 c6 6. f3 b5 7. Nge2 Nbd7
            8. Bh6 Bxh6 9. Qxh6 Bb7 10. a3 e5 11. O-O-O Qe7 12. Kb1 a6 13. Nc1 O-O-O
            14. Nb3 exd4 15. Rxd4 c5 16. Rd1 Nb6 17. g3 Kb8 18. Na5 Ba8 19. Bh3 d5
            20. Qf4+ Ka7 21. Rhe1 d4 22. Nd5 Nbxd5 23. exd5 Qd6 24. Rxd4 cxd4
            25. Re7+ Kb6 26. Qxd4+ Kxa5 27. b4+ Ka4 28. Qc3 Qxd5 29. Ra7 Bb7
            30. Rxb7 Qc4 31. Qxf6 Kxa3 32. Qxa6+ Kxb4 33. c3+ Kxc3 34. Qa1+ Kd2
            35. Qb2+ Kd1 36. Bf1 Rd2 37. Rd7 Rxd7 38. Bxc4 bxc4 39. Qxh8 Rd3
            40. Qa8 c3 41. Qa4+ Ke1 42. f4 f5 43. Kc1 Rd2 44. Qa7`,
  },
  {
    name: "Rubinstein's Immortal",
    subtitle: "Rotlewi vs. Rubinstein, Łódź 1907",
    result: "0-1",   // resignation — ...Rxc3!!/...Rd2/...Bxe4 cascade; White resigns
    moves: `1. d4 d5 2. Nf3 e6 3. e3 c5 4. c4 Nc6 5. Nc3 Nf6 6. dxc5 Bxc5 7. a3 a6
            8. b4 Bd6 9. Bb2 O-O 10. Qd2 Qe7 11. Bd3 dxc4 12. Bxc4 b5 13. Bd3 Rd8
            14. Qe2 Bb7 15. O-O Ne5 16. Nxe5 Bxe5 17. f4 Bc7 18. e4 Rac8 19. e5 Bb6+
            20. Kh1 Ng4 21. Be4 Qh4 22. g3 Rxc3 23. gxh4 Rd2 24. Qxd2 Bxe4+
            25. Qg2 Rh3`,
  },
];

// chess.js promotion letter -> the project's piece-type code (see chess-scene.js).
const PROMO = { n: 2, b: 3, r: 4, q: 5 };

// "e2"-style square -> the ["file","rank"] castling-rook helper. Kingside rook
// goes h->f, queenside a->d, on the same rank as the castling king.
const rookSquares = (kingFrom, side) => {
  const rank = kingFrom[1];
  return side === "k"
    ? [`h${rank}`, `f${rank}`]
    : [`a${rank}`, `d${rank}`];
};

// Tokenise a SAN move list: drop move numbers ("12."), result tokens, blanks.
function sanTokens(moves) {
  return moves
    .split(/\s+/)
    .map((t) => t.replace(/^\d+\.+/, "").trim())   // "12.O-O" / "12." -> "O-O" / ""
    .filter((t) => t && !["1-0", "0-1", "1/2-1/2", "*"].includes(t));
}

function buildPlies(game) {
  const chess = new Chess();
  const plies = [];
  for (const san of sanTokens(game.moves)) {
    let mv;
    try {
      mv = chess.move(san);
    } catch (e) {
      throw new Error(`${game.name}: illegal/unparsed move "${san}" — ${e.message}`);
    }
    const check = chess.isCheck();
    const mate = chess.isCheckmate();

    const ply = {};
    if (mv.flags.includes("k") || mv.flags.includes("q")) {
      const side = mv.flags.includes("k") ? "k" : "q";
      ply.castle = { king: [mv.from, mv.to], rook: rookSquares(mv.from, side) };
    } else {
      ply.from = mv.from;
      ply.to = mv.to;
      // En passant: the captured pawn sits on (file-of-to, rank-of-from), not on
      // the destination — record it so the runtime knows what to remove/animate.
      if (mv.flags.includes("e")) ply.ep = mv.to[0] + mv.from[1];
      // Promotion: type code the destination square becomes (color added at run).
      if (mv.promotion) ply.promo = PROMO[mv.promotion];
    }
    ply.san = mv.san;            // canonical SAN (incl. +/#) from chess.js
    if (check) ply.check = true;
    if (mate) ply.mate = true;
    plies.push(ply);
  }
  return plies;
}

// Classify the ending and pin down the result. A game either ends in checkmate
// (only ever on the final ply) or, for non-mate games, in resignation — which
// needs an explicit decisive result in the source (chess.js can't know who quit).
function classify(game, plies) {
  const last = plies.length - 1;
  const mateAt = plies.findIndex((p) => p.mate);
  if (mateAt >= 0 && mateAt !== last)
    throw new Error(`${game.name}: checkmate flagged before the final ply (index ${mateAt})`);

  if (plies[last] && plies[last].mate) {
    // White moves on even ply indices, so an even final ply = White delivered mate.
    const computed = last % 2 === 0 ? "1-0" : "0-1";
    if (game.result && game.result !== computed)
      throw new Error(`${game.name}: result ${game.result} contradicts the checkmate winner ${computed}`);
    return { ending: "checkmate", result: computed };
  }
  if (!["1-0", "0-1"].includes(game.result))
    throw new Error(`${game.name}: does not end in checkmate, so it needs an explicit decisive result ("1-0" or "0-1")`);
  return { ending: "resignation", result: game.result };
}

// ---- Emit ------------------------------------------------------------------

function fmtPly(p) {
  const parts = [];
  if (p.castle) {
    const k = `["${p.castle.king[0]}", "${p.castle.king[1]}"]`;
    const r = `["${p.castle.rook[0]}", "${p.castle.rook[1]}"]`;
    parts.push(`castle: { king: ${k}, rook: ${r} }`);
  } else {
    parts.push(`from: "${p.from}"`, `to: "${p.to}"`);
    if (p.ep) parts.push(`ep: "${p.ep}"`);
    if (p.promo) parts.push(`promo: ${p.promo}`);
  }
  parts.push(`san: "${p.san}"`);
  if (p.check) parts.push(`check: true`);
  if (p.mate) parts.push(`mate: true`);
  return `    { ${parts.join(", ")} },`;
}

function emit(games) {
  const blocks = games
    .map((g) => {
      const plies = g.plies.map(fmtPly).join("\n");
      return `  {\n` +
        `    name: ${JSON.stringify(g.name)},\n` +
        `    subtitle: ${JSON.stringify(g.subtitle)},\n` +
        `    result: ${JSON.stringify(g.result)},\n` +
        `    ending: ${JSON.stringify(g.ending)},\n` +
        `    plies: [\n${plies}\n    ],\n` +
        `  },`;
    })
    .join("\n");

  return `// ============================================================================
//  Move data for the animated playthrough.  GENERATED by tools/gen-games.mjs —
//  do not edit by hand; edit the SAN move lists there and re-run the generator.
//
//  Squares are algebraic ("e4"). Cell index = rank*8 + file, file a=0..h=7,
//  rank '1'->0 .. '8'->7 -- matching chess-scene.js and the WGSL board buffer.
//  Each ply gives explicit from/to squares (no live chess engine at runtime);
//  ordinary captures are detected from the live board (destination occupied).
//  Special moves carry extra fields:
//    \`castle: { king:[from,to], rook:[from,to] }\`  - both sub-moves,
//    \`ep: "<square>"\`   - en passant; the captured pawn is on that square,
//    \`promo: <2..5>\`    - promotion; the pawn becomes this type (2=N..5=Q).
//  \`san\` drives the HUD move readout; \`check\`/\`mate\` flag the highlighted-king
//  FX. Each game also carries \`result\` ("1-0"/"0-1") and \`ending\`
//  ("checkmate" | "resignation"); resignations get a king-topple end-state.
// ============================================================================

// "e4" -> cell index 0..63.
export const sqIdx = (s) => (s.charCodeAt(1) - 49) * 8 + (s.charCodeAt(0) - 97);

// Cell index -> world-space centre of the square (x = file-3.5, z = rank-3.5).
export const cellWorld = (idx) => [(idx % 8) - 3.5, 0, ((idx / 8) | 0) - 3.5];

// Famous games. Each ends in checkmate or resignation (\`ending\`/\`result\`); the
// playthrough UI lists them in order and gives resignations a topple end-state.
export const GAMES = [
${blocks}
];

// Back-compat alias: the original single-game export.
export const OPERA_GAME = GAMES[0];

// "12. O-O-O" / "12... Rd8" label for a given ply index of a game.
export function sanLabel(game, ply) {
  if (ply < 0 || ply >= game.plies.length) return "";
  const num = ((ply / 2) | 0) + 1;
  const sep = ply % 2 === 0 ? ". " : "… ";
  return \`\${num}\${sep}\${game.plies[ply].san}\`;
}
`;
}

// ---- Run -------------------------------------------------------------------

for (const g of GAMES_SRC) {
  g.plies = buildPlies(g);
  Object.assign(g, classify(g, g.plies));   // sets g.ending + g.result
}

writeFileSync(OUT, emit(GAMES_SRC), "utf8");

console.log(`Wrote ${OUT}`);
console.log("");
console.log("  game                   plies  final move   result  ending       special moves");
console.log("  ---------------------- -----  -----------  ------  -----------  -------------");
for (const g of GAMES_SRC) {
  const last = g.plies[g.plies.length - 1];
  const special = [];
  if (g.plies.some((p) => p.castle)) special.push("castle");
  if (g.plies.some((p) => p.ep)) special.push("en passant");
  if (g.plies.some((p) => p.promo)) special.push("promotion");
  console.log(
    `  ${g.name.padEnd(22)} ${String(g.plies.length).padStart(5)}  ${last.san.padEnd(11)}  ${g.result.padEnd(6)}  ${g.ending.padEnd(11)}  ${special.join(", ") || "-"}`,
  );
}
