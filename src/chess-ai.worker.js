// ============================================================================
//  Web Worker wrapper around the chess AI (src/chess-ai.js). Runs the search off
//  the main thread so the raytraced view stays responsive while the AI thinks.
//  Launched from chess-main.js as a module worker:
//    new Worker("./src/chess-ai.worker.js", { type: "module" })
//  Message in:  { id, fen, difficulty }   out: { id, move: {from,to,promotion}|null }
// ============================================================================

import { chooseMove } from "./chess-ai.js";

self.onmessage = (e) => {
  const { id, fen, difficulty } = e.data;
  let move = null;
  try {
    move = chooseMove(fen, difficulty);
  } catch (err) {
    console.error("[chess-ai] search failed:", err);
  }
  self.postMessage({ id, move });
};
