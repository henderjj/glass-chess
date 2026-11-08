// Headless WebGPU harness (Deno): runs the REAL shaders/chess.wgsl on the GPU
// with a chosen board/overlay/camera/debug state and writes PNGs, so the actual
// GPU rendering (incl. f32 behaviour) can be inspected without a browser.
//   deno run -A --unstable-webgpu tools/wgpu-harness.mjs
import { deflateSync } from "node:zlib";
import { OPERA_GAME, sqIdx, cellWorld } from "../src/chess-game.js";

// ---- engine state (geometry only; mirrors src/chess-main.js computeOutputs) --
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
// ---- camera (mirrors cameraBasis) -------------------------------------------
const len = (...a) => Math.hypot(...a);
const norm = (v) => { const l = len(v[0],v[1],v[2]) || 1; return [v[0]/l, v[1]/l, v[2]/l]; };
const cross = (a, b) => [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
function camera(az, el, dist, tgt = [0, 0.45, 0]) {
  const ce = Math.cos(el), se = Math.sin(el), ca = Math.cos(az), sa = Math.sin(az);
  const pos = [tgt[0]+dist*ce*sa, tgt[1]+dist*se, tgt[2]+dist*ce*ca];
  const fwd = norm([tgt[0]-pos[0], tgt[1]-pos[1], tgt[2]-pos[2]]);
  const right = norm(cross(fwd, [0,1,0])); const up = cross(right, fwd);
  return { pos, fwd, right, up };
}
// ---- PNG (RGBA Uint8Array) ---------------------------------------------------
function encodePNG(W, H, px) {
  const raw = new Uint8Array(H * (1 + W * 4));
  for (let y = 0; y < H; y++) { raw[y*(1+W*4)] = 0; raw.set(px.subarray(y*W*4, (y+1)*W*4), y*(1+W*4)+1); }
  const idat = deflateSync(raw);
  const u32 = (n) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n); return b; };
  const crcT = (() => { const t = new Uint32Array(256); for (let n=0;n<256;n++){let c=n;for(let k=0;k<8;k++)c=(c&1)?(0xEDB88320^(c>>>1)):(c>>>1);t[n]=c>>>0;} return t; })();
  const crc = (b) => { let c=0xFFFFFFFF; for (let i=0;i<b.length;i++) c=crcT[(c^b[i])&0xFF]^(c>>>8); return (c^0xFFFFFFFF)>>>0; };
  const chunk = (type, data) => { const tb = new TextEncoder().encode(type); const body = new Uint8Array(tb.length+data.length); body.set(tb); body.set(data, tb.length); return [u32(data.length), body, u32(crc(body))]; };
  const ihdr = new Uint8Array(13); const dv = new DataView(ihdr.buffer); dv.setUint32(0, W); dv.setUint32(4, H); ihdr[8]=8; ihdr[9]=6;
  const parts = [new Uint8Array([137,80,78,71,13,10,26,10]), ...chunk("IHDR", ihdr), ...chunk("IDAT", new Uint8Array(idat)), ...chunk("IEND", new Uint8Array(0))];
  let total = 0; for (const p of parts) total += p.length;
  const out = new Uint8Array(total); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

// ---- GPU setup --------------------------------------------------------------
const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
if (!adapter) { console.error("no adapter"); Deno.exit(1); }
const device = await adapter.requestDevice();
const SHADER_PATH = Deno.env.get("SHADER") || "../shaders/chess.wgsl";
const code = await Deno.readTextFile(new URL(SHADER_PATH, import.meta.url));
const module = device.createShaderModule({ code });
const info = await module.getCompilationInfo();
const errs = info.messages.filter((m) => m.type === "error");
if (errs.length) { for (const e of errs) console.error(`L${e.lineNum}: ${e.message}`); Deno.exit(1); }

const W = 1280, H = 720, FMT = "rgba8unorm";
const target = device.createTexture({ size: [W, H], format: FMT, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC | GPUTextureUsage.TEXTURE_BINDING });
const globalsBuf = device.createBuffer({ size: 48*4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
const boardBuf = device.createBuffer({ size: 64*4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
const overlayBuf = device.createBuffer({ size: 96*4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });  // 8 slots * 3 vec4
const highlightBuf = device.createBuffer({ size: 64*4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });  // Play-mode highlights (binding 3)
const bindLayout = device.createBindGroupLayout({ entries: [
  { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
  { binding: 1, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "read-only-storage" } },
  { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "read-only-storage" } },
  { binding: 3, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "read-only-storage" } },
]});
const bindGroup = device.createBindGroup({ layout: bindLayout, entries: [
  { binding: 0, resource: { buffer: globalsBuf } }, { binding: 1, resource: { buffer: boardBuf } }, { binding: 2, resource: { buffer: overlayBuf } }, { binding: 3, resource: { buffer: highlightBuf } },
]});
const pipeline = device.createRenderPipeline({ layout: device.createPipelineLayout({ bindGroupLayouts: [bindLayout] }), vertex: { module, entryPoint: "vs" }, fragment: { module, entryPoint: "fs", targets: [{ format: FMT }] }, primitive: { topology: "triangle-list" } });

function packGlobals(cam, debugBits, overlayCount) {
  const g = new Float32Array(48);
  const fov = (45*Math.PI)/180, fovScale = Math.tan(fov/2), aspect = W/H;
  g.set([...cam.pos, 0], 0); g.set([...cam.fwd, fovScale], 4); g.set([...cam.right, aspect], 8); g.set([...cam.up, 0], 12);
  g.set([W, H, 3, 0], 16); g.set([5.5, 6.5, 4.0, 0.5], 20); g.set([1.0, 0.96, 0.9, 0.13], 24);
  g.set([12.0, 1, debugBits, 0], 28);
  g.set([0.48, 3.72, 10.44, 0], 32); g.set([4.34, 7.94, 0, 0], 36);  // white/black glass absorption
  g.set([overlayCount, -1, -1, 0], 40); g.set([1, 0.86, 0.45, 0], 44);
  return g;
}
function packOverlay(overlay) {
  const o = new Float32Array(96);   // 8 slots * 3 vec4 (pos+code · emissive+scale · tilt)
  overlay.forEach((p, k) => {
    const b = k*12;
    o[b]=p.pos[0]; o[b+1]=p.pos[1]; o[b+2]=p.pos[2]; o[b+3]=p.code;
    if (p.e) { o[b+4]=p.e[0]; o[b+5]=p.e[1]; o[b+6]=p.e[2]; }
    o[b+7]=p.scale;
    o[b+8]=p.tilt || 0;
    if (p.dir) { o[b+9]=p.dir[0]; o[b+10]=p.dir[1]; }   // topple fall direction (world xz)
  });
  return o;
}
async function renderCase(name, board, overlay, cam, debugBits) {
  device.queue.writeBuffer(globalsBuf, 0, packGlobals(cam, debugBits, overlay.length));
  device.queue.writeBuffer(boardBuf, 0, board);
  device.queue.writeBuffer(overlayBuf, 0, packOverlay(overlay));
  const bpr = Math.ceil(W*4/256)*256;
  const readBuf = device.createBuffer({ size: bpr*H, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const enc = device.createCommandEncoder();
  const pass = enc.beginRenderPass({ colorAttachments: [{ view: target.createView(), loadOp: "clear", storeOp: "store", clearValue: { r:0,g:0,b:0,a:1 } }] });
  pass.setPipeline(pipeline); pass.setBindGroup(0, bindGroup); pass.draw(3); pass.end();
  enc.copyTextureToBuffer({ texture: target }, { buffer: readBuf, bytesPerRow: bpr }, [W, H]);
  device.queue.submit([enc.finish()]);
  await readBuf.mapAsync(GPUMapMode.READ);
  const src = new Uint8Array(readBuf.getMappedRange());
  const px = new Uint8Array(W*H*4);
  for (let y = 0; y < H; y++) px.set(src.subarray(y*bpr, y*bpr + W*4), y*W*4);
  readBuf.unmap();
  Deno.writeFileSync(new URL(`../${name}.png`, import.meta.url), encodePNG(W, H, px));
  console.log("wrote", name + ".png");
}

// HIGHLIGHT=1: render the start position with a sample of every Play-mode board
// highlight code so the markers (selected ring, legal dots, capture/check rings,
// last-move fill) can be eyeballed.
if (Deno.env.get("HIGHLIGHT")) {
  const sq = (s) => (s.charCodeAt(1) - 49) * 8 + (s.charCodeAt(0) - 97);
  const hl = new Float32Array(64);
  hl[sq("e2")] = 1;  // selected (white pawn) -> gold ring
  hl[sq("e4")] = 2;  // legal move -> green dot
  hl[sq("e3")] = 2;
  hl[sq("d3")] = 2;
  hl[sq("c7")] = 3;  // legal capture (black pawn) -> red ring
  hl[sq("e1")] = 5;  // king in check (white king) -> red ring
  hl[sq("a3")] = 4;  // last move -> soft fill
  device.queue.writeBuffer(highlightBuf, 0, hl);
  await renderCase("highlight-test", startPosition(), [], camera(0.7, 0.62, 10), 0);
  console.log("highlight test done");
  Deno.exit(0);
}

// FXAA=1: render the scene with and without the FXAA post-pass (mirrors chess-main's
// two-pass setup) so the edge anti-aliasing can be eyeballed off vs on.
if (Deno.env.get("FXAA")) {
  const fmod = device.createShaderModule({ code: await Deno.readTextFile(new URL("../shaders/fxaa.wgsl", import.meta.url)) });
  const fi = (await fmod.getCompilationInfo()).messages.filter((m) => m.type === "error");
  if (fi.length) { for (const e of fi) console.error(`fxaa L${e.lineNum}: ${e.message}`); Deno.exit(1); }
  const sampler = device.createSampler({ magFilter: "linear", minFilter: "linear" });
  const flayout = device.createBindGroupLayout({ entries: [
    { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
    { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
  ]});
  const fpipe = device.createRenderPipeline({ layout: device.createPipelineLayout({ bindGroupLayouts: [flayout] }), vertex: { module: fmod, entryPoint: "vs" }, fragment: { module: fmod, entryPoint: "fs", targets: [{ format: FMT }] }, primitive: { topology: "triangle-list" } });
  const target2 = device.createTexture({ size: [W, H], format: FMT, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
  const fbind = device.createBindGroup({ layout: flayout, entries: [{ binding: 0, resource: target.createView() }, { binding: 1, resource: sampler }] });
  const readTex = async (tex) => {
    const bpr = Math.ceil(W*4/256)*256;
    const rb = device.createBuffer({ size: bpr*H, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const e = device.createCommandEncoder();
    e.copyTextureToBuffer({ texture: tex }, { buffer: rb, bytesPerRow: bpr }, [W, H]);
    device.queue.submit([e.finish()]);
    await rb.mapAsync(GPUMapMode.READ);
    const s = new Uint8Array(rb.getMappedRange()); const px = new Uint8Array(W*H*4);
    for (let y=0;y<H;y++) px.set(s.subarray(y*bpr, y*bpr+W*4), y*W*4);
    rb.unmap(); return px;
  };
  const crop = (px, name, cx, cy, CW, CH) => {
    const x0 = Math.max(0, Math.min(W-CW, cx-(CW>>1))), y0 = Math.max(0, Math.min(H-CH, cy-(CH>>1)));
    const out = new Uint8Array(CW*CH*4);
    for (let y=0;y<CH;y++) out.set(px.subarray(((y0+y)*W+x0)*4, ((y0+y)*W+x0)*4 + CW*4), y*CW*4);
    Deno.writeFileSync(new URL(`../${name}.png`, import.meta.url), encodePNG(CW, CH, out));
  };
  const cam = camera(0.7, 0.42, 7);
  device.queue.writeBuffer(globalsBuf, 0, packGlobals(cam, 0, 0));
  device.queue.writeBuffer(boardBuf, 0, startPosition());
  device.queue.writeBuffer(overlayBuf, 0, packOverlay([]));
  let e = device.createCommandEncoder();
  let p = e.beginRenderPass({ colorAttachments: [{ view: target.createView(), loadOp: "clear", storeOp: "store", clearValue: {r:0,g:0,b:0,a:1} }] });
  p.setPipeline(pipeline); p.setBindGroup(0, bindGroup); p.draw(3); p.end();
  device.queue.submit([e.finish()]);
  const off = await readTex(target);
  e = device.createCommandEncoder();
  p = e.beginRenderPass({ colorAttachments: [{ view: target2.createView(), loadOp: "clear", storeOp: "store", clearValue: {r:0,g:0,b:0,a:1} }] });
  p.setPipeline(fpipe); p.setBindGroup(0, fbind); p.draw(3); p.end();
  device.queue.submit([e.finish()]);
  const on = await readTex(target2);
  crop(off, "fxaa-off", 640, 230, 360, 200);   // back-rank piece tops against the dark board
  crop(on,  "fxaa-on",  640, 230, 360, 200);
  console.log("wrote fxaa-off.png / fxaa-on.png (crops)");
  Deno.exit(0);
}

// TOPPLE=1: render the resignation end-state geometry — a toppled king (tilt) next
// to an upright one — to eyeball the shader's overlay rotation. (Geometry check.)
if (Deno.env.get("TOPPLE")) {
  const board = startPosition();
  board[sqIdx("d4")] = 0; board[sqIdx("f4")] = 0;   // clear two mid-board cells
  const k = 0.70710678;   // 45-degree diagonal component
  const overlay = [
    { pos: cellWorld(sqIdx("c4")), code: 6,  scale: 1, tilt: 1.70, dir: [ k,  k], e: [2.2, 0.1, 0.1] }, // white, +x+z
    { pos: cellWorld(sqIdx("e4")), code: 6,  scale: 1, tilt: 1.70, dir: [ k, -k], e: [2.2, 0.1, 0.1] }, // white, +x-z
    { pos: cellWorld(sqIdx("g4")), code: 6,  scale: 1, tilt: 1.70, dir: [-k,  k], e: [2.2, 0.1, 0.1] }, // white, -x+z
    { pos: cellWorld(sqIdx("e6")), code: 16, scale: 1, tilt: 1.70, dir: [-k, -k], e: [2.2, 0.1, 0.1] }, // BLACK, -x-z
    { pos: cellWorld(sqIdx("e2")), code: 6,  scale: 1, tilt: 0.0,  e: [2.2, 1.8, 0.9] },                // upright ref (gold)
  ];
  await renderCase("topple-test", board, overlay, camera(0.7, 0.42, 9), 0);
  await renderCase("topple-test-side", board, overlay, camera(1.5708, 0.12, 8, [0, 0.4, 0]), 0); // side-on
  console.log("topple test done");
  Deno.exit(0);
}

// If a captured state dump exists, replay it EXACTLY (board + overlay + camera).
let dumpText = null;
try { dumpText = await Deno.readTextFile(new URL("./state-dump.json", import.meta.url)); } catch { /* none */ }
if (dumpText) {
  const d = JSON.parse(dumpText);
  const board = new Float32Array(64); board.set(d.board);
  const overlayRaw = new Float32Array(96); overlayRaw.set(d.overlay);
  const cam = camera(d.az, d.el, d.dist, d.tgt);
  const camClose = camera(d.az, d.el, 5, d.tgt);   // same angle, closer (smaller coords)
  // render straight from the raw float arrays the engine uploaded
  async function renderRaw(name, debugBits, countOverride, camOverride, boardOverride, overlayOverride) {
    const cnt = countOverride === undefined ? d.count : countOverride;
    device.queue.writeBuffer(globalsBuf, 0, packGlobals(camOverride || cam, debugBits, cnt));
    device.queue.writeBuffer(boardBuf, 0, boardOverride || board);
    device.queue.writeBuffer(overlayBuf, 0, overlayOverride || overlayRaw);
    const bpr = Math.ceil(W*4/256)*256;
    const readBuf = device.createBuffer({ size: bpr*H, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const enc = device.createCommandEncoder();
    const pass = enc.beginRenderPass({ colorAttachments: [{ view: target.createView(), loadOp: "clear", storeOp: "store", clearValue: { r:0,g:0,b:0,a:1 } }] });
    pass.setPipeline(pipeline); pass.setBindGroup(0, bindGroup); pass.draw(3); pass.end();
    enc.copyTextureToBuffer({ texture: target }, { buffer: readBuf, bytesPerRow: bpr }, [W, H]);
    device.queue.submit([enc.finish()]);
    await readBuf.mapAsync(GPUMapMode.READ);
    const src = new Uint8Array(readBuf.getMappedRange());
    const px = new Uint8Array(W*H*4);
    for (let y = 0; y < H; y++) px.set(src.subarray(y*bpr, y*bpr + W*4), y*W*4);
    readBuf.unmap();
    Deno.writeFileSync(new URL(`../${name}.png`, import.meta.url), encodePNG(W, H, px));
    console.log("wrote", name + ".png");
    return px;
  }
  // Crop a CW x CH box centred at (cx,cy) out of a full-frame pixel buffer and
  // save it (lets the Read tool see one piece up close without a browser).
  function cropSave(px, name, cx, cy, CW, CH) {
    const x0 = Math.max(0, Math.min(W - CW, cx - (CW >> 1)));
    const y0 = Math.max(0, Math.min(H - CH, cy - (CH >> 1)));
    const out = new Uint8Array(CW * CH * 4);
    for (let y = 0; y < CH; y++) {
      const sRow = ((y0 + y) * W + x0) * 4;
      out.set(px.subarray(sRow, sRow + CW * 4), y * CW * 4);
    }
    Deno.writeFileSync(new URL(`../${name}.png`, import.meta.url), encodePNG(CW, CH, out));
    console.log("wrote", name + ".png (crop)");
  }
  // Standard replay set: primary-hit debug, closer view, overlay-off, iteration
  // heatmap, and the final shaded image.
  const dbgPx  = await renderRaw("gpu-dump-dbg", 8);
  await renderRaw("gpu-dump-close", 8, undefined, camClose);  // same board+angle, closer camera
  await renderRaw("gpu-dump-noov", 8, 0);   // same board, overlay disabled (count=0)
  const heatPx = await renderRaw("gpu-dump-heat", 16);
  const normPx = await renderRaw("gpu-dump-norm", 0);
  // Isolate the moving overlay piece(s): empty static board, overlay on. Handy for
  // telling "is the gliding piece itself wrong" from "does it break other pieces".
  const emptyBoard = new Float32Array(64);
  await renderRaw("gpu-dump-ovonly-dbg",  8, undefined, undefined, emptyBoard);
  await renderRaw("gpu-dump-ovonly-norm", 0, undefined, undefined, emptyBoard);
  // Optional tight crop, so the Read tool can inspect one piece up close. Add
  //   "crop":[cx,cy,w,h]   to state-dump.json to enable (pixel coords in the 1280x720 frame).
  if (Array.isArray(d.crop) && d.crop.length === 4) {
    cropSave(dbgPx,  "gpu-dump-crop-dbg",  ...d.crop);
    cropSave(heatPx, "gpu-dump-crop-heat", ...d.crop);
    cropSave(normPx, "gpu-dump-crop-norm", ...d.crop);
  }
  console.log("replayed state dump (ply", d.ply, "count", d.count + ")");
} else {
  // No dump: sweep low/close angles.
  for (const el of [0.05, 0.10, 0.16]) for (const dist of [5, 8]) {
    await renderCase(`gpu-e${String(el).replace("0.","")}-d${dist}`, startPosition(), [], camera(0.7, el, dist), 8);
  }
}
console.log("done");
