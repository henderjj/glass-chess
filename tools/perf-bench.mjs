// Headless GPU perf benchmark (Deno): loads the REAL shaders/chess.wgsl, applies
// small source substitutions to make "variant" shaders, and for each variant
// renders the captured state-dump frame K times in one submit to measure GPU
// ms/frame, plus a pixel diff against the production baseline so we can tell
// which parameters are safely reducible (image identical) and how much they cost.
//   deno run -A --unstable-webgpu tools/perf-bench.mjs
import { OPERA_GAME, sqIdx, cellWorld } from "../src/chess-game.js";

const W = 1280, H = 720, FMT = "rgba8unorm";
const K = 100;            // frames per timing batch
const norm = (v) => { const l = Math.hypot(v[0],v[1],v[2]) || 1; return [v[0]/l, v[1]/l, v[2]/l]; };
const cross = (a, b) => [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
function camera(az, el, dist, tgt = [0, 0.45, 0]) {
  const ce = Math.cos(el), se = Math.sin(el), ca = Math.cos(az), sa = Math.sin(az);
  const pos = [tgt[0]+dist*ce*sa, tgt[1]+dist*se, tgt[2]+dist*ce*ca];
  const fwd = norm([tgt[0]-pos[0], tgt[1]-pos[1], tgt[2]-pos[2]]);
  const right = norm(cross(fwd, [0,1,0])); const up = cross(right, fwd);
  return { pos, fwd, right, up };
}
function packGlobals(cam, debugBits, overlayCount) {
  const g = new Float32Array(48);
  const fov = (45*Math.PI)/180, fovScale = Math.tan(fov/2), aspect = W/H;
  g.set([...cam.pos, 0], 0); g.set([...cam.fwd, fovScale], 4); g.set([...cam.right, aspect], 8); g.set([...cam.up, 0], 12);
  g.set([W, H, 3, 0], 16); g.set([5.5, 6.5, 4.0, 0.5], 20); g.set([1.0, 0.96, 0.9, 0.13], 24);
  g.set([12.0, 1, debugBits, 0], 28);
  g.set([0.48, 3.72, 10.44, 0], 32); g.set([4.34, 7.94, 0, 0], 36);
  g.set([overlayCount, -1, -1, 0], 40); g.set([1, 0.86, 0.45, 0], 44);
  return g;
}

const d = JSON.parse(await Deno.readTextFile(new URL("./state-dump.json", import.meta.url)));
const board = new Float32Array(64); board.set(d.board);
const overlay = new Float32Array(96); overlay.set(d.overlay);   // 8 slots * 3 vec4
const cam = camera(d.az, d.el, d.dist, d.tgt);
const baseCode = await Deno.readTextFile(new URL("../shaders/chess.wgsl", import.meta.url));

const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
const device = await adapter.requestDevice();

const target = device.createTexture({ size: [W, H], format: FMT, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
const globalsBuf = device.createBuffer({ size: 48*4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
const boardBuf = device.createBuffer({ size: 64*4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
const overlayBuf = device.createBuffer({ size: 96*4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });  // 8 slots * 3 vec4
const highlightBuf = device.createBuffer({ size: 64*4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });  // Play-mode highlights (binding 3); zero here
const bindLayout = device.createBindGroupLayout({ entries: [
  { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
  { binding: 1, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "read-only-storage" } },
  { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "read-only-storage" } },
  { binding: 3, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "read-only-storage" } },
]});
const bindGroup = device.createBindGroup({ layout: bindLayout, entries: [
  { binding: 0, resource: { buffer: globalsBuf } }, { binding: 1, resource: { buffer: boardBuf } }, { binding: 2, resource: { buffer: overlayBuf } }, { binding: 3, resource: { buffer: highlightBuf } },
]});
const layout = device.createPipelineLayout({ bindGroupLayouts: [bindLayout] });

device.queue.writeBuffer(globalsBuf, 0, packGlobals(cam, 0, d.count)); // normal render (bits 0)
device.queue.writeBuffer(boardBuf, 0, board);
device.queue.writeBuffer(overlayBuf, 0, overlay);

const bpr = Math.ceil(W*4/256)*256;
const readBuf = device.createBuffer({ size: bpr*H, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });

async function pipelineFor(code) {
  const module = device.createShaderModule({ code });
  const info = await module.getCompilationInfo();
  const errs = info.messages.filter((m) => m.type === "error");
  if (errs.length) { for (const e of errs) console.error(`  L${e.lineNum}: ${e.message}`); return null; }
  return device.createRenderPipeline({ layout, vertex: { module, entryPoint: "vs" }, fragment: { module, entryPoint: "fs", targets: [{ format: FMT }] }, primitive: { topology: "triangle-list" } });
}
function pass(enc) {
  const p = enc.beginRenderPass({ colorAttachments: [{ view: target.createView(), loadOp: "clear", storeOp: "store", clearValue: { r:0,g:0,b:0,a:1 } }] });
  p.setPipeline(CUR); p.setBindGroup(0, bindGroup); p.draw(3); p.end();
}
let CUR = null;
async function renderOnce() {
  const enc = device.createCommandEncoder();
  pass(enc);
  enc.copyTextureToBuffer({ texture: target }, { buffer: readBuf, bytesPerRow: bpr }, [W, H]);
  device.queue.submit([enc.finish()]);
  await readBuf.mapAsync(GPUMapMode.READ);
  const src = new Uint8Array(readBuf.getMappedRange());
  const px = new Uint8Array(W*H*4);
  for (let y = 0; y < H; y++) px.set(src.subarray(y*bpr, y*bpr + W*4), y*W*4);
  readBuf.unmap();
  return px;
}
async function timeMs() {
  // warmup
  { const enc = device.createCommandEncoder(); pass(enc); device.queue.submit([enc.finish()]); await device.queue.onSubmittedWorkDone(); }
  const reps = 5; const samples = [];
  for (let r = 0; r < reps; r++) {
    const enc = device.createCommandEncoder();
    for (let i = 0; i < K; i++) pass(enc);          // K passes, one submit
    const t0 = performance.now();
    device.queue.submit([enc.finish()]);
    await device.queue.onSubmittedWorkDone();
    samples.push((performance.now() - t0) / K);
  }
  samples.sort((a,b)=>a-b);
  return samples[Math.floor(reps/2)];                // median ms/frame
}
function diff(a, b) {
  let maxd = 0, changed = 0, sum = 0;
  for (let i = 0; i < a.length; i += 4) {
    const dr = Math.abs(a[i]-b[i]), dg = Math.abs(a[i+1]-b[i+1]), db = Math.abs(a[i+2]-b[i+2]);
    const m = Math.max(dr, dg, db);
    if (m > 0) { changed++; sum += m; }
    if (m > maxd) maxd = m;
  }
  return { maxd, changedPct: (100*changed/(a.length/4)).toFixed(2), meanChanged: changed ? (sum/changed).toFixed(1) : "0" };
}

// Variant = [label, [[find, replace], ...]]. Empty subs = baseline (production).
const VARIANTS = [
  ["baseline (production)", []],
  ["march 96 -> 64",        [["for (var i = 0; i < 96; i = i + 1) {", "for (var i = 0; i < 64; i = i + 1) {"]]],
  ["march 96 -> 48",        [["for (var i = 0; i < 96; i = i + 1) {", "for (var i = 0; i < 48; i = i + 1) {"]]],
  ["shadow 48 -> 32",       [["for (var i = 0; i < 48; i = i + 1) {", "for (var i = 0; i < 32; i = i + 1) {"]]],
  ["static box .35,.65,.35 -> .30,.60,.30", [["vec3<f32>(0.35, 0.65, 0.35)", "vec3<f32>(0.30, 0.60, 0.30)"]]],
  ["overlay box .4,.72,.4 -> .35,.65,.35",  [["vec3<f32>(0.4, 0.72, 0.4) * s", "vec3<f32>(0.35, 0.65, 0.35) * s"]]],
  ["SPP 2 -> 1 (quality change!)",          [["let SPP = 2;", "let SPP = 1;"]]],
];

let basePx = null;
let baseMs = 0;
console.log(`bench: ${W}x${H}, ${K} frames/batch, full-board animation frame (ply ${d.ply}, overlay ${d.count})\n`);
console.log("variant".padEnd(42) + "ms/frame  vs base   maxD  changed%   meanD");
for (const [label, subs] of VARIANTS) {
  let code = baseCode;
  for (const [f, r] of subs) {
    if (!code.includes(f)) { console.log(label.padEnd(42) + "SUBSTITUTION NOT FOUND: " + f); code = null; break; }
    code = code.replaceAll(f, r);
  }
  if (code === null) continue;
  CUR = await pipelineFor(code);
  if (!CUR) { console.log(label.padEnd(42) + "COMPILE FAILED"); continue; }
  const px = await renderOnce();
  const ms = await timeMs();
  if (!basePx) { basePx = px; baseMs = ms; }
  const dd = diff(px, basePx);
  console.log(
    label.padEnd(42) +
    ms.toFixed(3).padStart(8) +
    (((ms/baseMs - 1)*100).toFixed(1) + "%").padStart(8) +
    String(dd.maxd).padStart(6) +
    (dd.changedPct + "%").padStart(9) +
    String(dd.meanChanged).padStart(7),
  );
}
console.log("\n(maxD/changed%/meanD are pixel deltas vs baseline; 0 = image-identical = safe perf change)");
