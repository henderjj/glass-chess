// ============================================================================
//  Tiny chess AI for the single-player mode. Pure module (no DOM / worker code)
//  so it can be unit-tested under Node; the Web Worker (chess-ai.worker.js) is a
//  thin wrapper around chooseMove(). Uses the vendored chess.js for legal moves.
//
//    easy   - 1-ply material-greedy with a random pool (instant, beatable)
//    medium - alpha-beta negamax, depth 3
//    hard   - iterative deepening to depth 4 with a ~2.5s time cap
//
//  Evaluation: material + Michniewski piece-square tables (white's perspective),
//  negated per side. Plenty for a fun casual opponent; not a serious engine.
// ============================================================================

import { Chess } from "./vendor/chess.js";

const VAL = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 0 };
const MATE = 100000, INF = 1e9;
const ABORT = Symbol("abort");

// Piece-square tables, row 0 = rank 8 .. row 7 = rank 1 (matches chess.js board()).
const PST = {
  p: [
      0,  0,  0,  0,  0,  0,  0,  0,
     50, 50, 50, 50, 50, 50, 50, 50,
     10, 10, 20, 30, 30, 20, 10, 10,
      5,  5, 10, 25, 25, 10,  5,  5,
      0,  0,  0, 20, 20,  0,  0,  0,
      5, -5,-10,  0,  0,-10, -5,  5,
      5, 10, 10,-20,-20, 10, 10,  5,
      0,  0,  0,  0,  0,  0,  0,  0],
  n: [
    -50,-40,-30,-30,-30,-30,-40,-50,
    -40,-20,  0,  0,  0,  0,-20,-40,
    -30,  0, 10, 15, 15, 10,  0,-30,
    -30,  5, 15, 20, 20, 15,  5,-30,
    -30,  0, 15, 20, 20, 15,  0,-30,
    -30,  5, 10, 15, 15, 10,  5,-30,
    -40,-20,  0,  5,  5,  0,-20,-40,
    -50,-40,-30,-30,-30,-30,-40,-50],
  b: [
    -20,-10,-10,-10,-10,-10,-10,-20,
    -10,  0,  0,  0,  0,  0,  0,-10,
    -10,  0,  5, 10, 10,  5,  0,-10,
    -10,  5,  5, 10, 10,  5,  5,-10,
    -10,  0, 10, 10, 10, 10,  0,-10,
    -10, 10, 10, 10, 10, 10, 10,-10,
    -10,  5,  0,  0,  0,  0,  5,-10,
    -20,-10,-10,-10,-10,-10,-10,-20],
  r: [
      0,  0,  0,  0,  0,  0,  0,  0,
      5, 10, 10, 10, 10, 10, 10,  5,
     -5,  0,  0,  0,  0,  0,  0, -5,
     -5,  0,  0,  0,  0,  0,  0, -5,
     -5,  0,  0,  0,  0,  0,  0, -5,
     -5,  0,  0,  0,  0,  0,  0, -5,
     -5,  0,  0,  0,  0,  0,  0, -5,
      0,  0,  0,  5,  5,  0,  0,  0],
  q: [
    -20,-10,-10, -5, -5,-10,-10,-20,
    -10,  0,  0,  0,  0,  0,  0,-10,
    -10,  0,  5,  5,  5,  5,  0,-10,
     -5,  0,  5,  5,  5,  5,  0, -5,
      0,  0,  5,  5,  5,  5,  0, -5,
    -10,  5,  5,  5,  5,  5,  0,-10,
    -10,  0,  5,  0,  0,  0,  0,-10,
    -20,-10,-10, -5, -5,-10,-10,-20],
  k: [
    -30,-40,-40,-50,-50,-40,-40,-30,
    -30,-40,-40,-50,-50,-40,-40,-30,
    -30,-40,-40,-50,-50,-40,-40,-30,
    -30,-40,-40,-50,-50,-40,-40,-30,
    -20,-30,-30,-40,-40,-30,-30,-20,
    -10,-20,-20,-20,-20,-20,-20,-10,
     20, 20,  0,  0,  0,  0, 20, 20,
     20, 30, 10,  0,  0, 10, 30, 20],
};

// Static evaluation from White's perspective (+ favours White).
function evaluate(chess) {
  const b = chess.board();
  let s = 0;
  for (let i = 0; i < 8; i++) {
    for (let j = 0; j < 8; j++) {
      const sq = b[i][j];
      if (!sq) continue;
      const v = VAL[sq.type];
      if (sq.color === "w") s += v + PST[sq.type][i * 8 + j];
      else                  s -= v + PST[sq.type][(7 - i) * 8 + j];
    }
  }
  return s;
}
// Evaluation from the side-to-move's perspective (negamax convention).
const evalStm = (chess) => (chess.turn() === "w" ? 1 : -1) * evaluate(chess);

// MVV-LVA-ish ordering: try captures (big victim, small attacker) + promotions first.
function order(moves) {
  for (const m of moves) {
    m._o = (m.captured ? 10 * VAL[m.captured] - VAL[m.piece] : 0) + (m.promotion ? VAL[m.promotion] : 0);
  }
  moves.sort((a, b) => b._o - a._o);
}

let nodes = 0, deadline = 0;

function nega(chess, depth, ply, alpha, beta) {
  if (depth <= 0) return evalStm(chess);
  if ((++nodes & 1023) === 0 && Date.now() > deadline) throw ABORT;
  const moves = chess.moves({ verbose: true });
  if (moves.length === 0) return chess.inCheck() ? -(MATE - ply) : 0;  // checkmate / stalemate
  order(moves);
  let best = -INF;
  for (const m of moves) {
    chess.move(m);
    const v = -nega(chess, depth - 1, ply + 1, -beta, -alpha);
    chess.undo();
    if (v > best) best = v;
    if (best > alpha) alpha = best;
    if (alpha >= beta) break;   // beta cutoff
  }
  return best;
}

// Iterative deepening at the root; returns the best verbose move.
function searchRoot(chess, maxDepth, timeMs) {
  nodes = 0;
  deadline = Date.now() + timeMs;
  let bestOverall = chess.moves({ verbose: true })[0];
  for (let d = 1; d <= maxDepth; d++) {
    const moves = chess.moves({ verbose: true });
    order(moves);
    // Search the previous iteration's best first (better pruning).
    if (bestOverall) {
      const i = moves.findIndex((m) => m.from === bestOverall.from && m.to === bestOverall.to && m.promotion === bestOverall.promotion);
      if (i > 0) moves.unshift(moves.splice(i, 1)[0]);
    }
    let best = null, alpha = -INF;
    try {
      for (const m of moves) {
        chess.move(m);
        const v = -nega(chess, d - 1, 1, -INF, -alpha);
        chess.undo();
        if (best === null || v > alpha) { alpha = v; best = m; }
      }
    } catch (e) {
      if (e !== ABORT) throw e;
      break;   // out of time — keep the last completed depth's result
    }
    if (best) bestOverall = best;
    if (Date.now() > deadline) break;
  }
  return bestOverall;
}

// easy: 1-ply greedy, choosing randomly among moves near the best (so it varies
// and blunders a little — beatable, but won't hang material for nothing).
function easyMove(chess) {
  const moves = chess.moves({ verbose: true });
  const scored = moves.map((m) => {
    chess.move(m);
    const v = -evalStm(chess);   // value to us after our move
    chess.undo();
    return { m, v };
  });
  const best = Math.max(...scored.map((s) => s.v));
  const pool = scored.filter((s) => s.v >= best - 80);
  return pool[Math.floor(Math.random() * pool.length)].m;
}

// Pick a move for the given FEN + difficulty. Returns {from,to,promotion} or null.
export function chooseMove(fen, difficulty) {
  const chess = new Chess(fen);
  if (chess.moves().length === 0) return null;
  let m;
  if (difficulty === "easy") m = easyMove(chess);
  else m = searchRoot(chess, difficulty === "hard" ? 4 : 3, difficulty === "hard" ? 2500 : 1500);
  return m ? { from: m.from, to: m.to, promotion: m.promotion || undefined } : null;
}
