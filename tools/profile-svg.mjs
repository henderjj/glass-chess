// Renders chess-piece SDF profiles to an SVG for geometry review.
// Ports the SDFs from shaders/chess.wgsl exactly (incl. the global PIECE_SCALE).
// Revolution pieces are sliced at Z=0; the knight at X=0 (its facing profile).
//
//   node tools/profile-svg.mjs   ->   writes profiles.svg in the project root.

import { writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

// ---- ported SDF helpers -----------------------------------------------------
const len = (...a) => Math.hypot(...a);
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const sub = (p, o) => [p[0] - o[0], p[1] - o[1], p[2] - o[2]];

function sdSphere(p, r) { return len(p[0], p[1], p[2]) - r; }
function sdBox(p, b) {
  const qx = Math.abs(p[0]) - b[0], qy = Math.abs(p[1]) - b[1], qz = Math.abs(p[2]) - b[2];
  return len(Math.max(qx, 0), Math.max(qy, 0), Math.max(qz, 0)) + Math.min(Math.max(qx, Math.max(qy, qz)), 0);
}
const sdRoundBox = (p, b, r) => sdBox(p, b) - r;
function sdTorus(p, R, r) { return len(len(p[0], p[2]) - R, p[1]) - r; }
function sdCylinder(p, h, r) {
  const dx = len(p[0], p[2]) - r, dy = Math.abs(p[1]) - h;
  return Math.min(Math.max(dx, dy), 0) + len(Math.max(dx, 0), Math.max(dy, 0));
}
function sdCone(p, h, r1, r2) {
  const qx = len(p[0], p[2]), qy = p[1];
  const k1 = [r2, h], k2 = [r2 - r1, 2 * h];
  const cax = qx - Math.min(qx, qy < 0 ? r1 : r2);
  const cay = Math.abs(qy) - h;
  const cl = clamp(((k1[0] - qx) * k2[0] + (k1[1] - qy) * k2[1]) / (k2[0] * k2[0] + k2[1] * k2[1]), 0, 1);
  const cbx = qx - k1[0] + k2[0] * cl, cby = qy - k1[1] + k2[1] * cl;
  const s = (cbx < 0 && cay < 0) ? -1 : 1;
  return s * Math.sqrt(Math.min(cax * cax + cay * cay, cbx * cbx + cby * cby));
}
function sdEllipsoid(p, r) {
  // Conservative lower bound; same isosurface as the iq form (identical shape /
  // inside-outside sign) but never overestimates distance. Mirrors chess.wgsl.
  const k = len(p[0] / r[0], p[1] / r[1], p[2] / r[2]);
  return (k - 1) * Math.min(r[0], r[1], r[2]);
}
const SCALE = [1, 1, 1];
function sdHead(p, c, r) { return sdEllipsoid(sub(p, c), [r / SCALE[0], r / SCALE[1], r / SCALE[2]]); }
function smin(a, b, k) {
  const h = clamp(0.5 + 0.5 * (b - a) / k, 0, 1);
  return (b + (a - b) * h) - k * h * (1 - h);
}
const opSub = (a, b) => Math.max(a, -b);
function rotX(p, a) { const c = Math.cos(a), s = Math.sin(a); return [p[0], c * p[1] - s * p[2], s * p[1] + c * p[2]]; }

// Signed distance to a 2D polygon (IQ). v = array of [x,y]. Negative inside.
function sdPolygon(px, py, v) {
  const N = v.length;
  let d = (px - v[0][0]) ** 2 + (py - v[0][1]) ** 2;
  let s = 1.0;
  for (let i = 0, j = N - 1; i < N; j = i, i++) {
    const ex = v[j][0] - v[i][0], ey = v[j][1] - v[i][1];
    const wx = px - v[i][0], wy = py - v[i][1];
    const t = clamp((wx * ex + wy * ey) / (ex * ex + ey * ey), 0, 1);
    const bx = wx - ex * t, by = wy - ey * t;
    d = Math.min(d, bx * bx + by * by);
    const c1 = py >= v[i][1], c2 = py < v[j][1], c3 = ex * wy > ey * wx;
    if ((c1 && c2 && c3) || (!c1 && !c2 && !c3)) s = -s;
  }
  return s * Math.sqrt(d);
}
// Knight head outline in (z,y), nose facing -z (left, matching the reference).
// Traced in the editor, then uniformly scaled (~0.665x), centred on the neck
// axis, and seated so the head bottom sits at ~y0.20 (on the base/collar).
const KNIGHT_PTS = [
  [0.126, 0.200],
  [0.151, 0.251],
  [0.164, 0.310],
  [0.159, 0.385],
  [0.121, 0.451],
  [0.057, 0.510],
  [0.178, 0.507],
  [0.194, 0.575],
  [-0.015, 0.672],
  [-0.018, 0.730],
  [-0.180, 0.592],
  [-0.126, 0.201],
];

// ---- ported pieces ----------------------------------------------------------
function base(p, R) {
  let d = sdCylinder(sub(p, [0, 0.03, 0]), 0.03, R);                    // wide flat foot
  d = smin(d, sdTorus(sub(p, [0, 0.05, 0]), R - 0.022, 0.022), 0.02);   // rounded foot edge
  d = smin(d, sdCylinder(sub(p, [0, 0.105, 0]), 0.03, R * 0.80), 0.04); // second tier
  d = smin(d, sdCone(sub(p, [0, 0.175, 0]), 0.05, R * 0.66, R * 0.40), 0.05); // cove to stem
  return d;
}
function sdPawn(p) {
  let d = base(p, 0.155);
  d = smin(d, sdCone(sub(p, [0, 0.30, 0]), 0.095, 0.066, 0.05), 0.04);  // slim stem
  d = smin(d, sdTorus(sub(p, [0, 0.375, 0]), 0.058, 0.014), 0.02);      // collar
  d = smin(d, sdHead(p, [0, 0.455, 0], 0.10), 0.022);                   // ball head
  return d;
}
function sdRook(p) {
  let d = base(p, 0.185);
  d = smin(d, sdCone(sub(p, [0, 0.35, 0]), 0.15, 0.135, 0.115), 0.04);  // body
  d = smin(d, sdTorus(sub(p, [0, 0.50, 0]), 0.115, 0.015), 0.02);       // collar bead
  d = smin(d, sdCone(sub(p, [0, 0.535, 0]), 0.03, 0.12, 0.165), 0.02);  // flare to battlement
  d = smin(d, sdCylinder(sub(p, [0, 0.58, 0]), 0.055, 0.165), 0.02);    // battlement band
  // crenellations: 4 OFF-CENTRE slots -> 3x3 merlon grid, so teeth read in profile
  const sc = sub(p, [0, 0.66, 0]);
  d = opSub(d, sdBox(sub(sc, [0.075, 0, 0]), [0.04, 0.08, 0.5]));
  d = opSub(d, sdBox(sub(sc, [-0.075, 0, 0]), [0.04, 0.08, 0.5]));
  d = opSub(d, sdBox(sub(sc, [0, 0, 0.075]), [0.5, 0.08, 0.04]));
  d = opSub(d, sdBox(sub(sc, [0, 0, -0.075]), [0.5, 0.08, 0.04]));
  return d;
}
function sdBishop(p) {
  let d = base(p, 0.205);
  d = smin(d, sdCone(sub(p, [0, 0.40, 0]), 0.22, 0.066, 0.044), 0.04);  // tall slim stem
  d = smin(d, sdTorus(sub(p, [0, 0.56, 0]), 0.06, 0.014), 0.02);        // collar
  d = smin(d, sdEllipsoid(sub(p, [0, 0.675, 0]), [0.08, 0.135, 0.08]), 0.03); // egg mitre
  d = smin(d, sdHead(p, [0, 0.82, 0], 0.022), 0.015);                   // finial
  d = opSub(d, sdBox(rotX(sub(p, [0.09, 0.71, 0.02]), 0.7), [0.12, 0.015, 0.10])); // slit
  return d;
}
function sdKnight(p) {
  let d = base(p, 0.185);
  // collar fills the base waist & is a touch wider than the neck, so the neck
  // emerges cleanly (no pinch, no overhang above the collar)
  d = smin(d, sdCylinder(sub(p, [0, 0.205, 0]), 0.055, 0.12), 0.06);
  d = smin(d, sdTorus(sub(p, [0, 0.265, 0]), 0.12, 0.015), 0.02);    // collar bead
  // head: traced 2D profile extruded into a slab whose thickness tapers from a
  // round neck (matching the collar) up to a flat head -> no protruding disc.
  const prof = sdPolygon(p[2], p[1], KNIGHT_PTS);
  const sx = clamp((p[1] - 0.27) / 0.23, 0, 1), ss = sx * sx * (3 - 2 * sx);
  const t = 0.115 + (0.05 - 0.115) * ss, r = 0.02;
  const wx = Math.abs(p[0]) - t;
  const head = Math.min(Math.max(prof, wx), 0) + Math.hypot(Math.max(prof, 0), Math.max(wx, 0)) - r;
  d = smin(d, head, 0.03);
  return d;
}
function sdCrown(p, ringR, y, bump) {
  const ang = Math.atan2(p[2], p[0]);
  const rep = (2 * Math.PI) / 8;
  const a2 = (Math.floor(ang / rep) + 0.5) * rep;
  const c = [Math.cos(a2) * ringR, y, Math.sin(a2) * ringR];
  return sdSphere(sub(p, c), bump);
}
function sdQueen(p) {
  let d = base(p, 0.225);
  d = smin(d, sdCone(sub(p, [0, 0.46, 0]), 0.27, 0.076, 0.048), 0.04); // tall slim stem
  d = smin(d, sdTorus(sub(p, [0, 0.74, 0]), 0.068, 0.015), 0.02);      // collar
  d = smin(d, sdCone(sub(p, [0, 0.81, 0]), 0.05, 0.07, 0.115), 0.03);  // crown band (flare)
  d = smin(d, sdCrown(p, 0.11, 0.90, 0.032), 0.02);                    // coronet points
  d = smin(d, sdHead(p, [0, 0.86, 0], 0.038), 0.025);                  // centre ball
  return d;
}
function sdKing(p) {
  let d = base(p, 0.255);
  d = smin(d, sdCone(sub(p, [0, 0.48, 0]), 0.30, 0.08, 0.052), 0.04);  // tallest slim stem
  d = smin(d, sdTorus(sub(p, [0, 0.78, 0]), 0.072, 0.015), 0.02);      // collar
  d = smin(d, sdCone(sub(p, [0, 0.85, 0]), 0.05, 0.072, 0.115), 0.03); // crown band
  d = smin(d, sdHead(p, [0, 0.93, 0], 0.06), 0.03);                    // crown top
  const cc = sub(p, [0, 1.03, 0]);
  d = Math.min(d, sdBox(cc, [0.016, 0.058, 0.016]));
  d = Math.min(d, sdBox(sub(cc, [0, 0.018, 0]), [0.042, 0.016, 0.016]));
  return d;
}

const PIECES = [
  { name: "Pawn", fn: sdPawn, axis: "x" },
  { name: "Knight", fn: sdKnight, axis: "z" }, // sliced at X=0 to show the facing profile
  { name: "Bishop", fn: sdBishop, axis: "x" },
  { name: "Rook", fn: sdRook, axis: "x" },
  { name: "Queen", fn: sdQueen, axis: "x" },
  { name: "King", fn: sdKing, axis: "x" },
];

// world point -> SDF (apply inverse PIECE_SCALE to get model coords)
function evalWorld(piece, hWorld, yWorld) {
  const w = piece.axis === "x" ? [hWorld, yWorld, 0] : [0, yWorld, hWorld];
  const m = [w[0] / SCALE[0], w[1] / SCALE[1], w[2] / SCALE[2]];
  return piece.fn(m);
}

// ---- sampling + SVG ---------------------------------------------------------
const S = 175;              // pixels per world unit
const HMIN = -0.46, HMAX = 0.46, YMIN = 0, YMAX = 1.32;
const STEPH = 0.0035, STEPY = 0.0045;
const padX = 26, panelGap = 18, topPad = 30, labelH = 26;
const contentW = (HMAX - HMIN) * S;
const contentH = (YMAX - YMIN) * S;
const panelW = contentW + 2 * padX;
const panelH = contentH;
const totalW = PIECES.length * panelW + (PIECES.length - 1) * panelGap + 20;
const totalH = topPad + panelH + labelH + 20;

const heights = {};
function panelSVG(piece, ox) {
  const oy = topPad;
  const baseY = oy + (YMAX - 0) * S;
  const cx = ox + padX + (0 - HMIN) * S; // piece axis (h=0)
  let rects = "";
  let maxY = 0;
  for (let y = YMIN; y <= YMAX; y += STEPY) {
    let prev = false, start = 0;
    const spans = [];
    for (let hh = HMIN; hh <= HMAX; hh += STEPH) {
      const inside = evalWorld(piece, hh, y) < 0;
      if (inside && !prev) start = hh;
      if (!inside && prev) spans.push([start, hh]);
      prev = inside;
    }
    if (prev) spans.push([start, HMAX]);
    if (spans.length) maxY = y;
    for (const [a, b] of spans) {
      const x = ox + padX + (a - HMIN) * S;
      const w = (b - a) * S;
      const ry = oy + (YMAX - y - STEPY) * S;
      rects += `<rect x="${x.toFixed(2)}" y="${ry.toFixed(2)}" width="${w.toFixed(2)}" height="${(STEPY * S + 0.8).toFixed(2)}"/>`;
    }
  }
  heights[piece.name] = maxY;
  // panel frame, center axis, baseline, label
  return `
  <g>
    <rect class="bg" x="${ox}" y="${oy}" width="${panelW}" height="${panelH}"/>
    <line class="axis" x1="${cx}" y1="${oy}" x2="${cx}" y2="${baseY}"/>
    <g class="fill">${rects}</g>
    <line class="base" x1="${ox}" y1="${baseY}" x2="${ox + panelW}" y2="${baseY}"/>
    <text class="lab" x="${ox + panelW / 2}" y="${oy + panelH + 18}">${piece.name}</text>
  </g>`;
}

let body = "";
PIECES.forEach((p, i) => { body += panelSVG(p, 10 + i * (panelW + panelGap)); });

// Accurate piece heights via a 3D envelope (the Z=0 slice misses off-axis
// features like the rook's corner merlons).
function insideAnywhere(piece, y) {
  if (piece.axis === "z") { // knight slab: scan x,z
    for (let x = -0.12; x <= 0.12; x += 0.03)
      for (let z = -0.46; z <= 0.46; z += 0.02) {
        const m = [x / SCALE[0], y / SCALE[1], z / SCALE[2]];
        if (piece.fn(m) < 0) return true;
      }
    return false;
  }
  for (let r = 0; r <= 0.46; r += 0.02)        // revolution: scan radius + angle
    for (let a = 0; a < 6.2832; a += Math.PI / 8) {
      const m = [r * Math.cos(a) / SCALE[0], y / SCALE[1], r * Math.sin(a) / SCALE[2]];
      if (piece.fn(m) < 0) return true;
    }
  return false;
}
for (const p of PIECES) {
  let top = 0;
  for (let y = YMIN; y <= YMAX; y += STEPY) if (insideAnywhere(p, y)) top = y;
  heights[p.name] = top;
}

// base width (widest point) and head/top width (widest in the top 28%), from the
// Z=0 slice - for ratio checking against the reference.
const widths = {};
for (const p of PIECES) {
  let baseW = 0, topW = 0;
  const top = heights[p.name];
  for (let y = YMIN; y <= YMAX; y += STEPY) {
    let lo = 1e9, hi = -1e9;
    for (let h = HMIN; h <= HMAX; h += STEPH) if (evalWorld(p, h, y) < 0) { if (h < lo) lo = h; if (h > hi) hi = h; }
    if (hi > lo) { const w = hi - lo; if (w > baseW) baseW = w; if (y > top * 0.72 && w > topW) topW = w; }
  }
  widths[p.name] = [baseW, topW];
}

// dashed reference line at the rook's height across all panels
const rookY = heights["Rook"];
const refY = topPad + (YMAX - rookY) * S;
const ref = `<line class="ref" x1="0" y1="${refY.toFixed(2)}" x2="${totalW}" y2="${refY.toFixed(2)}"/>
  <text class="reftext" x="6" y="${(refY - 5).toFixed(2)}">rook height (${rookY.toFixed(2)})</text>`;

const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${totalW}" height="${totalH}" viewBox="0 0 ${totalW} ${totalH}">
  <style>
    svg { background:#0c0f16; }
    .bg { fill:#161b27; stroke:#2a3346; }
    .fill rect { fill:#d9a441; }
    .axis { stroke:#33405a; stroke-width:1; stroke-dasharray:3 4; }
    .base { stroke:#566677; stroke-width:1.2; }
    .ref { stroke:#e06666; stroke-width:1; stroke-dasharray:6 5; opacity:0.8; }
    .reftext { fill:#e06666; font:12px monospace; }
    .lab { fill:#cfd6e4; font:14px monospace; text-anchor:middle; }
  </style>
  ${body}
  ${ref}
</svg>`;

writeFileSync(new URL("../profiles.svg", import.meta.url), svg);

// ---- also rasterize to PNG (so the result can be viewed directly) -----------
function renderPNG() {
  const W = Math.round(totalW), H = Math.round(totalH);
  const buf = Buffer.alloc(W * H * 4);
  const setpx = (x, y, c) => {
    if (x < 0 || x >= W || y < 0 || y >= H) return;
    const i = (y * W + x) * 4;
    buf[i] = c[0]; buf[i + 1] = c[1]; buf[i + 2] = c[2]; buf[i + 3] = 255;
  };
  const fillRect = (x0, y0, w, h, c) => {
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) setpx(x, y, c);
  };
  fillRect(0, 0, W, H, [12, 15, 22]);                       // background
  const refY = Math.round(topPad + (YMAX - heights["Rook"]) * S);
  PIECES.forEach((p, i) => {
    const ox = Math.round(10 + i * (panelW + panelGap)), oy = topPad;
    fillRect(ox, oy, Math.round(panelW), Math.round(panelH), [22, 27, 39]);
    for (let py = oy; py < oy + panelH; py++) {
      const y = YMAX - (py - oy) / S;
      for (let px = Math.round(ox + padX - 4); px < ox + padX + contentW + 4; px++) {
        const hh = (px - (ox + padX)) / S + HMIN;
        if (hh < HMIN || hh > HMAX || y < YMIN || y > YMAX) continue;
        if (evalWorld(p, hh, y) < 0) setpx(px, py, [217, 164, 65]);
      }
    }
    const baseY = Math.round(oy + (YMAX - 0) * S);
    for (let x = ox; x < ox + panelW; x++) setpx(x, baseY, [86, 102, 119]);
  });
  for (let x = 0; x < W; x++) { setpx(x, refY, [224, 102, 102]); }

  // minimal PNG encoder
  const crcTable = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c >>> 0; }
    return t;
  })();
  const crc32 = (b) => { let c = 0xFFFFFFFF; for (let i = 0; i < b.length; i++) c = crcTable[(c ^ b[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
    const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td), 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc(H * (1 + W * 4));
  for (let y = 0; y < H; y++) { raw[y * (1 + W * 4)] = 0; buf.copy(raw, y * (1 + W * 4) + 1, y * W * 4, (y + 1) * W * 4); }
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0)),
  ]);
  writeFileSync(new URL("../profiles.png", import.meta.url), png);
}
function encodePNG(W, H, buf) {
  const crcTable = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c >>> 0; } return t; })();
  const crc32 = (b) => { let c = 0xFFFFFFFF; for (let i = 0; i < b.length; i++) c = crcTable[(c ^ b[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0); const td = Buffer.concat([Buffer.from(type, "ascii"), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td), 0); return Buffer.concat([len, td, crc]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc(H * (1 + W * 4));
  for (let y = 0; y < H; y++) { raw[y * (1 + W * 4)] = 0; buf.copy(raw, y * (1 + W * 4) + 1, y * W * 4, (y + 1) * W * 4); }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
// Two large knight views: left = Z-Y profile (looking along X), right = X-Y
// cross-section at z=0 (looking along Z) - the latter reveals disc protrusions.
function renderKnightZoom() {
  const W = 780, H = 580, buf = Buffer.alloc(W * H * 4);
  for (let i = 0; i < W * H; i++) { buf[i * 4] = 12; buf[i * 4 + 1] = 15; buf[i * 4 + 2] = 22; buf[i * 4 + 3] = 255; }
  const S2 = 540, BY = 520;
  const kn = PIECES.find(p => p.name === "Knight");
  function panel(OX, mode) {
    for (let py = 0; py < H; py++) {
      const y = (BY - py) / S2;
      if (y < -0.02 || y > 0.95) continue;
      for (let px = 0; px < W; px++) {
        const h = (px - OX) / S2;
        if (Math.abs(h) > 0.42) continue;
        const inside = mode === "zy" ? kn.fn([0, y, h]) < 0 : kn.fn([h, y, 0]) < 0;
        if (inside) { const i = (py * W + px) * 4; buf[i] = 217; buf[i + 1] = 164; buf[i + 2] = 65; buf[i + 3] = 255; }
      }
    }
    const pyb = Math.round(BY); for (let x = Math.max(0, OX - 170); x < Math.min(W, OX + 170); x++) { const i = (pyb * W + x) * 4; buf[i] = 86; buf[i + 1] = 102; buf[i + 2] = 119; buf[i + 3] = 255; }
  }
  panel(195, "zy");   // profile
  panel(585, "xy");   // cross-section (disc check)
  writeFileSync(new URL("../knight-zoom.png", import.meta.url), encodePNG(W, H, buf));
}
renderPNG();
renderKnightZoom();
console.log("wrote profiles.svg + profiles.png + knight-zoom.png");
const kingH = heights["King"];
console.log("piece    height  (vsKing)  baseW   headW");
for (const p of PIECES) {
  const h = heights[p.name], [bw, tw] = widths[p.name];
  console.log(`  ${p.name.padEnd(7)} ${h.toFixed(3)}  ${(h / kingH).toFixed(2)}    ${bw.toFixed(3)}  ${tw.toFixed(3)}`);
}
