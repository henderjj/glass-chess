// CPU reference renderer that mirrors chess.wgsl's geometry path (sdfScene +
// marchPieces + the animation overlay) so rendering bugs can be reproduced and
// debugged HERE without a GPU. Outputs the same primary-hit debug colours as the
// shader's key-4 view: green = piece, blue = board, red = nothing/sky.
//   node tools/debug-render.mjs   ->   debug-static.png + debug-anim.png
import { writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

// ---- ported SDF helpers (mirror shaders/chess.wgsl) -------------------------
const len = (...a) => Math.hypot(...a);
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const sub = (p, o) => [p[0] - o[0], p[1] - o[1], p[2] - o[2]];
function sdSphere(p, r) { return len(p[0], p[1], p[2]) - r; }
function sdBox(p, b) {
  const qx = Math.abs(p[0]) - b[0], qy = Math.abs(p[1]) - b[1], qz = Math.abs(p[2]) - b[2];
  return len(Math.max(qx, 0), Math.max(qy, 0), Math.max(qz, 0)) + Math.min(Math.max(qx, Math.max(qy, qz)), 0);
}
function sdTorus(p, R, r) { return len(len(p[0], p[2]) - R, p[1]) - r; }
function sdCylinder(p, h, r) {
  const dx = len(p[0], p[2]) - r, dy = Math.abs(p[1]) - h;
  return Math.min(Math.max(dx, dy), 0) + len(Math.max(dx, 0), Math.max(dy, 0));
}
function sdCone(p, h, r1, r2) {
  const qx = len(p[0], p[2]), qy = p[1];
  const k1 = [r2, h], k2 = [r2 - r1, 2 * h];
  const cax = qx - Math.min(qx, qy < 0 ? r1 : r2), cay = Math.abs(qy) - h;
  const cl = clamp(((k1[0] - qx) * k2[0] + (k1[1] - qy) * k2[1]) / (k2[0] * k2[0] + k2[1] * k2[1]), 0, 1);
  const cbx = qx - k1[0] + k2[0] * cl, cby = qy - k1[1] + k2[1] * cl;
  const s = (cbx < 0 && cay < 0) ? -1 : 1;
  return s * Math.sqrt(Math.min(cax * cax + cay * cay, cbx * cbx + cby * cby));
}
function sdEllipsoid(p, r) { const k = len(p[0] / r[0], p[1] / r[1], p[2] / r[2]); return (k - 1) * Math.min(r[0], r[1], r[2]); }
function sdHead(p, c, r) { return sdEllipsoid(sub(p, c), [r, r, r]); }
function smin(a, b, k) { const h = clamp(0.5 + 0.5 * (b - a) / k, 0, 1); return (b + (a - b) * h) - k * h * (1 - h); }
const opSub = (a, b) => Math.max(a, -b);
function rotX(p, a) { const c = Math.cos(a), s = Math.sin(a); return [p[0], c * p[1] - s * p[2], s * p[1] + c * p[2]]; }
function sdPolygon(px, py, v) {
  const N = v.length; let d = (px - v[0][0]) ** 2 + (py - v[0][1]) ** 2; let s = 1;
  for (let i = 0, j = N - 1; i < N; j = i, i++) {
    const ex = v[j][0] - v[i][0], ey = v[j][1] - v[i][1], wx = px - v[i][0], wy = py - v[i][1];
    const t = clamp((wx * ex + wy * ey) / (ex * ex + ey * ey), 0, 1);
    const bx = wx - ex * t, by = wy - ey * t; d = Math.min(d, bx * bx + by * by);
    const c1 = py >= v[i][1], c2 = py < v[j][1], c3 = ex * wy > ey * wx;
    if ((c1 && c2 && c3) || (!c1 && !c2 && !c3)) s = -s;
  }
  return s * Math.sqrt(d);
}
const KNIGHT_PTS = [[0.126,0.200],[0.151,0.251],[0.164,0.310],[0.159,0.385],[0.121,0.451],[0.057,0.510],[0.178,0.507],[0.194,0.575],[-0.015,0.672],[-0.018,0.730],[-0.180,0.592],[-0.126,0.201]];
function base(p, R) {
  let d = sdCylinder(sub(p, [0, 0.03, 0]), 0.03, R);
  d = smin(d, sdTorus(sub(p, [0, 0.05, 0]), R - 0.022, 0.022), 0.02);
  d = smin(d, sdCylinder(sub(p, [0, 0.105, 0]), 0.03, R * 0.80), 0.04);
  d = smin(d, sdCone(sub(p, [0, 0.175, 0]), 0.05, R * 0.66, R * 0.40), 0.05);
  return d;
}
function sdPawn(p) { let d = base(p, 0.155); d = smin(d, sdCone(sub(p, [0, 0.30, 0]), 0.095, 0.066, 0.05), 0.04); d = smin(d, sdTorus(sub(p, [0, 0.375, 0]), 0.058, 0.014), 0.02); d = smin(d, sdHead(p, [0, 0.455, 0], 0.10), 0.022); return d; }
function sdRook(p) {
  let d = base(p, 0.185);
  d = smin(d, sdCone(sub(p, [0, 0.35, 0]), 0.15, 0.135, 0.115), 0.04);
  d = smin(d, sdTorus(sub(p, [0, 0.50, 0]), 0.115, 0.015), 0.02);
  d = smin(d, sdCone(sub(p, [0, 0.535, 0]), 0.03, 0.12, 0.165), 0.02);
  d = smin(d, sdCylinder(sub(p, [0, 0.58, 0]), 0.055, 0.165), 0.02);
  const sc = sub(p, [0, 0.66, 0]);
  d = opSub(d, sdBox(sub(sc, [0.075, 0, 0]), [0.04, 0.08, 0.5]));
  d = opSub(d, sdBox(sub(sc, [-0.075, 0, 0]), [0.04, 0.08, 0.5]));
  d = opSub(d, sdBox(sub(sc, [0, 0, 0.075]), [0.5, 0.08, 0.04]));
  d = opSub(d, sdBox(sub(sc, [0, 0, -0.075]), [0.5, 0.08, 0.04]));
  return d;
}
function sdBishop(p) {
  let d = base(p, 0.205);
  d = smin(d, sdCone(sub(p, [0, 0.40, 0]), 0.22, 0.066, 0.044), 0.04);
  d = smin(d, sdTorus(sub(p, [0, 0.56, 0]), 0.06, 0.014), 0.02);
  d = smin(d, sdEllipsoid(sub(p, [0, 0.675, 0]), [0.08, 0.135, 0.08]), 0.03);
  d = smin(d, sdHead(p, [0, 0.82, 0], 0.022), 0.015);
  d = opSub(d, sdBox(rotX(sub(p, [0.09, 0.71, 0.02]), 0.7), [0.12, 0.015, 0.10]));
  return d;
}
function sdKnight(p) {
  let d = base(p, 0.185);
  d = smin(d, sdCylinder(sub(p, [0, 0.205, 0]), 0.055, 0.12), 0.06);
  d = smin(d, sdTorus(sub(p, [0, 0.265, 0]), 0.12, 0.015), 0.02);
  const prof = sdPolygon(-p[2], p[1], KNIGHT_PTS);
  const sx = clamp((p[1] - 0.27) / 0.23, 0, 1), ss = sx * sx * (3 - 2 * sx);
  const t = 0.115 + (0.05 - 0.115) * ss, wx = Math.abs(p[0]) - t;
  const head = Math.min(Math.max(prof, wx), 0) + len(Math.max(prof, 0), Math.max(wx, 0)) - 0.02;
  d = smin(d, head, 0.03);
  return d;
}
function sdCrown(p, ringR, y, bump) {
  const ang = Math.atan2(p[2], p[0]), rep = (2 * Math.PI) / 8, cell = Math.floor(ang / rep);
  let d = 1e9;
  for (let k = -1; k <= 1; k++) { const a2 = (cell + k + 0.5) * rep; d = Math.min(d, sdSphere(sub(p, [Math.cos(a2) * ringR, y, Math.sin(a2) * ringR]), bump)); }
  return d;
}
function sdQueen(p) {
  let d = base(p, 0.225);
  d = smin(d, sdCone(sub(p, [0, 0.46, 0]), 0.27, 0.076, 0.048), 0.04);
  d = smin(d, sdTorus(sub(p, [0, 0.74, 0]), 0.068, 0.015), 0.02);
  d = smin(d, sdCone(sub(p, [0, 0.81, 0]), 0.05, 0.07, 0.115), 0.03);
  d = smin(d, sdCrown(p, 0.11, 0.90, 0.032), 0.02);
  d = smin(d, sdHead(p, [0, 0.86, 0], 0.038), 0.025);
  return d;
}
function sdKing(p) {
  let d = base(p, 0.255);
  d = smin(d, sdCone(sub(p, [0, 0.48, 0]), 0.30, 0.08, 0.052), 0.04);
  d = smin(d, sdTorus(sub(p, [0, 0.78, 0]), 0.072, 0.015), 0.02);
  d = smin(d, sdCone(sub(p, [0, 0.85, 0]), 0.05, 0.072, 0.115), 0.03);
  d = smin(d, sdHead(p, [0, 0.93, 0], 0.06), 0.03);
  const cc = sub(p, [0, 1.03, 0]);
  d = Math.min(d, sdBox(cc, [0.016, 0.058, 0.016]));
  d = Math.min(d, sdBox(sub(cc, [0, 0.018, 0]), [0.042, 0.016, 0.016]));
  return d;
}
function sdPiece(p, t) {
  if (t < 1.5) return sdPawn(p); if (t < 2.5) return sdKnight(p); if (t < 3.5) return sdBishop(p);
  if (t < 4.5) return sdRook(p); if (t < 5.5) return sdQueen(p); return sdKing(p);
}

// ---- scene field (mirror sdfScene): static 3x3 grid + overlay --------------
const OFF = [[0,0],[-1,-1],[0,-1],[1,-1],[-1,0],[1,0],[-1,1],[0,1],[1,1]];
function sdfScene(p, board, overlay) {
  const fu = Math.floor(p[0] + 4), fw = Math.floor(p[2] + 4);
  let best = 1e30, bestCol = -1;
  for (const o of OFF) {
    const cx = fu + o[0], cz = fw + o[1];
    if (cx < 0 || cx > 7 || cz < 0 || cz > 7) continue;
    const center = [cx - 3.5, 0, cz - 3.5];
    const qx = Math.abs(p[0] - center[0]) - 0.35, qy = Math.abs(p[1] - 0.6) - 0.65, qz = Math.abs(p[2] - center[2]) - 0.35;
    if (0.9 * len(Math.max(qx, 0), Math.max(qy, 0), Math.max(qz, 0)) > best) continue;
    const v = board[cz * 8 + cx];
    if (v < 0.5) continue;
    const isBlack = v > 9.5, t = v - (isBlack ? 10 : 0);
    let lp = sub(p, center); if (isBlack) lp = [-lp[0], lp[1], -lp[2]];
    const d = sdPiece(lp, t) * 0.9;
    if (d < best) { best = d; bestCol = isBlack ? 1 : 0; }
  }
  for (const ov of overlay) {
    const s = ov.scale; if (s < 0.03) continue;
    const pos = ov.pos;
    const qx = Math.abs(p[0] - pos[0]) - 0.4 * s, qy = Math.abs(p[1] - (pos[1] + 0.6 * s)) - 0.72 * s, qz = Math.abs(p[2] - pos[2]) - 0.4 * s;
    if (0.9 * len(Math.max(qx, 0), Math.max(qy, 0), Math.max(qz, 0)) > best) continue;
    const v = ov.code, isBlack = v > 9.5, t = v - (isBlack ? 10 : 0);
    let lp = sub(p, pos); if (isBlack) lp = [-lp[0], lp[1], -lp[2]];
    const d = sdPiece([lp[0] / s, lp[1] / s, lp[2] / s], t) * 0.9 * s;
    if (d < best) { best = d; bestCol = isBlack ? 1 : 0; }
  }
  if (best > 1e29) return { d: 1, col: -1 };
  return { d: best, col: bestCol };
}
function marchPieces(ro, rd, maxT, board, overlay) {
  const bmin = [-4.05, -0.05, -4.05], bmax = [4.05, 1.15 + 0.1, 4.05];
  const inv = [1 / rd[0], 1 / rd[1], 1 / rd[2]];
  const t1 = [(bmin[0]-ro[0])*inv[0],(bmin[1]-ro[1])*inv[1],(bmin[2]-ro[2])*inv[2]];
  const t2 = [(bmax[0]-ro[0])*inv[0],(bmax[1]-ro[1])*inv[1],(bmax[2]-ro[2])*inv[2]];
  const tn = Math.max(Math.min(t1[0],t2[0]), Math.min(t1[1],t2[1]), Math.min(t1[2],t2[2]));
  const tf = Math.min(Math.max(t1[0],t2[0]), Math.max(t1[1],t2[1]), Math.max(t1[2],t2[2]));
  if (tf < Math.max(tn, 0)) return null;
  let t = Math.max(tn, 0.02); const bound = Math.min(maxT, tf);
  if (t >= bound) return null;
  for (let i = 0; i < 96; i++) {
    const f = sdfScene([ro[0]+rd[0]*t, ro[1]+rd[1]*t, ro[2]+rd[2]*t], board, overlay);
    const eps = Math.max(0.0009, 0.0014 * t);
    if (Math.abs(f.d) < eps && f.col >= 0) return { t, col: f.col };
    t += Math.max(Math.abs(f.d), 0.0008);
    if (t >= bound) break;
  }
  return null;
}

// ---- camera + render --------------------------------------------------------
function norm(v) { const l = len(v[0], v[1], v[2]) || 1; return [v[0]/l, v[1]/l, v[2]/l]; }
const cross = (a, b) => [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
function camera(az, el, dist, tgt = [0, 0.45, 0]) {
  const ce = Math.cos(el), se = Math.sin(el), ca = Math.cos(az), sa = Math.sin(az);
  const pos = [tgt[0]+dist*ce*sa, tgt[1]+dist*se, tgt[2]+dist*ce*ca];
  const fwd = norm(sub(tgt, pos)), right = norm(cross(fwd, [0,1,0])), up = cross(right, fwd);
  return { pos, fwd, right, up };
}
function render(board, overlay, W, H, az, el, dist, tgt = [0, 0.45, 0]) {
  const cam = camera(az, el, dist, tgt), fovScale = Math.tan((45 * Math.PI / 180) / 2), aspect = W / H;
  const buf = Buffer.alloc(W * H * 4);
  for (let py = 0; py < H; py++) for (let px = 0; px < W; px++) {
    const ndcx = (px + 0.5) / W * 2 - 1, ndcy = 1 - (py + 0.5) / H * 2;
    const dir = norm([
      cam.fwd[0] + cam.right[0]*ndcx*fovScale*aspect + cam.up[0]*ndcy*fovScale,
      cam.fwd[1] + cam.right[1]*ndcx*fovScale*aspect + cam.up[1]*ndcy*fovScale,
      cam.fwd[2] + cam.right[2]*ndcx*fovScale*aspect + cam.up[2]*ndcy*fovScale,
    ]);
    let boardT = 1e30, hitBoard = false;
    if (Math.abs(dir[1]) > 1e-5) { const tb = -cam.pos[1] / dir[1]; if (tb > 0.001) { boardT = tb; hitBoard = true; } }
    const far = hitBoard ? boardT : 60;
    const pm = marchPieces(cam.pos, dir, far, board, overlay);
    let c;
    if (pm && pm.t < boardT) c = [0, 200, 0];      // piece = green
    else if (hitBoard) c = [0, 50, 190];           // board = blue
    else c = [150, 0, 0];                          // sky = red
    const i = (py * W + px) * 4; buf[i] = c[0]; buf[i+1] = c[1]; buf[i+2] = c[2]; buf[i+3] = 255;
  }
  return buf;
}
function encodePNG(W, H, buf) {
  const raw = Buffer.alloc(H * (1 + W * 4));
  for (let y = 0; y < H; y++) { raw[y*(1+W*4)] = 0; buf.copy(raw, y*(1+W*4)+1, y*W*4, (y+1)*W*4); }
  const idat = deflateSync(raw);
  const chunk = (type, data) => {
    const b = Buffer.concat([Buffer.from(type), data]); const len4 = Buffer.alloc(4); len4.writeUInt32BE(data.length);
    let c = 0xFFFFFFFF; for (let i = 0; i < b.length; i++) { c ^= b[i]; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); }
    const crc = Buffer.alloc(4); crc.writeUInt32BE((c ^ 0xFFFFFFFF) >>> 0);
    return Buffer.concat([len4, b, crc]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89,0x50,0x4E,0x47,0x0D,0x0A,0x1A,0x0A]), chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
}

// ---- engine state (mirror src/chess-main.js computeOutputs, geometry only) --
import { OPERA_GAME, sqIdx, cellWorld } from "../src/chess-game.js";
const BACK = [4, 2, 3, 5, 6, 3, 2, 4];
function startPosition() {
  const b = new Float32Array(64);
  for (let f = 0; f < 8; f++) { b[0*8+f] = BACK[f]; b[1*8+f] = 1; b[6*8+f] = 1 + 10; b[7*8+f] = BACK[f] + 10; }
  return b;
}
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const ease = (x) => { x = clamp01(x); return x * x * (3 - 2 * x); };
const lerp = (a, b, t) => a + (b - a) * t;
const isKnight = (v) => (v > 10 ? v - 10 : v) === 2;
const PACE = { glow: 0.20, glide: 0.62 };
function applyPlyTo(b, ply) {
  if (ply.castle) { const kf=sqIdx(ply.castle.king[0]),kt=sqIdx(ply.castle.king[1]),rf=sqIdx(ply.castle.rook[0]),rt=sqIdx(ply.castle.rook[1]); b[kt]=b[kf];b[kf]=0;b[rt]=b[rf];b[rf]=0; }
  else { const f=sqIdx(ply.from),t=sqIdx(ply.to); b[t]=b[f];b[f]=0; }
}
function boardAtPly(n) { const b = startPosition(); for (let i = 0; i < n; i++) applyPlyTo(b, OPERA_GAME.plies[i]); return b; }
function findKing(board, whiteMoved) { const tgt = whiteMoved ? 16 : 6; for (let i = 0; i < 64; i++) if (board[i] === tgt) return i; return -1; }

// Produce the {staticData, overlay} the engine would upload for ply p at clock c.
function simulate(p, c) {
  const board = boardAtPly(p), ply = OPERA_GAME.plies[p];
  const a = { movers: [], captured: null, check: !!ply.check, kingIdx: -1 };
  if (ply.castle) {
    const kf=sqIdx(ply.castle.king[0]),kt=sqIdx(ply.castle.king[1]),rf=sqIdx(ply.castle.rook[0]),rt=sqIdx(ply.castle.rook[1]);
    a.movers.push({ val: board[kf], from: kf, to: kt, jump: false, delay: 0 });
    a.movers.push({ val: board[rf], from: rf, to: rt, jump: false, delay: 0.10 });
  } else {
    const from = sqIdx(ply.from), to = sqIdx(ply.to), val = board[from];
    a.movers.push({ val, from, to, jump: isKnight(val), delay: 0 });
    if (board[to] > 0.5) a.captured = { val: board[to], idx: to };
  }
  if (a.check) a.kingIdx = findKing(board, p % 2 === 0);

  const stat = board.slice();
  const inGlow = c < PACE.glow, glideT = clamp01((c - PACE.glow) / PACE.glide);
  const inSettle = c >= PACE.glow + PACE.glide, sEase = ease(glideT);
  const overlay = [];
  for (const m of a.movers) {
    stat[m.from] = 0; stat[m.to] = 0;
    const wf = cellWorld(m.from), wt = cellWorld(m.to);
    let s = m.delay ? ease(clamp01((c - PACE.glow - m.delay) / PACE.glide)) : sEase;
    let x = wf[0], y = 0, z = wf[2];
    if (!inGlow) { x = lerp(wf[0], wt[0], s); z = lerp(wf[2], wt[2], s); }
    if (inSettle) { x = wt[0]; z = wt[2]; }
    if (m.jump && !inGlow && !inSettle) y = 0.34 * 4 * s * (1 - s);
    overlay.push({ pos: [x, y, z], code: m.val, scale: 1 });
  }
  if (a.captured) {
    stat[a.captured.idx] = 0; const w = cellWorld(a.captured.idx);
    let scale = 1; if (!inGlow) scale = 1 - clamp01((c - PACE.glow) / (PACE.glide * 0.45));
    if (scale > 0.03) overlay.push({ pos: [w[0], 0, w[2]], code: a.captured.val, scale });
  }
  if (a.check && a.kingIdx >= 0 && !inGlow) {
    stat[a.kingIdx] = 0; const w = cellWorld(a.kingIdx);
    overlay.push({ pos: [w[0], 0, w[2]], code: board[a.kingIdx], scale: 1 });
  }
  return { stat, overlay };
}

const W = 360, H = 240, AZ = 0.7, EL = 0.55, DIST = 11;
// Low-angle views (matching the user's screenshot) -- static start position.
writeFileSync(new URL("../debug-low.png", import.meta.url), encodePNG(W, H, render(startPosition(), [], W, H, 0.7, 0.22, 8)));
writeFileSync(new URL("../debug-low2.png", import.meta.url), encodePNG(W, H, render(startPosition(), [], W, H, 0.4, 0.30, 7)));
writeFileSync(new URL("../debug-static.png", import.meta.url), encodePNG(W, H, render(startPosition(), [], W, H, AZ, EL, DIST)));
// Render several real plies mid-glide and look for dropped pieces (blue where green should be).
const FRAMES = [
  ["p0-glow",   0, 0.10],                      // e4, glow phase (mover sits at source)
  ["p0-settle", 0, PACE.glow + PACE.glide + 0.2], // e4, settle phase (mover at dest)
  ["p5",  5, PACE.glow + PACE.glide * 0.5],   // Bg4 (long bishop glide)
  ["p6",  6, PACE.glow + PACE.glide * 0.5],   // dxe5 (capture)
];
for (const [tag, p, c] of FRAMES) {
  const { stat, overlay } = simulate(p, c);
  writeFileSync(new URL(`../debug-${tag}.png`, import.meta.url), encodePNG(W, H, render(stat, overlay, W, H, AZ, EL, DIST)));
}
console.log("wrote debug-static.png + debug-p0/p5/p6/p10.png");

// If a captured GPU state dump exists, render the SAME state on the CPU (f64)
// to compare against the GPU (f32) harness output.
import { readFileSync, existsSync } from "node:fs";
const dumpURL = new URL("./state-dump.json", import.meta.url);
if (existsSync(dumpURL)) {
  const d = JSON.parse(readFileSync(dumpURL, "utf8"));
  const board = new Float32Array(d.board);
  const overlay = [];
  for (let k = 0; k < d.count; k++) { const b = k * 8; overlay.push({ pos: [d.overlay[b], d.overlay[b+1], d.overlay[b+2]], code: d.overlay[b+3], scale: d.overlay[b+7] }); }
  writeFileSync(new URL("../debug-dump-cpu.png", import.meta.url), encodePNG(W, H, render(board, overlay, W, H, d.az, d.el, d.dist, d.tgt)));
  console.log("wrote debug-dump-cpu.png (CPU f64 replay of the dumped state)");
}
