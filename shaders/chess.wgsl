// ============================================================================
//  Coloured-glass chess set on a reflective board - WebGPU raytracer.
//  Pieces are SDF/CSG solids of revolution, laid out on an 8x8 grid with a
//  broad-phase so cost stays low. Glass uses Fresnel + Beer's-law absorption
//  (amber for white, dark red for black). Whitted-style iterative trace.
// ============================================================================

struct Globals {
  camPos      : vec4<f32>,  // xyz position, w time
  camForward  : vec4<f32>,  // xyz, w fovScale (tan(fov/2))
  camRight    : vec4<f32>,  // xyz, w aspect
  camUp       : vec4<f32>,  // xyz, w unused
  resolution  : vec4<f32>,  // x=width, y=height, z=maxDepth, w=frame
  light       : vec4<f32>,  // xyz light position, w radius
  lightColor  : vec4<f32>,  // rgb, w ambient
  options     : vec4<f32>,  // x=shadowK, y=glossySamples, z=debug bits (1 no-shadow,2 no-reflect,4 no-refract), w spare
  glassAbsW   : vec4<f32>,  // xyz Beer's-law absorption for white pieces, w spare
  glassAbsB   : vec4<f32>,  // xyz Beer's-law absorption for black pieces, w spare
  anim        : vec4<f32>,  // x=overlay piece count, y=startCell, z=endCell, w=square-glow intensity
  animCol     : vec4<f32>,  // xyz square-glow colour, w spare
};

@group(0) @binding(0) var<uniform> G : Globals;
// 64 board cells packed as 16 vec4s. cell value: 0 empty; 1..6 white piece;
// 11..16 black piece (type = value - colorOffset). type 1=pawn 2=knight
// 3=bishop 4=rook 5=queen 6=king.
@group(0) @binding(1) var<storage, read> board : array<vec4<f32>, 16>;
// Animation overlay: up to 8 "in-motion" pieces, 3 vec4 each (24 total).
//   overlay[3k]   = (worldX, worldY, worldZ, code)   code: 1..6 white, 11..16 black
//   overlay[3k+1] = (emissiveR, emissiveG, emissiveB, scale)
//   overlay[3k+2] = (tiltRadians, 0, 0, 0)           topple about the base; 0 = upright
// These are unioned into the SDF field at arbitrary positions (gliding pieces,
// the captured piece flashing/shrinking, a checked king pulsing, the toppling
// king on resignation). G.anim.x = count.
@group(0) @binding(2) var<storage, read> overlay : array<vec4<f32>, 24>;
// Per-cell board highlights for the single-player mode (64 cells, 16 vec4). Code:
// 0 none, 1 selected, 2 legal move, 3 legal capture, 4 last move, 5 king in check.
// All zero outside Play mode. Drawn as glow markers on the board squares.
@group(0) @binding(3) var<storage, read> highlight : array<vec4<f32>, 16>;

const PI  : f32 = 3.14159265359;
const EPS : f32 = 0.001;
const PIECE_MAX_H : f32 = 1.15;  // king cross top
const GLASS_IOR : f32 = 1.5;
const GLASS_SHADOW : f32 = 0.45;  // light transmitted through a glass piece
// Rays whose throughput falls below this contribute <1% and are pruned (both
// before pushing a child and after popping). Raising it trims faint deep bounces.
const MIN_THROUGHPUT : f32 = 0.01;
// Pieces are now modelled directly in world units (no non-uniform stretch),
// so heads stay spherical and proportions are easy to reason about.
const PIECE_SCALE : vec3<f32> = vec3<f32>(1.0, 1.0, 1.0);

// ---- RNG (PCG) --------------------------------------------------------------

var<private> rngState : u32;
fn pcgHash(v : u32) -> u32 {
  let state = v * 747796405u + 2891336453u;
  let word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
  return (word >> 22u) ^ word;
}
fn seedRng(p : vec2<f32>, frame : f32) {
  rngState = pcgHash(u32(p.x) + pcgHash(u32(p.y) + pcgHash(u32(frame))));
}
fn rand() -> f32 {
  rngState = pcgHash(rngState);
  return f32(rngState) / 4294967295.0;
}

// ---- Environment ------------------------------------------------------------

fn skyColor(dir : vec3<f32>) -> vec3<f32> {
  // Pure-black background: no sky gradient or horizon glow, so the board reads
  // against true black and the receding plane no longer looks "foggy" at grazing
  // angles (its reflected sky is black too). Glass/board keep their direct-light
  // specular highlights; only the reflected *environment* goes dark.
  return vec3<f32>(0.0, 0.0, 0.0);
}

// ---- SDF primitives & operators --------------------------------------------

fn sdSphere(p : vec3<f32>, r : f32) -> f32 { return length(p) - r; }

fn sdBox(p : vec3<f32>, b : vec3<f32>) -> f32 {
  let q = abs(p) - b;
  return length(max(q, vec3<f32>(0.0))) + min(max(q.x, max(q.y, q.z)), 0.0);
}
fn sdRoundBox(p : vec3<f32>, b : vec3<f32>, r : f32) -> f32 { return sdBox(p, b) - r; }

fn sdTorus(p : vec3<f32>, R : f32, r : f32) -> f32 {
  let q = vec2<f32>(length(p.xz) - R, p.y);
  return length(q) - r;
}
fn sdCylinder(p : vec3<f32>, h : f32, r : f32) -> f32 {
  let d = abs(vec2<f32>(length(p.xz), p.y)) - vec2<f32>(r, h);
  return min(max(d.x, d.y), 0.0) + length(max(d, vec2<f32>(0.0)));
}
fn sdCone(p : vec3<f32>, h : f32, r1 : f32, r2 : f32) -> f32 {
  let q = vec2<f32>(length(p.xz), p.y);
  let k1 = vec2<f32>(r2, h);
  let k2 = vec2<f32>(r2 - r1, 2.0 * h);
  let ca = vec2<f32>(q.x - min(q.x, select(r2, r1, q.y < 0.0)), abs(q.y) - h);
  let cb = q - k1 + k2 * clamp(dot(k1 - q, k2) / dot(k2, k2), 0.0, 1.0);
  let s = select(1.0, -1.0, cb.x < 0.0 && ca.y < 0.0);
  return s * sqrt(min(dot(ca, ca), dot(cb, cb)));
}
fn sdEllipsoid(p : vec3<f32>, r : vec3<f32>) -> f32 {
  // Conservative lower bound: same isosurface as the iq approximation (so the
  // shape is identical) but guaranteed <= true distance, so a march step can
  // never overshoot it. The iq form k0*(k0-1)/k1 can OVERESTIMATE for non-uniform
  // radii (the bishop's egg mitre), which let the march skip the surface.
  let k = length(p / r);
  return (k - 1.0) * min(r.x, min(r.y, r.z));
}
// A head that stays a true sphere of radius `r` in world space, by pre-dividing
// out the global PIECE_SCALE that the whole piece is later stretched by.
fn sdHead(p : vec3<f32>, c : vec3<f32>, r : f32) -> f32 {
  return sdEllipsoid(p - c, vec3<f32>(r) / PIECE_SCALE);
}
fn smin(a : f32, b : f32, k : f32) -> f32 {
  let h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
  return mix(b, a, h) - k * h * (1.0 - h);
}
fn opSub(a : f32, b : f32) -> f32 { return max(a, -b); }
fn opInt(a : f32, b : f32) -> f32 { return max(a, b); }
fn rotX(p : vec3<f32>, a : f32) -> vec3<f32> {
  let c = cos(a); let s = sin(a);
  return vec3<f32>(p.x, c * p.y - s * p.z, s * p.y + c * p.z);
}

// ---- Chess piece SDFs (local space, base at y = 0, "forward" = +z) ----------

// Shared flared base (wide flat foot -> rounded edge -> second tier -> cove).
fn base(p : vec3<f32>, R : f32) -> f32 {
  var d = sdCylinder(p - vec3<f32>(0.0, 0.03, 0.0), 0.03, R);                       // wide flat foot
  d = smin(d, sdTorus(p - vec3<f32>(0.0, 0.05, 0.0), R - 0.022, 0.022), 0.02);      // rounded foot edge
  d = smin(d, sdCylinder(p - vec3<f32>(0.0, 0.105, 0.0), 0.03, R * 0.80), 0.04);    // second tier
  d = smin(d, sdCone(p - vec3<f32>(0.0, 0.175, 0.0), 0.05, R * 0.66, R * 0.40), 0.05); // cove to stem
  return d;
}

fn sdPawn(p : vec3<f32>) -> f32 {
  var d = base(p, 0.155);
  d = smin(d, sdCone(p - vec3<f32>(0.0, 0.30, 0.0), 0.095, 0.066, 0.05), 0.04);  // slim stem
  d = smin(d, sdTorus(p - vec3<f32>(0.0, 0.375, 0.0), 0.058, 0.014), 0.02);      // collar
  d = smin(d, sdHead(p, vec3<f32>(0.0, 0.455, 0.0), 0.10), 0.022);              // ball head
  return d;
}
fn sdRook(p : vec3<f32>) -> f32 {
  var d = base(p, 0.185);
  d = smin(d, sdCone(p - vec3<f32>(0.0, 0.35, 0.0), 0.15, 0.135, 0.115), 0.04); // body
  d = smin(d, sdTorus(p - vec3<f32>(0.0, 0.50, 0.0), 0.115, 0.015), 0.02);      // collar bead
  d = smin(d, sdCone(p - vec3<f32>(0.0, 0.535, 0.0), 0.03, 0.12, 0.165), 0.02); // flare to battlement
  d = smin(d, sdCylinder(p - vec3<f32>(0.0, 0.58, 0.0), 0.055, 0.165), 0.02);   // battlement band
  // crenellations: 4 off-centre slots -> 3x3 merlon grid (teeth read from any side)
  let sc = p - vec3<f32>(0.0, 0.66, 0.0);
  d = opSub(d, sdBox(sc - vec3<f32>(0.075, 0.0, 0.0), vec3<f32>(0.04, 0.08, 0.5)));
  d = opSub(d, sdBox(sc - vec3<f32>(-0.075, 0.0, 0.0), vec3<f32>(0.04, 0.08, 0.5)));
  d = opSub(d, sdBox(sc - vec3<f32>(0.0, 0.0, 0.075), vec3<f32>(0.5, 0.08, 0.04)));
  d = opSub(d, sdBox(sc - vec3<f32>(0.0, 0.0, -0.075), vec3<f32>(0.5, 0.08, 0.04)));
  return d;
}
fn sdBishop(p : vec3<f32>) -> f32 {
  var d = base(p, 0.205);
  d = smin(d, sdCone(p - vec3<f32>(0.0, 0.40, 0.0), 0.22, 0.066, 0.044), 0.04); // tall slim stem
  d = smin(d, sdTorus(p - vec3<f32>(0.0, 0.56, 0.0), 0.06, 0.014), 0.02);       // collar
  d = smin(d, sdEllipsoid(p - vec3<f32>(0.0, 0.675, 0.0), vec3<f32>(0.08, 0.135, 0.08)), 0.03); // egg mitre
  d = smin(d, sdHead(p, vec3<f32>(0.0, 0.82, 0.0), 0.022), 0.015);             // finial
  // diagonal slit - only cuts from the front face to the centre
  d = opSub(d, sdBox(rotX(p - vec3<f32>(0.09, 0.71, 0.02), 0.7), vec3<f32>(0.12, 0.015, 0.10)));
  return d;
}
// Signed distance to the knight's 2D head outline (z,y). Points face +z.
fn knightProfile(q : vec2<f32>) -> f32 {
  var v = array<vec2<f32>, 12>(
    vec2<f32>(-0.126, 0.200), vec2<f32>(-0.151, 0.251), vec2<f32>(-0.164, 0.310),
    vec2<f32>(-0.159, 0.385), vec2<f32>(-0.121, 0.451), vec2<f32>(-0.057, 0.510),
    vec2<f32>(-0.178, 0.507), vec2<f32>(-0.194, 0.575), vec2<f32>(0.015, 0.672),
    vec2<f32>(0.018, 0.730), vec2<f32>(0.180, 0.592), vec2<f32>(0.126, 0.201),
  );
  var dd = dot(q - v[0], q - v[0]);
  var s = 1.0;
  var j = 11;
  for (var i = 0; i < 12; i = i + 1) {
    let e = v[j] - v[i];
    let w = q - v[i];
    let b = w - e * clamp(dot(w, e) / dot(e, e), 0.0, 1.0);
    dd = min(dd, dot(b, b));
    let c1 = q.y >= v[i].y;
    let c2 = q.y < v[j].y;
    let c3 = (e.x * w.y) > (e.y * w.x);
    if ((c1 && c2 && c3) || (!c1 && !c2 && !c3)) { s = -s; }
    j = i;
  }
  return s * sqrt(dd);
}
fn sdKnight(p : vec3<f32>) -> f32 {
  var d = base(p, 0.185);
  // collar fills the base waist & is slightly wider than the neck, so the neck
  // emerges cleanly (no pinch, no overhang above the collar)
  d = smin(d, sdCylinder(p - vec3<f32>(0.0, 0.205, 0.0), 0.055, 0.12), 0.06);
  d = smin(d, sdTorus(p - vec3<f32>(0.0, 0.265, 0.0), 0.12, 0.015), 0.02);   // collar bead
  // head: traced 2D outline extruded into a slab whose thickness tapers from a
  // round neck (matching the collar) up to a flat head -> no protruding disc.
  // -p.z flips the facing so board knights face their opponent (was backwards).
  let prof = knightProfile(vec2<f32>(-p.z, p.y));
  let t = mix(0.115, 0.05, smoothstep(0.27, 0.50, p.y));
  let wx = abs(p.x) - t;
  let head = min(max(prof, wx), 0.0) + length(max(vec2<f32>(prof, wx), vec2<f32>(0.0))) - 0.02;
  d = smin(d, head, 0.03);
  return d;
}
fn sdCrown(p : vec3<f32>, ringR : f32, y : f32, bump : f32) -> f32 {
  // Ring of small spheres via angular domain repetition. Check the 3 nearest
  // angular cells (not just 1): a single-cell lookup overestimates distance in
  // the gaps between balls, so the march overshoots the coronet. Same shape.
  let ang = atan2(p.z, p.x);
  let rep = (2.0 * PI) / 8.0;
  let cell = floor(ang / rep);
  var d = 1e9;
  for (var k = -1; k <= 1; k = k + 1) {
    let a2 = (cell + f32(k) + 0.5) * rep;
    let c = vec3<f32>(cos(a2), 0.0, sin(a2)) * ringR + vec3<f32>(0.0, y, 0.0);
    d = min(d, sdSphere(p - c, bump));
  }
  return d;
}
fn sdQueen(p : vec3<f32>) -> f32 {
  var d = base(p, 0.225);
  d = smin(d, sdCone(p - vec3<f32>(0.0, 0.46, 0.0), 0.27, 0.076, 0.048), 0.04); // tall slim stem
  d = smin(d, sdTorus(p - vec3<f32>(0.0, 0.74, 0.0), 0.068, 0.015), 0.02);      // collar
  d = smin(d, sdCone(p - vec3<f32>(0.0, 0.81, 0.0), 0.05, 0.07, 0.115), 0.03);  // crown band (flares up)
  d = smin(d, sdCrown(p, 0.11, 0.90, 0.032), 0.02);                            // coronet points
  d = smin(d, sdHead(p, vec3<f32>(0.0, 0.86, 0.0), 0.038), 0.025);             // centre ball
  return d;
}
fn sdKing(p : vec3<f32>) -> f32 {
  var d = base(p, 0.255);
  d = smin(d, sdCone(p - vec3<f32>(0.0, 0.48, 0.0), 0.30, 0.08, 0.052), 0.04);  // tallest slim stem
  d = smin(d, sdTorus(p - vec3<f32>(0.0, 0.78, 0.0), 0.072, 0.015), 0.02);      // collar
  d = smin(d, sdCone(p - vec3<f32>(0.0, 0.85, 0.0), 0.05, 0.072, 0.115), 0.03); // crown band
  d = smin(d, sdHead(p, vec3<f32>(0.0, 0.93, 0.0), 0.06), 0.03);               // crown top
  // cross
  let cc = p - vec3<f32>(0.0, 1.03, 0.0);
  d = min(d, sdBox(cc, vec3<f32>(0.016, 0.058, 0.016)));
  d = min(d, sdBox(cc - vec3<f32>(0.0, 0.018, 0.0), vec3<f32>(0.042, 0.016, 0.016)));
  return d;
}
fn sdPiece(p : vec3<f32>, t : f32) -> f32 {
  if (t < 1.5) { return sdPawn(p); }
  if (t < 2.5) { return sdKnight(p); }
  if (t < 3.5) { return sdBishop(p); }
  if (t < 4.5) { return sdRook(p); }
  if (t < 5.5) { return sdQueen(p); }
  return sdKing(p);
}

// ---- Board / piece field ----------------------------------------------------

fn cellValue(c : i32) -> f32 {
  return board[c / 4][c % 4];
}
fn highlightValue(c : i32) -> f32 {
  return highlight[c / 4][c % 4];
}

// Returns vec2(distance, colorCode). colorCode -1 = no piece nearby, 0 = amber
// (white), 1 = dark red (black). 3x3 cell broad-phase: a piece can be the nearest
// surface from an adjacent cell, so all 9 cells are considered -- but the centre
// cell (the one under the sample point, almost always the nearest) is evaluated
// first so `best` tightens immediately, and every cell is rejected, before any
// storage read or piece SDF, when its bounding box already loses to `best`
// (0.9*boxDist lower-bounds that cell's returned distance). The result is identical
// to brute-forcing all 9 cells -- nothing crops at boundaries -- but in practice it
// costs ~one piece-SDF evaluation per march step.
// Field sample: signed distance, colour code (0 white / 1 black / -1 none) and
// an emissive term (non-zero only for glowing overlay pieces).
struct Field { d : f32, col : f32, emis : vec3<f32> };

fn sdfScene(p : vec3<f32>) -> Field {
  let fu = i32(floor(p.x + 4.0));
  let fw = i32(floor(p.z + 4.0));
  var off = array<vec2<i32>, 9>(
    vec2<i32>(0, 0),                                        // centre first
    vec2<i32>(-1, -1), vec2<i32>(0, -1), vec2<i32>(1, -1),
    vec2<i32>(-1,  0),                   vec2<i32>(1,  0),
    vec2<i32>(-1,  1), vec2<i32>(0,  1), vec2<i32>(1,  1),
  );
  var best = 1e30;
  var bestCol = -1.0;
  for (var i = 0; i < 9; i = i + 1) {
    let cx = fu + off[i].x;
    let cz = fw + off[i].y;
    if (cx < 0 || cx > 7 || cz < 0 || cz > 7) { continue; }
    let center = vec3<f32>(f32(cx) - 3.5, 0.0, f32(cz) - 3.5);
    // Cheap conservative reject before the storage read and the piece SDF.
    let q = abs(p - center - vec3<f32>(0.0, 0.6, 0.0)) - vec3<f32>(0.35, 0.65, 0.35);
    if (0.9 * length(max(q, vec3<f32>(0.0))) > best) { continue; }
    let v = cellValue(cz * 8 + cx);
    if (v < 0.5) { continue; }
    let isBlack = v > 9.5;
    let t = v - select(0.0, 10.0, isBlack);
    var lp = p - center;
    if (isBlack) { lp.x = -lp.x; lp.z = -lp.z; }  // face the opposing side
    let d = sdPiece(lp / PIECE_SCALE, t) * 0.9;
    if (d < best) { best = d; bestCol = select(0.0, 1.0, isBlack); }
  }

  // Empty-region cell step. When no static piece is in the 3x3 window, `best` is
  // still the 1e30 sentinel; the safe march distance is then ONE CELL (1.0), so
  // the ray re-samples every cell and a piece is caught as it enters the window.
  // Collapse the sentinel to that step BEFORE the overlay loop: a distant overlay
  // piece must only ever *tighten* the step, never inflate it past 1.0. (Bug: the
  // overlay loop ran with best==1e30, so its reject never fired, and a far gliding
  // piece overwrote the sentinel with its true large distance -> the march took a
  // giant step and skipped over unrelated static pieces, which vanished.)
  var step = select(best, 1.0, best > 1e29);

  // Animation overlay: in-motion / captured / highlighted pieces at arbitrary
  // world positions, unioned in with the same conservative broad-phase reject.
  var emis = vec3<f32>(0.0);
  let nOv = i32(G.anim.x);
  for (var k = 0; k < nOv; k = k + 1) {
    let a0 = overlay[3 * k];
    let a1 = overlay[3 * k + 1];
    let a2 = overlay[3 * k + 2];                  // (tilt, fall dirX, fall dirZ, _)
    let tilt = a2.x;                              // topple angle (radians); 0 = upright
    let s = a1.w;
    if (s < 0.03) { continue; }                  // shrunk to nothing (captured fade)
    let pos = a0.xyz;
    // Upright pieces use the tight bounding box to skip; a toppled piece lies
    // horizontally outside it, so never reject a tilted piece (rare end-state).
    let q = abs(p - pos - vec3<f32>(0.0, 0.6 * s, 0.0)) - vec3<f32>(0.4, 0.72, 0.4) * s;
    if (tilt < 0.0001 && 0.9 * length(max(q, vec3<f32>(0.0))) > step) { continue; }
    let code = a0.w;
    let isBlack = code > 9.5;
    let t = code - select(0.0, 10.0, isBlack);
    var lp = p - pos;
    // Resignation: tip the king over its base RIM onto its side, in the horizontal
    // world direction (dirX,dirZ) — chosen to point into the board so it never falls
    // off an edge. Yaw so that direction maps to -z, then rotate about x with the
    // pivot at the leading rim (z=-baseR, on the board) so the foot stays planted and
    // the base never sinks through. (The king is ~radially symmetric, so the black
    // "facing" flip is skipped while toppled; upright pieces still get it.)
    if (tilt > 0.0001) {
      let cs = cos(tilt);
      let sn = sin(tilt);
      let baseR = 0.255;            // king foot radius (the topple is king-only)
      let yx = -a2.z * lp.x + a2.y * lp.z;   // yaw: world fall dir (dirX,dirZ) -> -z
      let yz = -a2.y * lp.x - a2.z * lp.z;
      let qz = yz + baseR;
      lp = vec3<f32>(yx, cs * lp.y - sn * qz, sn * lp.y + cs * qz - baseR);
    } else if (isBlack) {
      lp.x = -lp.x; lp.z = -lp.z;   // face the opposing side
    }
    let d = sdPiece(lp / (s * PIECE_SCALE), t) * 0.9 * s;
    if (d < step) { step = d; bestCol = select(0.0, 1.0, isBlack); emis = a1.xyz; }
  }

  // bestCol stays -1 when only the 1.0 cell step is left (no real surface here),
  // so the march treats it as a non-hit and just advances one cell.
  return Field(step, bestCol, emis);
}

// Tetrahedron-sampled gradient: 4 field evals instead of the central-difference 6.
fn sceneNormal(p : vec3<f32>) -> vec3<f32> {
  let e = 0.0009;
  let k = vec2<f32>(1.0, -1.0);
  return normalize(
    k.xyy * sdfScene(p + k.xyy * e).d +
    k.yyx * sdfScene(p + k.yyx * e).d +
    k.yxy * sdfScene(p + k.yxy * e).d +
    k.xxx * sdfScene(p + k.xxx * e).d
  );
}

struct PieceHit { hit : bool, t : f32, col : f32, emis : vec3<f32> };

// March the piece field within the board's bounding slab.
fn marchPieces(ro : vec3<f32>, rd : vec3<f32>, maxT : f32) -> PieceHit {
  var res : PieceHit;
  res.hit = false; res.t = maxT; res.col = -1.0; res.emis = vec3<f32>(0.0);

  let bmin = vec3<f32>(-4.05, -0.05, -4.05);
  let bmax = vec3<f32>( 4.05,  PIECE_MAX_H + 0.1, 4.05);
  let inv = 1.0 / rd;
  let t1 = (bmin - ro) * inv;
  let t2 = (bmax - ro) * inv;
  let tmn = min(t1, t2);
  let tmx = max(t1, t2);
  let tn = max(max(tmn.x, tmn.y), tmn.z);
  let tf = min(min(tmx.x, tmx.y), tmx.z);
  if (tf < max(tn, 0.0)) { return res; }     // misses the board volume
  var t = max(tn, 0.02);
  let bound = min(maxT, tf);
  if (t >= bound) { return res; }

  // Hit threshold = max(small floor, fixed cone, ONE PIXEL'S footprint at this
  // depth). The pixel-footprint term (2*fovScale*t/height) is the real fix: at the
  // default camera distance the slim lower bodies shrink to ~sub-pixel, and without
  // it a 1-spp ray slips between them and the board -> bodies drop out ("only heads
  // left"), worst at low resolution. Tying eps to the footprint catches them at any
  // resolution while staying crisp up close (small t) and at high res (large height).
  let footK = 2.0 * G.camForward.w / max(G.resolution.y, 1.0);
  for (var i = 0; i < 96; i = i + 1) {
    let f = sdfScene(ro + rd * t);
    let eps = max(max(0.0009, 0.0014 * t), footK * t);
    if (abs(f.d) < eps && f.col >= 0.0) {     // hit only on a real piece surface
      res.hit = true; res.t = t; res.col = f.col; res.emis = f.emis;
      return res;
    }
    t = t + max(abs(f.d), 0.0008);
    if (t >= bound) { break; }
  }
  return res;
}

// ---- Hit & shading ----------------------------------------------------------

struct Hit {
  t            : f32,
  pos          : vec3<f32>,
  normal       : vec3<f32>,
  albedo       : vec3<f32>,
  reflectivity : f32,
  transparency : f32,
  isGlass      : bool,
  glassCol     : f32,
  emissive     : vec3<f32>,   // added light (piece glow / captured flash / square outline)
  hit          : bool,
};

// Integral of the +/-1 square wave (period 2): a triangle wave in [0,1]. Slope is
// +1 over even unit cells, -1 over odd ones, so (I(b)-I(a))/(b-a) is the cell's
// average sign over [a,b] — the basis for analytically box-filtering the checker.
fn sqWaveInt(x : f32) -> f32 { return 1.0 - abs(fract(x * 0.5) * 2.0 - 1.0); }

// Board colour, with the checker box-filtered over the pixel footprint `w` (world
// units on the board) so distant squares average to grey instead of shimmering,
// and the board -> black-surround boundary smoothed over the same footprint.
fn boardAlbedo(p : vec3<f32>, w : f32) -> vec3<f32> {
  let light = vec3<f32>(0.78, 0.74, 0.66);
  let dark  = vec3<f32>(0.006, 0.006, 0.009); // near-black
  let kw = max(w, 0.0008);
  let hw = 0.5 * kw;
  let X = p.x + 4.0;
  let Z = p.z + 4.0;
  // Per-axis average of the +/-1 square wave over the footprint; product = checker.
  let ax = (sqWaveInt(X + hw) - sqWaveInt(X - hw)) / kw;
  let az = (sqWaveInt(Z + hw) - sqWaveInt(Z - hw)) / kw;
  let whiteFrac = clamp(0.5 + 0.5 * ax * az, 0.0, 1.0);  // 1 light .. 0 dark .. 0.5 blurred
  let checker = mix(dark, light, whiteFrac);
  // Coverage of the board (|x|,|z| <= 4) over the footprint -> antialiased edge.
  let cov = clamp((4.0 - abs(p.x)) / kw + 0.5, 0.0, 1.0)
          * clamp((4.0 - abs(p.z)) / kw + 0.5, 0.0, 1.0);
  return checker * cov;
}

fn intersectScene(ro : vec3<f32>, rd : vec3<f32>) -> Hit {
  var h : Hit;
  h.hit = false;
  h.t = 1e30;
  h.isGlass = false;
  h.glassCol = 0.0;
  h.emissive = vec3<f32>(0.0);

  // Board / surround plane at y = 0
  if (abs(rd.y) > 1e-5) {
    let t = -ro.y / rd.y;
    if (t > EPS && t < h.t) {
      let p = ro + rd * t;
      h.t = t; h.hit = true; h.pos = p;
      h.normal = vec3<f32>(0.0, 1.0, 0.0);
      // Pixel footprint on the board: ~1px perpendicular to the ray (2*fovScale*t/H),
      // stretched by 1/|rd.y| along the grazing direction. Drives the checker filter.
      let pw = 2.0 * G.camForward.w * t / max(G.resolution.y, 1.0);
      h.albedo = boardAlbedo(p, pw / max(abs(rd.y), 0.05));
      let onBoard = abs(p.x) <= 4.0 && abs(p.z) <= 4.0;
      // Polished-lacquer reflectivity: small face-on, near-mirror at grazing angles.
      let baseR = select(0.03, 0.08, onBoard);
      let fres = pow(1.0 - abs(rd.y), 5.0);
      h.reflectivity = baseR + (1.0 - baseR) * fres;
      h.transparency = 0.0;
      // Glowing outline on the move's start/end squares (G.anim.y/.z = cell index).
      if (onBoard && G.anim.w > 0.001) {
        let cell = f32(i32(floor(p.z + 4.0)) * 8 + i32(floor(p.x + 4.0)));
        if (cell == G.anim.y || cell == G.anim.z) {
          let lx = fract(p.x + 4.0);
          let lz = fract(p.z + 4.0);
          let edge = min(min(lx, 1.0 - lx), min(lz, 1.0 - lz));
          h.emissive = G.animCol.xyz * G.anim.w * smoothstep(0.11, 0.0, edge);
        }
      }
      // Single-player highlights: a centre dot for legal moves, an edge ring for the
      // selected square / capturable piece / checked king, a soft fill for last move.
      if (onBoard) {
        let hl = highlightValue(i32(floor(p.z + 4.0)) * 8 + i32(floor(p.x + 4.0)));
        if (hl > 0.5) {
          let cx = fract(p.x + 4.0) - 0.5;
          let cz = fract(p.z + 4.0) - 0.5;
          let ring = smoothstep(0.085, 0.03, 0.5 - max(abs(cx), abs(cz)));  // bright band near the border
          let dot  = smoothstep(0.20, 0.15, length(vec2<f32>(cx, cz)));     // filled centre disc
          if      (hl < 1.5) { h.emissive += vec3<f32>(1.0, 0.82, 0.35) * ring * 1.5; }            // selected
          else if (hl < 2.5) { h.emissive += vec3<f32>(0.45, 0.95, 0.5)  * dot  * 1.1; }           // legal move
          else if (hl < 3.5) { h.emissive += vec3<f32>(1.0, 0.35, 0.2)   * ring * 1.6; }           // legal capture
          else if (hl < 4.5) { h.emissive += vec3<f32>(0.85, 0.72, 0.32) * 0.16; }                 // last move (fill)
          else               { h.emissive += vec3<f32>(1.0, 0.1, 0.1) * (ring * 1.8 + 0.18); }     // king in check
        }
      }
    }
  }

  // Glass pieces
  let far = select(60.0, h.t, h.hit);
  let pm = marchPieces(ro, rd, far);
  if (pm.hit && pm.t < h.t) {
    let p = ro + rd * pm.t;
    h.t = pm.t; h.hit = true; h.pos = p;
    h.normal = sceneNormal(p);
    // Tint the faint (~5%) direct/diffuse sheen to the glass hue. A white albedo
    // here reads as flat grey on near-horizontal, light-facing faces (base tiers,
    // cove): those catch the most diffuse, glass shadowing is skipped for perf, and
    // their refraction points down into shadow -- so the white wash dominated.
    h.albedo = exp(-glassAbsorb(pm.col) * 0.3);
    h.reflectivity = 0.04;
    h.transparency = 0.95;
    h.isGlass = true;
    h.glassCol = pm.col;
    h.emissive = pm.emis;   // overlay-piece glow / captured flash (0 for resting pieces)
  }
  return h;
}

// Soft shadow in a single march (no area-light sampling), so the penumbra looks
// identical whether the camera is moving or settled. Tracks the ray's closest
// approach to a piece (Inigo-Quilez penumbra trick): res falls from 1 toward 0
// as the ray grazes geometry. `k` controls hardness (larger = sharper). Every
// occluder is glass, so a fully blocked ray still transmits GLASS_SHADOW.
fn softShadow(ro : vec3<f32>, lightPos : vec3<f32>, k : f32) -> f32 {
  let toL = lightPos - ro;
  let dist = length(toL);
  let rd = toL / dist;

  let bmin = vec3<f32>(-4.05, -0.05, -4.05);
  let bmax = vec3<f32>( 4.05, PIECE_MAX_H + 0.1, 4.05);
  let inv = 1.0 / rd;
  let t1 = (bmin - ro) * inv;
  let t2 = (bmax - ro) * inv;
  let tmn = min(t1, t2);
  let tmx = max(t1, t2);
  let tn = max(max(tmn.x, tmn.y), tmn.z);
  let tf = min(min(tmx.x, tmx.y), tmx.z);
  if (tf < max(tn, 0.0)) { return 1.0; }    // ray to light clears the board volume
  var t = max(tn, 0.02);
  let bound = min(dist, tf);

  var res = 1.0;
  for (var i = 0; i < 48; i = i + 1) {
    if (t >= bound) { break; }
    let f = sdfScene(ro + rd * t);
    if (f.col >= 0.0) {                      // only real piece surfaces occlude
      if (f.d < 0.001) { return GLASS_SHADOW; }   // ray entered a piece: full block
      res = min(res, k * f.d / t);
    }
    t = t + max(f.d, 0.0015);
  }
  return max(res, GLASS_SHADOW);
}

fn fresnelSchlick(cosTheta : f32, ior : f32) -> f32 {
  var r0 = (1.0 - ior) / (1.0 + ior);
  r0 = r0 * r0;
  return r0 + (1.0 - r0) * pow(clamp(1.0 - cosTheta, 0.0, 1.0), 5.0);
}

fn shade(h : Hit, viewDir : vec3<f32>, doShadow : bool) -> vec3<f32> {
  let ambient = h.albedo * G.lightColor.w;
  let toLight = normalize(G.light.xyz - h.pos);

  // Soft-shadow march only where the direct term actually matters (board/opaque).
  // Glass carries <=5% direct weight, so shadowing it is invisible yet costs a
  // full march per glass hit -- skip it. options.x = penumbra hardness k;
  // options.z bit0 disables shadows entirely (GPU profiling).
  var vis = 1.0;
  if (doShadow && (u32(G.options.z) & 1u) == 0u) {
    vis = softShadow(h.pos + h.normal * EPS, G.light.xyz, G.options.x);
  }

  let diff = max(dot(h.normal, toLight), 0.0);
  let halfV = normalize(toLight + viewDir);
  let spec = pow(max(dot(h.normal, halfV), 0.0), 64.0);

  let diffuse = h.albedo * diff * G.lightColor.rgb * vis;
  let specular = G.lightColor.rgb * spec * vis * 0.5;
  return ambient + diffuse + specular;
}

fn glassAbsorb(col : f32) -> vec3<f32> {
  // Beer's law exp(-absorb*t): low channel = transmitted (the hue), high = cut.
  // Coefficients are driven live from the UI (tint + density) via the uniforms.
  if (col < 0.5) { return G.glassAbsW.xyz; }   // white pieces
  return G.glassAbsB.xyz;                       // black pieces
}

// ---- Iterative trace with ray stack + Beer's-law absorption -----------------

struct RaySeg {
  origin     : vec3<f32>,
  dir        : vec3<f32>,
  throughput : vec3<f32>,
  absorb     : vec3<f32>,   // absorption coefficient of the medium being traversed
  depth      : i32,
};

// Iterative DFS stack for the ray tree. A glass hit splits into reflect+refract,
// so with maxDepth=4 at most 5 segments are ever live at once; 8 leaves headroom
// while keeping per-invocation scratch small (helps GPU occupancy). Bump this if
// sceneParams.maxDepth grows past ~6.
const STACK_SIZE : i32 = 8;

fn trace(ro : vec3<f32>, rd : vec3<f32>) -> vec3<f32> {
  var stack : array<RaySeg, STACK_SIZE>;
  stack[0] = RaySeg(ro, rd, vec3<f32>(1.0), vec3<f32>(0.0), 0);
  var sp = 1;
  let maxDepth = i32(G.resolution.z);
  var color = vec3<f32>(0.0);

  loop {
    if (sp <= 0) { break; }
    sp = sp - 1;
    let seg = stack[sp];

    let h = intersectScene(seg.origin, seg.dir);

    // Beer's-law absorption over the distance travelled in the current medium.
    var tp = seg.throughput;
    if (h.hit) { tp = tp * exp(-seg.absorb * h.t); }

    if (max(tp.r, max(tp.g, tp.b)) < MIN_THROUGHPUT) { continue; }

    if (!h.hit) {
      color = color + tp * skyColor(seg.dir);
      continue;
    }

    // Emissive (added light): piece glow, captured red flash, square outline.
    // Attenuated by the medium the ray crossed to reach the surface (via tp).
    color = color + tp * h.emissive;

    var n = h.normal;
    let entering = dot(seg.dir, n) < 0.0;
    if (!entering) { n = -n; }
    let viewDir = -seg.dir;

    var refl = h.reflectivity;
    var trans = h.transparency;
    if (h.isGlass) {
      let F = fresnelSchlick(clamp(dot(viewDir, n), 0.0, 1.0), GLASS_IOR);
      refl = F;
      trans = (1.0 - F) * h.transparency;
    }

    let directWeight = clamp(1.0 - refl - trans, 0.0, 1.0);
    if (directWeight > 0.001) {
      color = color + tp * directWeight * shade(h, viewDir, directWeight > 0.1);
    }
    if (h.isGlass) {
      let halfV = normalize(normalize(G.light.xyz - h.pos) + viewDir);
      color = color + tp * G.lightColor.rgb * pow(max(dot(n, halfV), 0.0), 200.0) * 0.4;
    }

    if (seg.depth >= maxDepth) { continue; }

    // Reflection (stays in the same medium). Cull by child throughput *before*
    // pushing, so a negligible ray never costs a full intersect on the next pop.
    // (options.z bit1 disables reflection rays for GPU profiling.)
    let reflTp = tp * refl;
    if ((u32(G.options.z) & 2u) == 0u && max(reflTp.r, max(reflTp.g, reflTp.b)) > MIN_THROUGHPUT && sp < STACK_SIZE - 1) {
      let rdir = reflect(seg.dir, n);
      stack[sp] = RaySeg(h.pos + n * EPS, rdir, reflTp, seg.absorb, seg.depth + 1);
      sp = sp + 1;
    }
    // Refraction (toggles medium: into glass = coloured absorption, out = air).
    // (options.z bit2 disables refraction rays for GPU profiling.)
    let transTp = tp * trans;
    if ((u32(G.options.z) & 4u) == 0u && max(transTp.r, max(transTp.g, transTp.b)) > MIN_THROUGHPUT && sp < STACK_SIZE - 1) {
      let eta = select(GLASS_IOR, 1.0 / GLASS_IOR, entering);
      let rdir = refract(seg.dir, n, eta);
      if (dot(rdir, rdir) > 0.0001) {
        let newAbsorb = select(vec3<f32>(0.0), glassAbsorb(h.glassCol), entering);
        stack[sp] = RaySeg(h.pos - n * EPS, rdir, transTp, newAbsorb, seg.depth + 1);
        sp = sp + 1;
      }
    }
  }
  return color;
}

// ---- Fullscreen pass --------------------------------------------------------

@vertex
fn vs(@builtin(vertex_index) vi : u32) -> @builtin(position) vec4<f32> {
  var p = array<vec2<f32>, 3>(
    vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0),
  );
  return vec4<f32>(p[vi], 0.0, 1.0);
}

@fragment
fn fs(@builtin(position) fragCoord : vec4<f32>) -> @location(0) vec4<f32> {
  let res = G.resolution.xy;
  seedRng(fragCoord.xy, G.resolution.w);
  let fovScale = G.camForward.w;
  let aspect = G.camRight.w;

  // Debug primary-hit view (options.z bit3 / key 4): false-colour what the centre
  // ray of each pixel hits -- green = piece, blue = board, red = nothing (sky/miss).
  if ((u32(G.options.z) & 8u) != 0u) {
    let ndc = vec2<f32>((fragCoord.x / res.x) * 2.0 - 1.0, 1.0 - (fragCoord.y / res.y) * 2.0);
    let dir = normalize(
      G.camForward.xyz + G.camRight.xyz * (ndc.x * fovScale * aspect) + G.camUp.xyz * (ndc.y * fovScale)
    );
    let hd = intersectScene(G.camPos.xyz, dir);
    if (!hd.hit) { return vec4<f32>(0.6, 0.0, 0.0, 1.0); }
    if (hd.isGlass) { return vec4<f32>(0.0, 0.8, 0.0, 1.0); }
    return vec4<f32>(0.0, 0.2, 0.75, 1.0);
  }

  // Iteration-count heatmap (options.z bit4 / key 5). Re-marches the piece field
  // counting steps: piece hit -> green; no piece -> RED with brightness = steps
  // used (bright red = ran out of budget; dark red = concluded "empty" fast, i.e.
  // the board buffer the GPU sees has no piece there).
  if ((u32(G.options.z) & 16u) != 0u) {
    let ndc = vec2<f32>((fragCoord.x / res.x) * 2.0 - 1.0, 1.0 - (fragCoord.y / res.y) * 2.0);
    let dir = normalize(G.camForward.xyz + G.camRight.xyz * (ndc.x * fovScale * aspect) + G.camUp.xyz * (ndc.y * fovScale));
    let ro = G.camPos.xyz;
    var far = 60.0;
    if (abs(dir.y) > 1e-5) { let tb = -ro.y / dir.y; if (tb > 0.001) { far = tb; } }
    let bmin = vec3<f32>(-4.05, -0.05, -4.05);
    let bmax = vec3<f32>(4.05, PIECE_MAX_H + 0.1, 4.05);
    let inv = 1.0 / dir;
    let t1 = (bmin - ro) * inv; let t2 = (bmax - ro) * inv;
    let tn = max(max(min(t1.x, t2.x), min(t1.y, t2.y)), min(t1.z, t2.z));
    let tf = min(min(max(t1.x, t2.x), max(t1.y, t2.y)), max(t1.z, t2.z));
    var used = 0; var hit = false;
    if (tf >= max(tn, 0.0)) {
      var t = max(tn, 0.02); let bound = min(far, tf);
      for (var i = 0; i < 96; i = i + 1) {
        used = i + 1;
        let f = sdfScene(ro + dir * t);
        let eps = max(max(0.0009, 0.0014 * t), 2.0 * fovScale * t / max(res.y, 1.0));
        if (abs(f.d) < eps && f.col >= 0.0) { hit = true; break; }
        t = t + max(abs(f.d), 0.0008);
        if (t >= bound) { break; }
      }
    }
    let fr = clamp(f32(used) / 96.0, 0.0, 1.0);
    if (hit) { return vec4<f32>(0.0, 1.0 - fr, fr, 1.0); }   // piece: green->cyan with steps
    return vec4<f32>(fr, 0.0, 0.0, 1.0);                      // no piece: red brightness = steps
  }

  // 1 sample/pixel: the dominant frame cost was the 2nd supersample (~48% of GPU
  // time) for edge anti-aliasing only. The dropout fixes (cone-eps footprint + the
  // overlay cell-step clamp) hold at 1 spp, so the extra sample isn't needed for
  // correctness -- traded for ~2x framerate toward the real-time-1080p target.
  let SPP = 1;
  var col = vec3<f32>(0.0);
  for (var s = 0; s < SPP; s = s + 1) {
    let jitter = vec2<f32>(rand(), rand()) - 0.5;
    let pix = fragCoord.xy + jitter;
    let ndc = vec2<f32>((pix.x / res.x) * 2.0 - 1.0, 1.0 - (pix.y / res.y) * 2.0);
    let dir = normalize(
      G.camForward.xyz
      + G.camRight.xyz * (ndc.x * fovScale * aspect)
      + G.camUp.xyz    * (ndc.y * fovScale)
    );
    col = col + trace(G.camPos.xyz, dir);
  }
  col = col / f32(SPP);

  col = col / (col + vec3<f32>(1.0));        // Reinhard tone map
  col = pow(col, vec3<f32>(1.0 / 2.2));      // gamma
  return vec4<f32>(col, 1.0);
}
