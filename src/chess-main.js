// ============================================================================
//  WebGPU chess raytracer - engine, orbit camera, render loop (render-on-demand).
// ============================================================================

import { buildStartPosition, buildShowcase, sceneParams } from "./chess-scene.js";
import { GAMES, sqIdx, cellWorld, sanLabel } from "./chess-game.js";
import { Chess, SQUARES } from "./vendor/chess.js";

const canvas = document.getElementById("gfx");
const hud = document.getElementById("hud");
const statusbar = document.getElementById("statusbar");
const status = document.getElementById("status");

// ---- Orbit camera ----------------------------------------------------------

const camera = {
  target: [0, 0.45, 0],
  azimuth: 0.7,
  elevation: 0.55,
  distance: 11.0,
  fov: (45 * Math.PI) / 180,
};

const normalize = (v) => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

function cameraBasis() {
  const ce = Math.cos(camera.elevation), se = Math.sin(camera.elevation);
  const ca = Math.cos(camera.azimuth), sa = Math.sin(camera.azimuth);
  const pos = [
    camera.target[0] + camera.distance * ce * sa,
    camera.target[1] + camera.distance * se,
    camera.target[2] + camera.distance * ce * ca,
  ];
  const fwd = normalize([
    camera.target[0] - pos[0], camera.target[1] - pos[1], camera.target[2] - pos[2],
  ]);
  const right = normalize(cross(fwd, [0, 1, 0]));
  const up = cross(right, fwd);
  return { pos, fwd, right, up };
}

// Pan/strafe the look-at target in the horizontal plane. dx = right, dz = forward.
function pan(dx, dz) {
  const ca = Math.cos(camera.azimuth), sa = Math.sin(camera.azimuth);
  const step = 0.35;
  // camera-right = (ca,0,-sa); ground-forward (cam->target) = (-sa,0,-ca)
  camera.target[0] += (ca * dx - sa * dz) * step;
  camera.target[2] += (-sa * dx - ca * dz) * step;
  camera.target[0] = Math.max(-8, Math.min(8, camera.target[0]));
  camera.target[2] = Math.max(-8, Math.min(8, camera.target[2]));
}

// ---- State -----------------------------------------------------------------

const state = {
  paused: false,
  autoRotate: true,   // Watch spins the set by default; Play turns it off (see setMode / playNewGame)
  showcase: false,
  resScale: 1.0,
  shadowSoftness: sceneParams.shadowSoftness,
  fxaa: true,    // FXAA edge anti-aliasing post-pass (key 6)
  showDebug: false, // perf/debug overlay visible (key `); off keeps the view clean
  dbgFlags: 0,   // bit0 no-shadow, bit1 no-reflect, bit2 no-refract (GPU profiling)
  time: 0,
  frame: 0,
  glowLead: 0.20,   // pre-move glow duration (s); the glow then fades as the glide starts

  // Glass tint per side: the colour the glass transmits + a density knob.
  // Absorption = (1 - tint) * density, so the dominant channel stays bright and
  // density deepens saturation (see glassAbsorbVec / the live colour controls).
  glassW: { tint: [0.96, 0.69, 0.13], density: 12.0 }, // white pieces: amber/gold
  glassB: { tint: [0.518, 0.118, 1.0], density: 9.0 }, // black pieces: violet (#841eff)
};

// Convert a {tint,density} side into a Beer's-law absorption coefficient vec3.
const glassAbsorbVec = (g) => g.tint.map((c) => (1 - c) * g.density);
// "#rrggbb" -> [r,g,b] in 0..1; back the other way for the colour inputs.
const hexToRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
const rgbToHex = (rgb) =>
  "#" + rgb.map((c) => Math.round(c * 255).toString(16).padStart(2, "0")).join("");

let requestRender = () => {};
let setBoard = (_showcase) => {}; // assigned in init() once the GPU buffer exists
let gpuMs = 0;            // smoothed GPU render-pass time (timestamp-query), ms
let gpuTimingOn = false;  // true once the device has the timestamp-query feature

function setInspect(v) {
  // Toggling inspect leaves game playback / a live game and hands the board back.
  if (game.mode) {
    game.mode = false; game.playMode = false; game.playing = false; game.anim = null;
    game.ended = false; game.ending = null; game.result = null; game.highlightData.fill(0);
    play.reqId++; play.thinking = false;
    syncGameUI();
  }
  state.showcase = v;
  setBoard(v);
  const chk = document.getElementById("ctrl-inspect");
  if (chk) chk.checked = v;
  if (v) {
    // side-on framing for clean piece profiles
    camera.target = [-0.5, 0.6, 0];
    camera.azimuth = Math.PI / 2;
    camera.elevation = 0.12;
    camera.distance = 8.5;
  } else {
    camera.target = [0, 0.45, 0];
    camera.azimuth = 0.7;
    camera.elevation = 0.55;
    camera.distance = 11.0;
  }
  requestRender();
}

function setPaused(p) {
  state.paused = p;
  const btn = document.getElementById("ctrl-pause");
  if (btn) btn.textContent = p ? "▶ Resume" : "⏸ Pause";
  requestRender();
}
function setAutoRotate(v) {
  state.autoRotate = v;
  const chk = document.getElementById("ctrl-spin");
  if (chk) chk.checked = v;
  requestRender();
}

// ---- Animated game playback ------------------------------------------------
// Resting pieces live in the static board buffer; the few pieces that are in
// motion / being captured / highlighted are emitted into the `overlay` storage
// buffer with explicit world positions + per-piece FX (glow, red flash, scale,
// jump height) and unioned into the SDF field by the shader. Each frame we
// recompute both buffers + the square-glow uniforms from the playback clock.

// Pacing (seconds). "Relaxed": ~1.5s/ply -> ~50s for the 33-ply game.
// Pre-move glow duration is live-tunable via state.glowLead (the "Move glow" slider).
const PACE = {
  glide: 0.62, settle: 0.45, settleCheck: 0.85, mate: 3.2,
  rookDelay: 0.10, jumpH: 0.34,
};
const GLOW_PEAK = 2.6, FLASH_PEAK = 3.2, KING_PEAK = 2.4, SQ_PEAK = 1.7, MATE_PEAK = 2.6, PROMO_PEAK = 2.8;
const RED = [1.0, 0.05, 0.05];
const SQ_COLOR = [1.0, 0.86, 0.45];   // warm-gold square outline

// Resignation end-state: the losing king topples (over RESIGN_TOPPLE s) with a
// fading red glow, the losing army dims (over RESIGN_DIM s, via extra glass
// absorption), and the winning king holds a gold glow. The end-state keeps
// animating for RESIGN_DUR s (for the topple + glow pulse), then rests as a
// static tableau the camera can still orbit.
const RESIGN = { topple: 1.15, dim: 1.5, dur: 2.6, angle: 1.70, winGlow: 2.2, fallGlow: 2.2, dimAdd: 9.0 };
const GOLD = [1.0, 0.82, 0.40];       // victory glow for the winning king

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const ease = (x) => { x = clamp01(x); return x * x * (3 - 2 * x); };
const lerp = (a, b, t) => a + (b - a) * t;
const pieceType = (v) => (v > 10 ? v - 10 : v);   // 1..6
const isKnight = (v) => pieceType(v) === 2;
const tintOf = (v) => (v > 10 ? state.glassB.tint : state.glassW.tint);

// The selectable famous games (see chess-game.js). `activeGame` is the one the
// playthrough is currently bound to; switching it resets the board to its start.
let activeGame = GAMES[0];

const game = {
  mode: false,        // we own the board/overlay buffers while true
  playMode: false,    // true = interactive single-player (vs scripted playthrough)
  ending: null,       // "checkmate" | "resignation" | "draw" (set when ended)
  result: null,       // "1-0" | "0-1" | "1/2-1/2"
  playing: false,
  ended: false,
  stepOnce: false,
  ply: 0,             // committed position reflects activeGame.plies[0, ply)
  board: buildStartPosition(),
  anim: null,         // current ply animation descriptor (or null)
  speed: 1,           // playback fast-forward multiplier (1 / 2 / 3)
  endClock: 0,        // seconds since the game ended (drives the resignation end-state)
  // per-frame outputs consumed by drawFrame():
  staticData: new Float32Array(64),
  overlayData: new Float32Array(96),   // 8 slots * 12 floats (pos+code · emissive+scale · tilt)
  highlightData: new Float32Array(64), // per-cell board highlight codes (Play mode; 0 elsewhere)
  overlayCount: 0,
  hiStart: -1, hiEnd: -1, hiGlow: 0, hiColor: SQ_COLOR,
};

function applyPlyTo(b, ply) {
  if (ply.castle) {
    const kf = sqIdx(ply.castle.king[0]), kt = sqIdx(ply.castle.king[1]);
    const rf = sqIdx(ply.castle.rook[0]), rt = sqIdx(ply.castle.rook[1]);
    b[kt] = b[kf]; b[kf] = 0; b[rt] = b[rf]; b[rf] = 0;
  } else {
    const f = sqIdx(ply.from), t = sqIdx(ply.to);
    const moved = b[f];
    // Promotion swaps the pawn for its new type, keeping the side's +10 offset.
    b[t] = ply.promo ? (ply.promo + (moved > 10 ? 10 : 0)) : moved;
    b[f] = 0;
    // En passant: the captured pawn is on its own square, not the destination.
    if (ply.ep) b[sqIdx(ply.ep)] = 0;
  }
}
function boardAtPly(n) {
  const b = buildStartPosition();
  for (let i = 0; i < n; i++) applyPlyTo(b, activeGame.plies[i]);
  return b;
}
function findKing(board, whiteMoved) {
  const target = whiteMoved ? 16 : 6;   // checked king is the opponent's
  for (let i = 0; i < 64; i++) if (board[i] === target) return i;
  return -1;
}

// Begin animating one ply. `whiteMoved` flags which side moved (for the checked-
// king highlight); `idx` is the scripted ply index for the HUD label (-1 in Play).
function startAnim(ply, whiteMoved, idx = -1) {
  const a = { idx, clock: 0, movers: [], captured: null,
    check: !!ply.check, mate: !!ply.mate, kingIdx: -1, ply };
  if (ply.castle) {
    const kf = sqIdx(ply.castle.king[0]), kt = sqIdx(ply.castle.king[1]);
    const rf = sqIdx(ply.castle.rook[0]), rt = sqIdx(ply.castle.rook[1]);
    a.movers.push({ val: game.board[kf], from: kf, to: kt, jump: false, delay: 0 });
    a.movers.push({ val: game.board[rf], from: rf, to: rt, jump: false, delay: PACE.rookDelay });
    a.hiFrom = kf; a.hiTo = kt;
  } else {
    const from = sqIdx(ply.from), to = sqIdx(ply.to);
    const val = game.board[from];
    const mover = { val, from, to, jump: isKnight(val), delay: 0 };
    if (ply.promo) mover.promoVal = ply.promo + (val > 10 ? 10 : 0);  // pawn -> new piece
    a.movers.push(mover);
    a.hiFrom = from; a.hiTo = to;
    if (ply.ep) {                                   // en passant: capture is off the dest
      const ei = sqIdx(ply.ep);
      a.captured = { val: game.board[ei], idx: ei };
    } else {
      const cap = game.board[to];
      if (cap > 0.5) a.captured = { val: cap, idx: to };
    }
  }
  if (a.check) a.kingIdx = findKing(game.board, whiteMoved);
  a.glow = state.glowLead;   // captured per-ply so a mid-move slider change can't desync
  a.settleDur = a.mate ? PACE.mate : (a.check ? PACE.settleCheck : PACE.settle);
  a.total = a.glow + PACE.glide + a.settleDur;
  game.anim = a;
}

function pushOverlay(n, x, y, z, code, e0, e1, e2, scale, tilt = 0, dirX = 0, dirZ = 0) {
  if (n >= 8) return n;
  const o = n * 12;   // 3 vec4 per slot (must match the WGSL overlay array stride)
  const ov = game.overlayData;
  ov[o] = x; ov[o + 1] = y; ov[o + 2] = z; ov[o + 3] = code;
  ov[o + 4] = e0; ov[o + 5] = e1; ov[o + 6] = e2; ov[o + 7] = scale;
  ov[o + 8] = tilt; ov[o + 9] = dirX; ov[o + 10] = dirZ; ov[o + 11] = 0;  // tilt + fall direction
  return n + 1;
}

// Resignation tableau: the losing king toppled + fading red, the winning king
// glowing gold. (The losing army's dimming is applied to the glass uniforms in
// drawFrame.) Driven by game.endClock so it animates then rests.
function computeResignOutputs() {
  const stat = game.staticData;
  const blackLost = game.result === "1-0";
  const loserVal = blackLost ? 16 : 6;
  const winnerVal = blackLost ? 6 : 16;
  const loserIdx = game.board.indexOf(loserVal);
  const winnerIdx = game.board.indexOf(winnerVal);
  const c = game.endClock;
  let n = 0;
  if (loserIdx >= 0) {              // king tips over its base; red glow fades as it falls
    stat[loserIdx] = 0;
    const w = cellWorld(loserIdx);
    const tp = ease(clamp01(c / RESIGN.topple));
    const g = RESIGN.fallGlow * (1 - tp);
    // Topple along the inward 45° diagonal (toward the board centre) so the king
    // always lands on the board rather than clipping off an edge.
    const dirX = (w[0] <= 0 ? 1 : -1) * Math.SQRT1_2;
    const dirZ = (w[2] <= 0 ? 1 : -1) * Math.SQRT1_2;
    n = pushOverlay(n, w[0], 0, w[2], loserVal, RED[0] * g, RED[1] * g, RED[2] * g, 1.0, tp * RESIGN.angle, dirX, dirZ);
  }
  if (winnerIdx >= 0) {            // steady gold victory glow, gentle pulse
    stat[winnerIdx] = 0;
    const w = cellWorld(winnerIdx);
    const gi = RESIGN.winGlow * (0.7 + 0.3 * Math.sin(c * 6));
    n = pushOverlay(n, w[0], 0, w[2], winnerVal, GOLD[0] * gi, GOLD[1] * gi, GOLD[2] * gi, 1.0, 0);
  }
  game.overlayCount = n;
}

function computeOutputs() {
  game.hiStart = -1; game.hiEnd = -1; game.hiGlow = 0; game.hiColor = SQ_COLOR;
  game.staticData.set(game.board);
  if (game.ended && game.ending === "resignation") { computeResignOutputs(); return; }
  const a = game.anim;
  if (!a) { game.overlayCount = 0; return; }

  const c = a.clock;
  const inGlow = c < a.glow;
  const glideT = clamp01((c - a.glow) / PACE.glide);
  const inGlide = c >= a.glow && c < a.glow + PACE.glide;
  const inSettle = c >= a.glow + PACE.glide;
  const sEase = ease(glideT);
  const pulse = 0.6 + 0.4 * Math.sin(c * 16);
  const stat = game.staticData;
  let n = 0;

  for (const m of a.movers) {
    stat[m.from] = 0; stat[m.to] = 0;
    const wf = cellWorld(m.from), wt = cellWorld(m.to);
    let s = sEase;
    if (m.delay) s = ease(clamp01((c - a.glow - m.delay) / PACE.glide));
    let x = wf[0], y = 0, z = wf[2];
    if (!inGlow) { x = lerp(wf[0], wt[0], s); z = lerp(wf[2], wt[2], s); }
    if (inSettle) { x = wt[0]; z = wt[2]; }
    if (m.jump && !inGlow && !inSettle) y = PACE.jumpH * 4 * s * (1 - s);
    // Glow pulse: ramp up over the lead, then fade out over the first ~30% of the
    // glide so the move reads as a distinct "glow -> move" rather than glow-while-moving.
    let gi = 0;
    if (inGlow) gi = ease(c / a.glow) * GLOW_PEAK;
    else if (inGlide) gi = GLOW_PEAK * (1 - ease(clamp01((c - a.glow) / (PACE.glide * 0.30))));
    // The pawn becomes its promoted piece on arrival (settle); glides as a pawn.
    const renderVal = (m.promoVal && inSettle) ? m.promoVal : m.val;
    const col = tintOf(renderVal);
    let e0 = col[0] * gi, e1 = col[1] * gi, e2 = col[2] * gi;
    // Promotion flourish: a gold sparkle as the new piece appears, fading over the
    // settle. (The mate flourish below wins if this move is also the checkmate.)
    if (m.promoVal && inSettle) {
      const pf = PROMO_PEAK * (1 - ease(clamp01((c - a.glow - PACE.glide) / (a.settleDur * 0.6)))) * pulse;
      e0 = Math.max(e0, pf); e1 = Math.max(e1, pf * 0.9); e2 = Math.max(e2, pf * 0.55);
    }
    if (a.mate && inSettle) { const f = MATE_PEAK * pulse; e0 = f; e1 = f * 0.92; e2 = f * 0.78; }
    n = pushOverlay(n, x, y, z, renderVal, e0, e1, e2, 1.0);
  }

  if (a.captured) {
    stat[a.captured.idx] = 0;
    const w = cellWorld(a.captured.idx);
    let scale = 1, ri = 0;
    if (inGlow) { ri = ease(c / a.glow) * 1.2; }
    else {
      const ct = clamp01((c - a.glow) / (PACE.glide * 0.45));
      scale = 1 - ct; ri = FLASH_PEAK * (1 - ct) * pulse;
    }
    if (scale > 0.03) n = pushOverlay(n, w[0], 0, w[2], a.captured.val, RED[0] * ri, RED[1] * ri, RED[2] * ri, scale);
  }

  if (a.check && a.kingIdx >= 0 && !inGlow) {
    stat[a.kingIdx] = 0;
    const w = cellWorld(a.kingIdx);
    const ki = (a.mate ? MATE_PEAK : KING_PEAK) * pulse;
    n = pushOverlay(n, w[0], 0, w[2], game.board[a.kingIdx], RED[0] * ki, RED[1] * ki, RED[2] * ki, 1.0);
  }

  let sg = inGlow ? ease(c / a.glow) : (inGlide ? 1 : clamp01(1 - (c - a.glow - PACE.glide) / a.settleDur));
  game.hiGlow = sg * SQ_PEAK;
  game.hiStart = a.hiFrom; game.hiEnd = a.hiTo;
  game.overlayCount = n;
}

function gameTick(dt) {
  if (game.ended) {   // run the resignation end-state timeline (topple/dim/glow)
    if (game.ending === "resignation" && game.endClock < RESIGN.dur) {
      game.endClock += dt;
      computeOutputs();
    }
    return;
  }
  // Play mode: the move animation is driven by clicks / the AI worker, not a
  // scripted ply list — just advance the current anim and hand off on completion.
  if (game.playMode) {
    if (!game.anim) { computeOutputs(); return; }
    game.anim.clock += dt;
    if (game.anim.clock >= game.anim.total) {
      applyPlyTo(game.board, game.anim.ply);
      game.anim = null;
      computeOutputs();
      onPlayMoveComplete();
      return;
    }
    computeOutputs();
    return;
  }
  if (!game.anim) {
    if (game.playing && game.ply < activeGame.plies.length) startAnim(activeGame.plies[game.ply], game.ply % 2 === 0, game.ply);
    else { computeOutputs(); return; }
  }
  game.anim.clock += dt;
  if (game.anim.clock >= game.anim.total) {
    applyPlyTo(game.board, game.anim.ply);
    game.ply++;
    game.anim = null;
    if (game.stepOnce) { game.stepOnce = false; game.playing = false; }
    if (game.ply >= activeGame.plies.length) {
      game.playing = false; game.ended = true;
      game.ending = activeGame.ending; game.result = activeGame.result;   // for the end-state FX
    }
    computeOutputs();
    return;
  }
  computeOutputs();
}

// The resignation end-state keeps the loop alive while the topple/glow play out.
const endStateAnimating = () =>
  game.ended && game.ending === "resignation" && game.endClock < RESIGN.dur;
const gameRunning = () => game.mode && (game.playing || game.anim !== null || endStateAnimating());

function gameEnter() {
  if (state.showcase) {
    state.showcase = false;
    const chk = document.getElementById("ctrl-inspect");
    if (chk) chk.checked = false;
    camera.target = [0, 0.45, 0]; camera.azimuth = 0.7; camera.elevation = 0.55; camera.distance = 11.0;
  }
  game.mode = true; game.playMode = false; game.playing = false; game.ended = false; game.stepOnce = false;
  game.ending = null; game.result = null;
  game.ply = 0; game.anim = null; game.endClock = 0; game.board = buildStartPosition();
  game.highlightData.fill(0);
  computeOutputs();
}
function gameReplay() { gameEnter(); game.playing = true; syncGameUI(); requestRender(); }
// Switch which famous game the playthrough is bound to, and reset to its start
// (the user then presses Play). Keeps the dropdown + HUD in sync.
function selectGame(index) {
  index = Math.max(0, Math.min(GAMES.length - 1, index | 0));
  activeGame = GAMES[index];
  const sel = document.getElementById("g-select");
  if (sel) sel.value = String(index);
  gameEnter();          // mode on, ply 0, paused at the starting position
  syncGameUI();
  requestRender();
}
function gamePlayPause() {
  if (!game.mode) { gameEnter(); game.playing = true; }
  else if (game.ended) { gameReplay(); return; }
  else game.playing = !game.playing;
  syncGameUI(); requestRender();
}
function gameStep(dir) {
  if (!game.mode) gameEnter();
  if (dir > 0) {
    if (game.anim || game.ply >= activeGame.plies.length) return;
    game.stepOnce = true; game.playing = true; game.ended = false;
  } else {
    game.anim = null; game.playing = false; game.ended = false; game.endClock = 0;
    game.ply = Math.max(0, game.ply - 1);
    game.board = boardAtPly(game.ply);
    computeOutputs();
  }
  syncGameUI(); requestRender();
}
function syncGameUI() {
  const b = document.getElementById("g-play");
  if (!b) return;
  if (!game.mode) b.textContent = "▶ Play game";
  else if (game.ended) b.textContent = "↺ Replay";
  else b.textContent = game.playing ? "⏸ Pause game" : "▶ Resume";
}
// Playback fast-forward: cycle ×1 -> ×2 -> ×3 -> ×1. Pure time-scaling of the
// playback clock — render quality is untouched (handy for the long 110-move game).
function cycleGameSpeed() {
  game.speed = game.speed >= 3 ? 1 : game.speed + 1;
  syncSpeedUI();
  requestRender();
}
function syncSpeedUI() {
  const b = document.getElementById("g-speed");
  if (!b) return;
  b.textContent = `${game.speed}×`;
  b.classList.toggle("on", game.speed > 1);
}

// ---- Single-player mode (vs AI) --------------------------------------------
// chess.js (`play.chess`) is the rules authority; it stays one move AHEAD of the
// animated `game.board` during a glide. Moves — human clicks or the AI worker —
// build a ply and drive the SAME animation pipeline as the scripted playthrough.

const play = {
  chess: null,
  human: "w",          // colour the user controls
  difficulty: "medium",
  selected: null,      // selected from-square (algebraic) or null
  targets: [],         // verbose legal moves from the selected square
  pendingPromo: null,  // { from, to } awaiting a promotion-piece choice
  thinking: false,     // AI is computing
  reqId: 0,            // worker request id (ignore stale replies)
  lastMove: null,      // { from, to }
};
let aiWorker = null;
const PTYPE = { p: 1, n: 2, b: 3, r: 4, q: 5, k: 6 };

// Smooth camera move — used to "rotate" into the traditional view on New Game.
const camTween = { active: false, t: 0, dur: 0.75, from: null, to: null };
function tweenCameraTo(to) {
  let d = (to.azimuth - camera.azimuth) % (2 * Math.PI);   // shortest-path rotation
  if (d > Math.PI) d -= 2 * Math.PI; else if (d < -Math.PI) d += 2 * Math.PI;
  camTween.from = { az: camera.azimuth, el: camera.elevation, dist: camera.distance, tgt: [...camera.target] };
  camTween.to = { az: camera.azimuth + d, el: to.elevation, dist: to.distance, tgt: [...to.target] };
  camTween.t = 0; camTween.active = true;
  requestRender();
}
function tickCamTween(dt) {
  camTween.t += dt;
  const s = ease(clamp01(camTween.t / camTween.dur));
  const f = camTween.from, t = camTween.to;
  camera.azimuth = lerp(f.az, t.az, s);
  camera.elevation = lerp(f.el, t.el, s);
  camera.distance = lerp(f.dist, t.dist, s);
  camera.target = [lerp(f.tgt[0], t.tgt[0], s), lerp(f.tgt[1], t.tgt[1], s), lerp(f.tgt[2], t.tgt[2], s)];
  if (camTween.t >= camTween.dur) camTween.active = false;
}
// Traditional perspective for the side the human plays: centred behind their own
// pieces, looking down the board (White from -z, Black from +z).
function playView() {
  return play.human === "b"
    ? { azimuth: 0, elevation: 0.52, distance: 11.0, target: [0, 0.45, 0] }
    : { azimuth: Math.PI, elevation: 0.52, distance: 11.0, target: [0, 0.45, 0] };
}

function boardFromChess(chess) {
  const b = new Float32Array(64);
  const grid = chess.board();              // grid[0] = rank 8
  for (let i = 0; i < 8; i++) for (let j = 0; j < 8; j++) {
    const s = grid[i][j];
    if (s) b[(7 - i) * 8 + j] = PTYPE[s.type] + (s.color === "b" ? 10 : 0);
  }
  return b;
}
function kingSquareOf(color) {
  for (const sq of SQUARES) { const p = play.chess.get(sq); if (p && p.type === "k" && p.color === color) return sq; }
  return null;
}
// Animation move descriptor from a chess.js verbose Move (check/mate read post-move).
function plyFromMove(mv) {
  const ply = { san: mv.san };
  if (mv.flags.includes("k") || mv.flags.includes("q")) {
    const side = mv.flags.includes("k") ? "k" : "q";
    const rank = mv.from[1];
    ply.castle = { king: [mv.from, mv.to], rook: side === "k" ? [`h${rank}`, `f${rank}`] : [`a${rank}`, `d${rank}`] };
  } else {
    ply.from = mv.from; ply.to = mv.to;
    if (mv.flags.includes("e")) ply.ep = mv.to[0] + mv.from[1];
    if (mv.promotion) ply.promo = PTYPE[mv.promotion];
  }
  if (play.chess.isCheck()) ply.check = true;
  if (play.chess.isCheckmate()) ply.mate = true;
  return ply;
}
function syncHighlights() {
  const hl = game.highlightData; hl.fill(0);
  if (!game.playMode) return;
  if (play.lastMove) { hl[sqIdx(play.lastMove.from)] = 4; hl[sqIdx(play.lastMove.to)] = 4; }
  if (play.selected) {
    hl[sqIdx(play.selected)] = 1;
    for (const m of play.targets) hl[sqIdx(m.to)] = (m.flags.includes("c") || m.flags.includes("e")) ? 3 : 2;
  }
  if (!game.ended && play.chess && play.chess.inCheck()) {
    const ks = kingSquareOf(play.chess.turn());
    if (ks) hl[sqIdx(ks)] = 5;
  }
}
function playMakeMove(spec) {              // commit to chess.js + animate on the board
  let mv = null;
  try { mv = play.chess.move(spec); } catch { mv = null; }
  if (!mv) return;
  play.selected = null; play.targets = []; play.pendingPromo = null;
  play.lastMove = { from: mv.from, to: mv.to };
  syncHighlights();
  startAnim(plyFromMove(mv), mv.color === "w");   // game.board is still the pre-move position
  syncPlayUI(); requestRender();
}
function onPlayMoveComplete() {            // called when a move's animation finishes
  if (play.chess.isGameOver()) { endPlayGame(); return; }
  syncHighlights(); syncPlayUI();
  if (play.chess.turn() !== play.human) requestAI();
  requestRender();
}
function requestAI() {
  if (!aiWorker) return;
  play.thinking = true;
  aiWorker.postMessage({ id: ++play.reqId, fen: play.chess.fen(), difficulty: play.difficulty });
  syncPlayUI(); requestRender();
}
function endPlayGame() {
  game.ended = true; game.endClock = 0;
  if (play.chess.isCheckmate()) { game.ending = "checkmate"; game.result = play.chess.turn() === "w" ? "0-1" : "1-0"; }
  else { game.ending = "draw"; game.result = "1/2-1/2"; }
  play.selected = null; play.targets = [];
  syncHighlights(); syncPlayUI(); requestRender();
}
function selectSquare(sq) {
  play.selected = sq;
  play.targets = play.chess.moves({ square: sq, verbose: true });
  syncHighlights(); requestRender();
}
function onSquareClick(sq) {
  if (!game.playMode || game.ended || play.thinking || game.anim || play.pendingPromo) return;
  if (play.chess.turn() !== play.human) return;
  const piece = play.chess.get(sq);
  if (play.selected) {
    const targets = play.targets.filter((m) => m.to === sq);
    if (targets.length) {
      if (targets.some((m) => m.promotion)) { play.pendingPromo = { from: play.selected, to: sq }; showPromoPicker(); return; }
      playMakeMove({ from: play.selected, to: sq });
      return;
    }
    if (piece && piece.color === play.human) selectSquare(sq);
    else { play.selected = null; play.targets = []; syncHighlights(); requestRender(); }
  } else if (piece && piece.color === play.human) {
    selectSquare(sq);
  }
}
function choosePromotion(letter) {
  if (!play.pendingPromo) return;
  const { from, to } = play.pendingPromo;
  hidePromoPicker();
  playMakeMove({ from, to, promotion: letter });
}
// Screen click -> board square (ray through the y=0 plane), or null if off-board.
function pickSquare(clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  const ndcX = ((clientX - rect.left) / rect.width) * 2 - 1;
  const ndcY = 1 - ((clientY - rect.top) / rect.height) * 2;
  const { pos, fwd, right, up } = cameraBasis();
  const aspect = canvas.width / canvas.height;
  const fovScale = Math.tan(camera.fov / 2);
  const dir = normalize([
    fwd[0] + right[0] * (ndcX * fovScale * aspect) + up[0] * (ndcY * fovScale),
    fwd[1] + right[1] * (ndcX * fovScale * aspect) + up[1] * (ndcY * fovScale),
    fwd[2] + right[2] * (ndcX * fovScale * aspect) + up[2] * (ndcY * fovScale),
  ]);
  if (Math.abs(dir[1]) < 1e-5) return null;
  const t = -pos[1] / dir[1];
  if (t <= 0) return null;
  const f = Math.floor(pos[0] + dir[0] * t + 4.0);
  const r = Math.floor(pos[2] + dir[2] * t + 4.0);
  if (f < 0 || f > 7 || r < 0 || r > 7) return null;
  return String.fromCharCode(97 + f) + (r + 1);
}
function ensureWorker() {
  if (aiWorker) return;
  aiWorker = new Worker(new URL("./chess-ai.worker.js", import.meta.url), { type: "module" });
  aiWorker.onmessage = (e) => {
    if (!game.playMode || game.ended || e.data.id !== play.reqId) return;   // stale / cancelled
    play.thinking = false;
    if (e.data.move) playMakeMove(e.data.move);
    else { syncPlayUI(); requestRender(); }
  };
}
function playNewGame(opts = {}) {
  if (state.showcase) { state.showcase = false; const c = document.getElementById("ctrl-inspect"); if (c) c.checked = false; }
  setAutoRotate(false);   // Play uses the static behind-your-pieces view (camera tweens below)
  ensureWorker();
  if (opts.human) play.human = opts.human;
  if (opts.difficulty) play.difficulty = opts.difficulty;
  play.chess = new Chess();
  play.selected = null; play.targets = []; play.pendingPromo = null; play.thinking = false; play.lastMove = null;
  play.reqId++;                                   // invalidate any in-flight AI reply
  game.mode = true; game.playMode = true; game.playing = false; game.ended = false;
  game.ending = null; game.result = null; game.anim = null; game.endClock = 0;
  game.board = boardFromChess(play.chess);
  tweenCameraTo(playView());   // rotate into the traditional behind-your-pieces view
  hidePromoPicker(); syncHighlights(); computeOutputs(); syncPlayUI();
  if (play.chess.turn() !== play.human) requestAI();   // AI (White) moves first if you're Black
  requestRender();
}
function playResign() {
  if (!game.playMode || game.ended) return;
  game.ended = true; game.ending = "resignation"; game.endClock = 0;
  game.result = play.human === "w" ? "0-1" : "1-0";    // the human resigns
  play.selected = null; play.targets = []; play.thinking = false; play.reqId++;
  syncHighlights(); syncPlayUI(); requestRender();
}

// ---- WebGPU ----------------------------------------------------------------

async function loadShader(file) {
  // Cache-bust: the .wgsl is edited constantly and a normal reload will happily
  // serve a stale copy, which looks exactly like a "ghost" rendering bug. The
  // query string forces a fresh fetch every load (see CLAUDE.md caching gotcha).
  const res = await fetch(`./shaders/${file}?v=${Date.now()}`);
  if (!res.ok) throw new Error(`Could not load ${file} (serve over http?)`);
  const code = await res.text();
  console.log(`[chess] ${file}: ${code.length} bytes`);  // confirm freshness in DevTools
  return code;
}

async function compileModule(device, file, label) {
  const module = device.createShaderModule({ code: await loadShader(file) });
  const errs = (await module.getCompilationInfo()).messages.filter((m) => m.type === "error");
  if (errs.length) {
    fail(`${label} compile error: ` + errs.map((e) => `L${e.lineNum}: ${e.message}`).join(" | "));
    return null;
  }
  return module;
}

async function init() {
  if (!navigator.gpu) {
    fail("WebGPU is not available in this browser. Try a recent Chrome or Edge.");
    return;
  }
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
  if (!adapter) { fail("No suitable GPU adapter found."); return; }
  const canTimestamp = adapter.features.has("timestamp-query");
  const device = await adapter.requestDevice({
    requiredFeatures: canTimestamp ? ["timestamp-query"] : [],
  });
  device.lost.then((info) => fail("GPU device lost: " + info.message));

  const ctx = canvas.getContext("webgpu");
  const format = navigator.gpu.getPreferredCanvasFormat();
  ctx.configure({ device, format, alphaMode: "opaque" });

  const module = await compileModule(device, "chess.wgsl", "Shader");
  if (!module) return;
  const fxaaModule = await compileModule(device, "fxaa.wgsl", "FXAA shader");
  if (!fxaaModule) return;

  const globalsBuf = device.createBuffer({
    size: 48 * 4,   // 12 vec4 lanes: 8 base + glassAbsW/B + anim + animCol
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  const startData = buildStartPosition();   // Float32Array(64) -> 16 vec4
  const showcaseData = buildShowcase();
  const boardBuf = device.createBuffer({
    size: startData.byteLength,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  setBoard = (showcase) => device.queue.writeBuffer(boardBuf, 0, showcase ? showcaseData : startData);
  setBoard(state.showcase);
  // Animation overlay: 8 pieces * 3 vec4 = 24 vec4 = 96 floats (pos+code · emissive+scale · tilt).
  const overlayBuf = device.createBuffer({
    size: 96 * 4,   // 8 slots * 3 vec4 (matches overlayData + the WGSL overlay array)
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  // Per-cell board highlights for Play mode (64 cells = 16 vec4). Zero otherwise.
  const highlightBuf = device.createBuffer({
    size: 64 * 4,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });

  const bindLayout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "read-only-storage" } },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "read-only-storage" } },
      { binding: 3, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "read-only-storage" } },
    ],
  });
  const bindGroup = device.createBindGroup({
    layout: bindLayout,
    entries: [
      { binding: 0, resource: { buffer: globalsBuf } },
      { binding: 1, resource: { buffer: boardBuf } },
      { binding: 2, resource: { buffer: overlayBuf } },
      { binding: 3, resource: { buffer: highlightBuf } },
    ],
  });
  const pipeline = device.createRenderPipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [bindLayout] }),
    vertex: { module, entryPoint: "vs" },
    fragment: { module, entryPoint: "fs", targets: [{ format }] },
    primitive: { topology: "triangle-list" },
  });

  // ---- FXAA post-pass --------------------------------------------------------
  // The scene renders into an offscreen texture; FXAA then samples it to the
  // swapchain, smoothing the high-contrast silhouette edges the 1-spp trace leaves
  // jagged. Applied every frame (toggle with key 6), so moving == still.
  const fxaaSampler = device.createSampler({ magFilter: "linear", minFilter: "linear" });
  const fxaaLayout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
    ],
  });
  const fxaaPipeline = device.createRenderPipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [fxaaLayout] }),
    vertex: { module: fxaaModule, entryPoint: "vs" },
    fragment: { module: fxaaModule, entryPoint: "fs", targets: [{ format }] },
    primitive: { topology: "triangle-list" },
  });
  // Offscreen scene target + FXAA bind group, recreated when the render size changes.
  let sceneView = null, fxaaBind = null, sceneTex = null, sceneW = 0, sceneH = 0;
  function ensureSceneTex() {
    if (sceneTex && sceneW === canvas.width && sceneH === canvas.height) return;
    if (sceneTex) sceneTex.destroy();
    sceneW = canvas.width; sceneH = canvas.height;
    sceneTex = device.createTexture({
      size: [sceneW, sceneH], format,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    sceneView = sceneTex.createView();
    fxaaBind = device.createBindGroup({
      layout: fxaaLayout,
      entries: [{ binding: 0, resource: sceneView }, { binding: 1, resource: fxaaSampler }],
    });
  }

  // ---- GPU timing (timestamp-query) ------------------------------------------
  // One timestamp at the start + end of the render pass = true GPU pass time (the
  // HUD fps also includes vsync/idle/CPU). Single readback buffer, so we only
  // resolve+map when it's free. The 1/2/3 keys flip debug bits in options.z to
  // disable shadows / reflections / refraction, so you can A/B the GPU-ms delta
  // and see where the time actually goes in this single fullscreen pass.
  gpuTimingOn = canTimestamp;
  let querySet = null, resolveBuf = null, resultBuf = null, timingBusy = false;
  if (canTimestamp) {
    querySet = device.createQuerySet({ type: "timestamp", count: 2 });
    resolveBuf = device.createBuffer({ size: 16, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC });
    resultBuf = device.createBuffer({ size: 16, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  }

  const globals = new Float32Array(48);

  function resize() {
    // Heavy scene: render at CSS pixels by default (cap DPR at 1). Use the
    // resolution keys to supersample if there's headroom.
    const dpr = Math.min(window.devicePixelRatio || 1, 1);
    const w = Math.max(1, Math.floor(canvas.clientWidth * dpr * state.resScale));
    const h = Math.max(1, Math.floor(canvas.clientHeight * dpr * state.resScale));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  }
  window.addEventListener("resize", () => requestRender());
  resize();

  let last = performance.now();
  let fps = 0;
  let rafId = null;
  let dirty = true;
  let idleTimer = null;

  const isAnimating = () => !state.paused && (state.autoRotate || gameRunning());

  function armIdle() {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (rafId === null && !isAnimating() && !state.paused) updateHud("idle");
    }, 350);
  }
  requestRender = () => {
    dirty = true;
    if (rafId === null) rafId = requestAnimationFrame(frame);
  };

  function frame(now) {
    rafId = null;
    const raw = (now - last) / 1000;
    last = now;
    const dt = Math.min(raw, 0.05);

    const anim = isAnimating();
    if (anim) { state.time += dt; if (state.autoRotate) camera.azimuth += dt * 0.25; }
    if (camTween.active) tickCamTween(dt);   // animated camera move (overrides auto-rotate this frame)
    if (gameRunning() && !state.paused) gameTick(dt * game.speed);  // fast-forward: scale the playback clock

    if (anim || camTween.active || dirty) {
      state.frame++;
      // Measure real frame time. Window up to 0.5s so genuinely slow frames are
      // counted (was 0.1s, which hid low fps); larger gaps are idle wake-ups.
      if (raw > 0 && raw < 0.5) {
        const inst = 1 / raw;
        fps = fps === 0 ? inst : fps * 0.85 + inst * 0.15;
      }
      drawFrame();
      dirty = false;
    }
    updateHud(state.paused ? "paused" : `${Math.round(fps)} fps`);

    if (anim || camTween.active) {
      if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
      rafId = requestAnimationFrame(frame);
    } else if (!state.paused) {
      armIdle();
    }
  }

  function drawFrame() {
    resize();
    const { pos, fwd, right, up } = cameraBasis();
    const aspect = canvas.width / canvas.height;
    const fovScale = Math.tan(camera.fov / 2);

    globals.set([pos[0], pos[1], pos[2], state.time], 0);
    globals.set([fwd[0], fwd[1], fwd[2], fovScale], 4);
    globals.set([right[0], right[1], right[2], aspect], 8);
    globals.set([up[0], up[1], up[2], 0], 12);
    globals.set([canvas.width, canvas.height, sceneParams.maxDepth, state.frame], 16);
    globals.set([...sceneParams.lightPos, sceneParams.lightRadius], 20);
    globals.set([...sceneParams.lightColor, sceneParams.ambient], 24);
    // options.x = soft-shadow march hardness k; options.z = debug flag bits
    // (1 no-shadow, 2 no-reflect, 4 no-refract) used for differential GPU timing.
    globals.set([48.0 / state.shadowSoftness, sceneParams.glossySamples, state.dbgFlags, 0], 28);
    // Glass absorption per side. On resignation the losing army dims: extra
    // absorption is added to every channel so it darkens toward black ("goes cold").
    let absW = glassAbsorbVec(state.glassW);
    let absB = glassAbsorbVec(state.glassB);
    if (game.mode && game.ended && game.ending === "resignation") {
      const d = ease(clamp01(game.endClock / RESIGN.dim)) * RESIGN.dimAdd;
      if (game.result === "1-0") absB = absB.map((c) => c + d);  // Black lost
      else absW = absW.map((c) => c + d);                              // White lost
    }
    globals.set([...absW, 0], 32);  // white-piece absorption
    globals.set([...absB, 0], 36);  // black-piece absorption
    // Animation: overlay count + start/end square + outline glow (lanes 40-47).
    globals.set([game.mode ? game.overlayCount : 0, game.hiStart, game.hiEnd, game.mode ? game.hiGlow : 0], 40);
    globals.set([game.hiColor[0], game.hiColor[1], game.hiColor[2], 0], 44);
    device.queue.writeBuffer(globalsBuf, 0, globals);
    if (game.mode) {
      device.queue.writeBuffer(boardBuf, 0, game.staticData);
      device.queue.writeBuffer(overlayBuf, 0, game.overlayData);
      device.queue.writeBuffer(highlightBuf, 0, game.highlightData);
    }

    // FXAA off for the debug views (bits 8/16) so diagnostics stay pixel-exact.
    const useFxaa = state.fxaa && (state.dbgFlags & 24) === 0;
    if (useFxaa) ensureSceneTex();

    const encoder = device.createCommandEncoder();
    const doTiming = gpuTimingOn && !timingBusy;
    const swapView = ctx.getCurrentTexture().createView();
    // Scene pass -> offscreen texture (FXAA on) or straight to the swapchain (off).
    const passDesc = {
      colorAttachments: [{
        view: useFxaa ? sceneView : swapView,
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
        loadOp: "clear", storeOp: "store",
      }],
    };
    if (gpuTimingOn) {
      passDesc.timestampWrites = { querySet, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1 };
    }
    const pass = encoder.beginRenderPass(passDesc);
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.draw(3);
    pass.end();
    // FXAA resolve pass -> swapchain. (GPU-ms above times the scene pass only.)
    if (useFxaa) {
      const fpass = encoder.beginRenderPass({
        colorAttachments: [{ view: swapView, clearValue: { r: 0, g: 0, b: 0, a: 1 }, loadOp: "clear", storeOp: "store" }],
      });
      fpass.setPipeline(fxaaPipeline);
      fpass.setBindGroup(0, fxaaBind);
      fpass.draw(3);
      fpass.end();
    }
    if (doTiming) {
      encoder.resolveQuerySet(querySet, 0, 2, resolveBuf, 0);
      encoder.copyBufferToBuffer(resolveBuf, 0, resultBuf, 0, 16);
    }
    device.queue.submit([encoder.finish()]);
    if (doTiming) {
      timingBusy = true;
      resultBuf.mapAsync(GPUMapMode.READ).then(() => {
        const ts = new BigInt64Array(resultBuf.getMappedRange().slice(0));
        resultBuf.unmap();
        const ms = Number(ts[1] - ts[0]) / 1e6;       // timestamps are nanoseconds
        if (ms > 0) gpuMs = (gpuMs === 0) ? ms : gpuMs * 0.85 + ms * 0.15;
        timingBusy = false;
      }).catch(() => { timingBusy = false; });
    }
  }

  requestRender();
  status.style.display = "none";
}

function updateHud(label) {
  updateStatusBar();
  if (state.showDebug) updateDebug(label);
}

// Toggle the perf/debug overlay (the ` key). Off by default to keep the view clean.
function setDebug(v) {
  state.showDebug = v;
  hud.classList.toggle("show", v);
  const hint = document.getElementById("hint");
  if (hint) hint.style.display = v ? "none" : "";   // hide the redundant cue while open
  requestRender();   // next frame fills the overlay (or it stays hidden)
}

// Minimal game-status pill (bottom-centre): mode · move · status/result.
// Shown only while a game is loaded; empty/idle scenes leave the board clear.
function updateStatusBar() {
  if (!game.mode) { statusbar.classList.remove("show"); return; }
  let title, move = "", st;
  if (game.playMode) {
    const youAre = play.human === "w" ? "White" : "Black";
    title = `You (${youAre}) vs AI · ${play.difficulty[0].toUpperCase()}${play.difficulty.slice(1)}`;
    const hist = play.chess ? play.chess.history() : [];
    move = hist.length ? hist[hist.length - 1] : "";
    if (game.ended) {
      let tag;
      if (game.ending === "checkmate") tag = `checkmate — ${game.result === "1-0" ? "White" : "Black"} wins`;
      else if (game.ending === "resignation") tag = `you resign — ${game.result === "1-0" ? "White" : "Black"} wins`;
      else tag = "draw";
      st = `<b style="color:#ff8d8d">${tag}</b>`;
    } else if (play.thinking) st = `<b style="color:#f0c070">AI thinking…</b>`;
    else if (play.chess && play.chess.inCheck()) st = `<b style="color:#ff8d8d">check</b>${play.chess.turn() === play.human ? ` <span class="dim">— your move</span>` : ""}`;
    else st = play.chess && play.chess.turn() === play.human ? "your move" : "AI to move";
  } else {
    const idx = game.anim ? game.anim.idx : game.ply - 1;
    move = sanLabel(activeGame, idx);
    title = activeGame.name;
    if (game.ended) {
      const tag = game.ending === "resignation" ? `${game.result === "1-0" ? "Black" : "White"} resigns` : "checkmate";
      st = `<b style="color:#ff8d8d">${tag}</b> <span class="dim">· ${game.result}</span>`;
    } else st = game.playing ? "playing" : "paused";
  }
  const spd = (!game.playMode && game.speed > 1) ? ` <b style="color:#f0c070">×${game.speed}</b>` : "";
  const sep = `<span class="sep">·</span>`;
  statusbar.innerHTML =
    `<span class="title">${title}</span>${sep}` +
    (move ? `<b>${move}</b>` : `<span class="dim">ready</span>`) +
    `${sep}<span class="dim">${st}</span>${spd}`;
  statusbar.classList.add("show");
}

// Perf/debug overlay (top-left): timings, resolution, profiling flags, key map.
function updateDebug(label) {
  const gpu = gpuTimingOn ? `${gpuMs.toFixed(2)} ms` : "n/a";
  const f = state.dbgFlags;
  const off = [];
  if (f & 1) off.push("shadow");
  if (f & 2) off.push("reflect");
  if (f & 4) off.push("refract");
  if (!state.fxaa) off.push("fxaa");
  const dbg = off.length ? ` &nbsp; <b style="color:#ff8d8d">off: ${off.join(",")}</b>` : "";
  hud.innerHTML =
    `<b>${label}</b> &nbsp; ${canvas.width}×${canvas.height} &nbsp; GPU: <b>${gpu}</b>` + dbg +
    `<br>shadow softness: <b>${state.shadowSoftness}</b> &nbsp; res: <b>${(state.resScale * 100) | 0}%</b>` +
    `<br><span class="dim">drag: orbit &nbsp; wheel: zoom &nbsp; arrows: strafe &nbsp; A: auto-rotate &nbsp; ` +
    `I: inspect &nbsp; F: speed &nbsp; Space: pause &nbsp; - =: res &nbsp; R: reset &nbsp; 1/2/3: shadow/reflect/refract &nbsp; 6: fxaa &nbsp; \`: hide</span>`;
}

function fail(msg) {
  status.style.display = "block";
  status.innerHTML = `<div class="err">${msg}</div>`;
  console.error(msg);
}

// ---- Input -----------------------------------------------------------------

let dragging = false, lastX = 0, lastY = 0, dragMoved = 0, downBtn = 0;
canvas.addEventListener("mousedown", (e) => { dragging = true; lastX = e.clientX; lastY = e.clientY; dragMoved = 0; downBtn = e.button; });
window.addEventListener("mouseup", (e) => {
  // A left press that didn't really move = a click: in Play mode, pick a square.
  if (dragging && downBtn === 0 && dragMoved < 5 && game.playMode) {
    const sq = pickSquare(e.clientX, e.clientY);
    if (sq) onSquareClick(sq);
  }
  dragging = false;
});
window.addEventListener("mousemove", (e) => {
  if (!dragging) return;
  dragMoved += Math.abs(e.clientX - lastX) + Math.abs(e.clientY - lastY);
  camera.azimuth -= (e.clientX - lastX) * 0.005;
  camera.elevation += (e.clientY - lastY) * 0.005;
  camera.elevation = Math.max(0.05, Math.min(1.45, camera.elevation));
  lastX = e.clientX; lastY = e.clientY;
  requestRender();
});
canvas.addEventListener("wheel", (e) => {
  camera.distance *= 1 + Math.sign(e.deltaY) * 0.08;
  camera.distance = Math.max(4.0, Math.min(28, camera.distance));
  e.preventDefault();
  requestRender();
}, { passive: false });

window.addEventListener("keydown", (e) => {
  switch (e.key.toLowerCase()) {
    case "a": setAutoRotate(!state.autoRotate); return;
    case "g": gamePlayPause(); return;
    case "f": cycleGameSpeed(); return;   // fast-forward playback ×1/×2/×3
    case "i": setInspect(!state.showcase); return;
    case " ": setPaused(!state.paused); e.preventDefault(); return;
    case "r":
      if (game.playMode) { tweenCameraTo(playView()); return; }   // back to the player's view
      camera.azimuth = 0.7; camera.elevation = 0.55; camera.distance = 11.0;
      camera.target = state.showcase ? [-0.5, 0.6, 0] : [0, 0.45, 0];
      break;
    case "arrowleft":  pan(-1, 0); e.preventDefault(); break;
    case "arrowright": pan(1, 0);  e.preventDefault(); break;
    case "arrowup":    pan(0, 1);  e.preventDefault(); break;
    case "arrowdown":  pan(0, -1); e.preventDefault(); break;
    case "-": state.resScale = Math.max(0.25, state.resScale - 0.1); break;
    case "=": case "+": state.resScale = Math.min(2.0, state.resScale + 0.1); break;
    case "1": state.dbgFlags ^= 1; break;   // toggle shadows   (GPU profiling)
    case "2": state.dbgFlags ^= 2; break;   // toggle reflections
    case "3": state.dbgFlags ^= 4; break;   // toggle refraction
    case "4": state.dbgFlags ^= 8; break;   // primary-hit debug view (green=piece, blue=board, red=sky)
    case "5": state.dbgFlags ^= 16; break;  // march-iteration heatmap (red brightness = steps used on a miss)
    case "6": state.fxaa = !state.fxaa; break;   // toggle FXAA edge anti-aliasing
    case "`": case "~": setDebug(!state.showDebug); return;   // toggle the debug overlay
    case "d": {  // dump the exact current state to the console (for the headless harness)
      const dump = {
        az: +camera.azimuth.toFixed(4), el: +camera.elevation.toFixed(4),
        dist: +camera.distance.toFixed(3), tgt: camera.target.map((v) => +v.toFixed(3)),
        mode: game.mode, ply: game.ply, count: game.overlayCount,
        board: Array.from(game.staticData),
        overlay: Array.from(game.overlayData.slice(0, game.overlayCount * 12)),
      };
      console.log("STATE_DUMP " + JSON.stringify(dump));
      return;
    }
    default: return;
  }
  requestRender();
});

function bindSlider(id, valId, key, fmt) {
  const el = document.getElementById(id);
  const out = document.getElementById(valId);
  if (!el) return;
  const apply = () => { state[key] = parseFloat(el.value); out.textContent = fmt(state[key]); requestRender(); };
  el.addEventListener("input", apply);
  apply();
}
bindSlider("ctrl-shadow", "ctrl-shadow-val", "shadowSoftness", (v) => v.toFixed(0));
bindSlider("ctrl-glow", "ctrl-glow-val", "glowLead", (v) => `${v.toFixed(2)}s`);

// Live glass-colour controls: a colour picker (hue) + density slider per side.
function bindGlass(side, colorId, densId, densValId) {
  const g = state[side];
  const colEl = document.getElementById(colorId);
  const densEl = document.getElementById(densId);
  const densOut = document.getElementById(densValId);
  if (!colEl || !densEl) return;
  if (colEl.value) colEl.value = rgbToHex(g.tint); // seed swatch from default tint
  densEl.value = g.density;
  const apply = () => {
    g.tint = hexToRgb(colEl.value);
    g.density = parseFloat(densEl.value);
    if (densOut) densOut.textContent = g.density.toFixed(1);
    requestRender();
  };
  colEl.addEventListener("input", apply);
  densEl.addEventListener("input", apply);
  apply();
}
bindGlass("glassW", "ctrl-white-col", "ctrl-white-den", "ctrl-white-den-val");
bindGlass("glassB", "ctrl-black-col", "ctrl-black-den", "ctrl-black-den-val");

const pauseBtn = document.getElementById("ctrl-pause");
if (pauseBtn) pauseBtn.addEventListener("click", () => setPaused(!state.paused));
const spinChk = document.getElementById("ctrl-spin");
if (spinChk) spinChk.addEventListener("change", () => setAutoRotate(spinChk.checked));
const inspectChk = document.getElementById("ctrl-inspect");
if (inspectChk) inspectChk.addEventListener("change", () => setInspect(inspectChk.checked));

// Populate the game-selector dropdown from GAMES (single source of truth) and
// switch the active game on change. subtitle -> option tooltip.
const gSelect = document.getElementById("g-select");
if (gSelect) {
  gSelect.innerHTML = GAMES
    .map((g, i) => `<option value="${i}" title="${g.subtitle}">${g.name}</option>`)
    .join("");
  gSelect.value = String(GAMES.indexOf(activeGame));
  gSelect.addEventListener("change", () => selectGame(parseInt(gSelect.value, 10)));
}

const gPlay = document.getElementById("g-play");
if (gPlay) gPlay.addEventListener("click", gamePlayPause);
const gBack = document.getElementById("g-step-back");
if (gBack) gBack.addEventListener("click", () => gameStep(-1));
const gFwd = document.getElementById("g-step-fwd");
if (gFwd) gFwd.addEventListener("click", () => gameStep(1));
const gReplay = document.getElementById("g-replay");
if (gReplay) gReplay.addEventListener("click", gameReplay);
const gSpeed = document.getElementById("g-speed");
if (gSpeed) { gSpeed.addEventListener("click", cycleGameSpeed); syncSpeedUI(); }

// ---- Play-mode UI (Watch / Play toggle, controls, promotion picker) --------
function showPromoPicker() { const el = document.getElementById("promo-picker"); if (el) el.style.display = "flex"; }
function hidePromoPicker() { const el = document.getElementById("promo-picker"); if (el) el.style.display = "none"; }
function syncPlayUI() {
  // Turn/check/result text lives in the bottom status pill (updateStatusBar);
  // here we just keep the Play controls' enabled/selected state in sync.
  const resign = document.getElementById("p-resign"); if (resign) resign.disabled = !game.playMode || game.ended;
  const side = document.getElementById("p-side"); if (side) side.value = play.human;
  const diff = document.getElementById("p-difficulty"); if (diff) diff.value = play.difficulty;
}
function setMode(m) {
  const wp = document.getElementById("watch-panel"), pp = document.getElementById("play-panel");
  if (wp) wp.style.display = m === "watch" ? "" : "none";
  if (pp) pp.style.display = m === "play" ? "" : "none";
  const bw = document.getElementById("mode-watch"), bp = document.getElementById("mode-play");
  if (bw) bw.classList.toggle("on", m === "watch");
  if (bp) bp.classList.toggle("on", m === "play");
  if (m === "watch") setAutoRotate(true);   // Watch orbits the set by default (Play disables it)
  if (m === "play") {
    if (!game.playMode) playNewGame(); else { syncPlayUI(); requestRender(); }
  } else if (game.playMode) {
    // Leave Play mode -> back to the interactive/playthrough board.
    play.reqId++; play.thinking = false;
    game.playMode = false; game.mode = false; game.ended = false; game.ending = null; game.result = null;
    game.anim = null; game.highlightData.fill(0);
    hidePromoPicker(); setBoard(state.showcase);
    camera.target = [0, 0.45, 0]; camera.azimuth = 0.7; camera.elevation = 0.55; camera.distance = 11.0;
    syncGameUI(); requestRender();
  }
}
const modeWatch = document.getElementById("mode-watch");
if (modeWatch) modeWatch.addEventListener("click", () => setMode("watch"));
const modePlay = document.getElementById("mode-play");
if (modePlay) modePlay.addEventListener("click", () => setMode("play"));
const pNew = document.getElementById("p-newgame");
if (pNew) pNew.addEventListener("click", () => playNewGame());
const pSide = document.getElementById("p-side");
if (pSide) pSide.addEventListener("change", () => playNewGame({ human: pSide.value }));
const pDiff = document.getElementById("p-difficulty");
if (pDiff) pDiff.addEventListener("change", () => { play.difficulty = pDiff.value; syncPlayUI(); });
const pResign = document.getElementById("p-resign");
if (pResign) pResign.addEventListener("click", playResign);
document.querySelectorAll(".promo-btn").forEach((b) => b.addEventListener("click", () => choosePromotion(b.dataset.piece)));
setMode("watch");

init();
