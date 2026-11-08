// Unit test for src/chess-ai.js (run: node tools/test-ai.mjs). Verifies the AI
// returns legal moves and that the searching levels find a mate-in-1 and grab a
// free queen. Uses chess.js to validate the returned moves.
import { Chess } from "chess.js";
import { chooseMove } from "../src/chess-ai.js";

let ok = true;
const check = (cond, msg) => { console.log(`  ${cond ? "✓" : "✗"} ${msg}`); if (!cond) ok = false; };

// Returned moves must be legal from each difficulty, from the opening position.
for (const diff of ["easy", "medium", "hard"]) {
  const c = new Chess();
  const m = chooseMove(c.fen(), diff);
  let legal = false;
  try { legal = !!c.move(m); } catch { legal = false; }
  check(legal && m, `${diff}: returns a legal opening move (${m && m.from + m.to})`);
}

// Mate in 1: 1.Ra8#. Medium/Hard must find it.
const MATE1 = "6k1/5ppp/8/8/8/8/8/R6K w - - 0 1";
for (const diff of ["medium", "hard"]) {
  const c = new Chess(MATE1);
  const m = chooseMove(c.fen(), diff);
  c.move(m);
  check(c.isCheckmate(), `${diff}: finds the mate-in-1 (played ${m.from}${m.to}, checkmate=${c.isCheckmate()})`);
}

// Free queen: black queen on d5 is undefended; medium should capture it.
const FREEQ = "4k3/8/8/3q4/8/8/8/3QK3 w - - 0 1";
{
  const c = new Chess(FREEQ);
  const m = chooseMove(c.fen(), "medium");
  const v = c.move(m);
  check(v && v.captured === "q", `medium: captures the free queen (played ${m.from}${m.to}, captured=${v && v.captured})`);
}

console.log("");
console.log(ok ? "AI TESTS OK ✓" : "AI TESTS FAILED ✗");
process.exit(ok ? 0 : 1);
