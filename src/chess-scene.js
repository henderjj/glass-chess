// ============================================================================
//  Chess starting position -> 64-cell board buffer.
//  Cell value: 0 empty; 1..6 white (amber); 11..16 black (dark red).
//  Type codes: 1 pawn, 2 knight, 3 bishop, 4 rook, 5 queen, 6 king.
//  Cell index = rank * 8 + file. Rank 0 = white back rank (z = -3.5).
// ============================================================================

export const PIECE = { PAWN: 1, KNIGHT: 2, BISHOP: 3, ROOK: 4, QUEEN: 5, KING: 6 };
const BLACK = 10; // colour offset added to a black piece's type

// Back-rank file layout: a=rook ... e=king (queen on her own colour's file, d).
const BACK_RANK = [
  PIECE.ROOK, PIECE.KNIGHT, PIECE.BISHOP, PIECE.QUEEN,
  PIECE.KING, PIECE.BISHOP, PIECE.KNIGHT, PIECE.ROOK,
];

// Returns a Float32Array(64): board[rank*8 + file]. Uploaded as 16 vec4s.
export function buildStartPosition() {
  const cells = new Float32Array(64); // all empty by default
  for (let f = 0; f < 8; f++) {
    cells[0 * 8 + f] = BACK_RANK[f];          // white back rank
    cells[1 * 8 + f] = PIECE.PAWN;            // white pawns
    cells[6 * 8 + f] = PIECE.PAWN + BLACK;    // black pawns
    cells[7 * 8 + f] = BACK_RANK[f] + BLACK;  // black back rank
  }
  return cells;
}

// Inspect layout: one of each piece type (amber), isolated in a single file so
// nothing obscures anything. Knight sits second from the front.
export function buildShowcase() {
  const cells = new Float32Array(64);
  const file = 3;
  const types = [PIECE.PAWN, PIECE.KNIGHT, PIECE.BISHOP, PIECE.ROOK, PIECE.QUEEN, PIECE.KING];
  for (let i = 0; i < types.length; i++) {
    cells[(1 + i) * 8 + file] = types[i]; // ranks 1..6
  }
  return cells;
}

export const sceneParams = {
  lightPos: [5.5, 6.5, 4.0],   // lower elevation -> longer, more readable shadows
  lightRadius: 0.5,            // larger -> softer shadows
  lightColor: [1.0, 0.96, 0.9],
  ambient: 0.13,
  shadowSoftness: 4,           // 1=sharp .. 12=very soft; march hardness k = 48 / softness
  glossySamples: 1,            // board reflections are smooth; kept for parity
  maxDepth: 3,                 // refraction/reflection bounce limit (3 vs 4 ~halves the glass ray-tree)
};
