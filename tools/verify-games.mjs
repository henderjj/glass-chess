// ============================================================================
//  End-to-end check: replay each generated game through the PROJECT's own board
//  model (buildStartPosition + applyPlyTo, copied verbatim from chess-main.js)
//  and confirm the final position matches an independent chess.js replay of the
//  same SAN. This validates the from/to data, castling rook moves, capture-by-
//  occupancy, and the rank*8+file encoding all the way through.
//
//  Run:  node tools/verify-games.mjs
// ============================================================================

import { Chess } from "chess.js";
import { buildStartPosition } from "../src/chess-scene.js";
import { GAMES, sqIdx } from "../src/chess-game.js";

// --- verbatim from src/chess-main.js -----------------------------------------
function applyPlyTo(b, ply) {
  if (ply.castle) {
    const kf = sqIdx(ply.castle.king[0]), kt = sqIdx(ply.castle.king[1]);
    const rf = sqIdx(ply.castle.rook[0]), rt = sqIdx(ply.castle.rook[1]);
    b[kt] = b[kf]; b[kf] = 0; b[rt] = b[rf]; b[rf] = 0;
  } else {
    const f = sqIdx(ply.from), t = sqIdx(ply.to);
    const moved = b[f];
    b[t] = ply.promo ? (ply.promo + (moved > 10 ? 10 : 0)) : moved;
    b[f] = 0;
    if (ply.ep) b[sqIdx(ply.ep)] = 0;
  }
}
// -----------------------------------------------------------------------------

const TYPE = { p: 1, n: 2, b: 3, r: 4, q: 5, k: 6 };

// chess.js board() -> the project's 64-cell encoding (rank*8+file, +10 black).
function chessJsBoardToCells(chess) {
  const cells = new Array(64).fill(0);
  const grid = chess.board();              // grid[0] = rank 8 ... grid[7] = rank 1
  for (let i = 0; i < 8; i++) {
    for (let j = 0; j < 8; j++) {
      const sq = grid[i][j];
      if (!sq) continue;
      const idx = (7 - i) * 8 + j;         // project rank = 7 - i, file = j
      cells[idx] = TYPE[sq.type] + (sq.color === "b" ? 10 : 0);
    }
  }
  return cells;
}

let allOk = true;
for (const g of GAMES) {
  // Project replay.
  const b = buildStartPosition();
  let maxOverlay = 0;
  for (const ply of g.plies) {
    // sanity: the moving piece must exist before the move
    const fromIdx = ply.castle ? sqIdx(ply.castle.king[0]) : sqIdx(ply.from);
    if (b[fromIdx] === 0) { console.log(`  ✗ ${g.name}: empty from-square at ${ply.san}`); allOk = false; }
    // overlay-slot pressure: movers + capture + checked-king (must stay <= 8)
    const movers = ply.castle ? 2 : 1;
    const cap = !ply.castle && b[sqIdx(ply.to)] > 0 ? 1 : 0;
    maxOverlay = Math.max(maxOverlay, movers + cap + (ply.check ? 1 : 0));
    applyPlyTo(b, ply);
  }
  const projCells = Array.from(b);

  // Independent chess.js replay of the same SAN sequence.
  const chess = new Chess();
  for (const ply of g.plies) chess.move(ply.san);
  const refCells = chessJsBoardToCells(chess);

  const mismatches = [];
  for (let i = 0; i < 64; i++) if (projCells[i] !== refCells[i]) mismatches.push(i);

  const ok = mismatches.length === 0 && maxOverlay <= 8;
  if (!ok) allOk = false;
  console.log(
    `  ${ok ? "✓" : "✗"} ${g.name.padEnd(22)} plies=${String(g.plies.length).padStart(3)} ` +
    `maxOverlay=${maxOverlay} ` +
    (mismatches.length ? `MISMATCH cells [${mismatches.join(",")}]` : `final position matches chess.js`),
  );
}

// --- Synthetic feature unit test --------------------------------------------
// None of the famous games end *by* promotion, so exercise the promotion path
// (plus en passant, in one line) explicitly: hand-encoded plies vs a chess.js
// replay of the same SAN. Proves applyPlyTo handles ep removal + pawn->queen.
const FEATURE_TEST = {
  name: "ep + promotion",
  sans: ["e4", "a6", "e5", "d5", "exd6", "a5", "dxc7", "a4", "cxb8=Q"],
  plies: [
    { from: "e2", to: "e4" },
    { from: "a7", to: "a6" },
    { from: "e4", to: "e5" },
    { from: "d7", to: "d5" },
    { from: "e5", to: "d6", ep: "d5" },    // en passant
    { from: "a6", to: "a5" },
    { from: "d6", to: "c7" },              // ordinary capture
    { from: "a5", to: "a4" },
    { from: "c7", to: "b8", promo: 5 },    // capture + promote to queen
  ],
};
{
  const b = buildStartPosition();
  for (const ply of FEATURE_TEST.plies) applyPlyTo(b, ply);
  const chess = new Chess();
  for (const san of FEATURE_TEST.sans) chess.move(san);
  const ref = chessJsBoardToCells(chess);
  const mismatches = [];
  for (let i = 0; i < 64; i++) if (b[i] !== ref[i]) mismatches.push(i);
  const ok = mismatches.length === 0 && b[sqIdx("b8")] === 5 && b[sqIdx("d5")] === 0;
  if (!ok) allOk = false;
  console.log(
    `  ${ok ? "✓" : "✗"} ${FEATURE_TEST.name.padEnd(22)} ` +
    (mismatches.length ? `MISMATCH cells [${mismatches.join(",")}]` : `ep removed d5, b8 = white queen, matches chess.js`),
  );
}

console.log("");
console.log(allOk ? "ALL GAMES OK ✓" : "FAILURES PRESENT ✗");
process.exit(allOk ? 0 : 1);
