# CLAUDE.md

Guidance for working in this repo. Read alongside `README.md` (user-facing).

## What this is
**GlassChess** — a browser WebGPU raytracer rendering a coloured-glass chess set. Whitted-style (reflection/refraction/shadows), recreating the 90s POV-Ray look with an analytic board plane + SDF ray marching in a fragment shader. No RTX/RT-core use; it's a software raytracer on the GPU. Target hardware: RTX 3080, real-time at 1080p. Two modes: **Watch** (animated playthrough of famous games) and **Play** (single-player vs a built-in AI). Forked from a combined sphere+chess "RaytraceDemo" repo — only the chess scene lives here.

## Environment / conventions
- The original author works on **Windows** and prefers **PowerShell** for shell commands; the Bash tool also works. Commands below are shell-neutral where possible.
- **No build step.** Plain ES modules + WGSL loaded via `fetch`. Must be served over HTTP (not `file://`): `python -m http.server 8000`. Open in Chrome/Edge 113+.
- **Hosting**: GitHub Pages, deployed by `.github/workflows/pages.yml` on every push to `main`. The workflow copies only `index.html`, `src/` and `shaders/` into the Pages artifact, so anything else (tools, docs, `knight-editor.html`) never ships. If you add a runtime file outside those paths, add it to the workflow's copy step. Use relative URLs only: the site is served from a sub-path (`/glass-chess/`).
- **CI** (same workflow, also on pull requests) runs from `tools/`: `npm ci`, `npm audit`, `node --check` on all JS, a diff of `src/vendor/chess.js` against the locked npm package, a regenerate-and-diff of `src/chess-game.js`, and `npm test` (AI tests + `verify-games.mjs`). Keep these green.

## How to verify changes
- **Shader (WGSL)** compile errors surface on-screen via `getCompilationInfo()` (an error banner instead of a blank canvas) — Ctrl+F5 (the `.wgsl` is fetched and may be cached) and ask the user to report. **Better: the Deno headless WebGPU harness compiles AND renders the real shader to PNG** (`tools/wgpu-harness.mjs`; the Read tool can view the PNG) — the primary way to check shader/geometry changes without a browser (incl. env modes `TOPPLE`/`FXAA`/`HIGHLIGHT` for those features).
- **For chess piece geometry, use the profile tool** (see below) — it renders profiles to PNG, which the Read tool *can* view. Iterate there, then port to the shader.
- After editing JS, syntax-check: `node --check <file>`; run `npm test` in `tools/`.

## Architecture
The app is: `index.html` (canvas + HUD + controls) · `src/chess-main.js` (engine) · `src/chess-scene.js` (board/scene data) · `src/chess-game.js` (GENERATED move data for the Watch playthrough) · `shaders/chess.wgsl` (renderer) + `shaders/fxaa.wgsl` (edge-AA post-pass). The **Play** mode adds `src/vendor/chess.js` (vendored rules engine) + `src/chess-ai.js` + `src/chess-ai.worker.js` (the AI). See the per-feature sections below.

Engine (`chess-main.js`) responsibilities:
- WebGPU init, pipeline(s), a uniform "globals" buffer + storage buffers (board, animation overlay, board highlights), orbit camera, input.
- **Render-on-demand loop**: draws only when dirty or animating, else idles at ~0 GPU. `requestRender()` wakes it; HUD shows `fps`/`idle`/`paused`.
- **Globals buffer packing must match the WGSL `struct Globals` exactly** (vec4 lanes, 16-byte alignment). If you add a uniform, update both the JS `Float32Array` offsets/size and the WGSL struct.

## Rendering technique (`shaders/chess.wgsl`)
- **No recursion in WGSL** → tracing is an iterative loop over an explicit **ray stack** (`array<RaySeg, N>`). Glass pushes both a reflected and a refracted segment; throughput culls negligible rays.
- **Hybrid intersection**: the analytic board plane merged with **SDF ray marching** of the pieces (`sdfScene`), taking the nearer hit; a per-cell 3×3 grid broad-phase bounds the march so empty regions are skipped.
- **Glass from inside**: marching steps by `abs(distance)` so a refraction ray starting inside a solid converges to the exit wall. Glass surfaces use Schlick Fresnel to split reflect/refract.
- **Chess colour**: Beer's-law absorption carried as a per-segment `absorb` term on the ray stack; applied as `exp(-absorb * t)` over each segment's length.

## Performance & quality
- **No quality shift between static and dynamic views.** Don't trade image quality for framerate while the camera moves — no dropping resolution, SPP, or shadow samples during interaction, and no progressive/temporal accumulation that visibly refines only once the view settles. A moving frame and a settled frame should look the same. Prefer optimisations that lower the cost of a *fixed* quality level for both (cheaper shadows, lower register pressure, tighter broad-phase, fewer SDF evals). Only deviate where keeping parity is genuinely unavoidable or impractical — and call it out when you do.
- **Anti-aliasing (chess), all per-frame so moving == still:** the trace is 1 spp, so AA is done two ways, both applied every frame (NOT temporal/idle-only): (1) the **board checker is analytically box-filtered** over the pixel footprint in `boardAlbedo` (footprint = `2*fovScale*t/H / |rd.y|`), so distant squares average to grey instead of shimmering — fixes pattern/Moiré aliasing FXAA can't; (2) an **FXAA post-pass** (`shaders/fxaa.wgsl`) smooths silhouette edges. The frame is now **two passes**: the scene renders into an offscreen texture, then FXAA resolves it to the swapchain (`chess-main.js`). Key **6** toggles FXAA (HUD shows `off: fxaa`); it auto-disables for the key-4/5 debug views so those stay pixel-exact. `MSAA does not apply` here (one fullscreen triangle, no rasterized edges). The reported `GPU: N ms` times the **scene pass only**.
- **GPU profiling**: the HUD shows real render-pass time via WebGPU `timestamp-query` (`GPU: N ms`), separate from the vsync/idle-affected `fps`. Keys `1`/`2`/`3` flip debug bits in `options.z` to disable shadows / reflections / refraction, so you can A/B the GPU-ms delta and attribute cost in the single fullscreen pass. Hold auto-rotate (`A`) for a continuous, stable reading (render-on-demand only samples drawn frames). Debug flags = 0 means everything on (normal render); the toggles are measurement-only.

## Chess specifics (`shaders/chess.wgsl`)
- Board is a `array<vec4<f32>,16>` storage buffer = 64 cells (`rank*8+file`). Cell value: 0 empty, 1–6 white, 11–16 black (type = pawn..king). Built in `src/chess-scene.js` (`buildStartPosition`, `buildShowcase`).
- **Grid broad-phase**: `sdfScene` checks the 3×3 cells around the sample point (a piece can be the nearest surface from an adjacent cell), but skips the expensive per-piece SDF for any cell whose bounding box is already farther than the best hit so far — so cost stays close to evaluating one piece while the result is identical to checking all 9. NB: a "single-cell + `cellStep` DDA" variant was tried and looked faster, but it cropped pieces at certain camera angles (clean cell-boundary planes). Keep the full 3×3 coverage.
- Pieces are SDFs: a shared `base()` (flared foot → cove) plus per-piece `sdPawn/sdRook/sdBishop/sdKnight/sdQueen/sdKing`. Heights/widths are tuned to canonical Staunton ratios (P<R<N<B<Q<K).
- **Knight** = 2D outline (`knightProfile`, a polygon SDF) **extruded** into a slab. Thickness *tapers* with height (`mix(0.115, 0.05, smoothstep(...))`) so the round neck meets the turned base/collar with no protruding disc, narrowing to a flat head. The shader negates `p.z` in the profile lookup so board knights face the opponent.

## Chess game playthrough data — `src/chess-game.js` (GENERATED)
- `src/chess-game.js` (the `GAMES` array of famous games) is **generated** by `tools/gen-games.mjs` — **do not hand-edit it.** To add/change a game, edit the SAN move list in `gen-games.mjs` and re-run `node tools/gen-games.mjs`.
- The generator replays each game's SAN through **chess.js** (a dev dependency in `tools/package.json`; the browser app uses its own vendored copy, not this one) to extract exact from/to squares and flags. Each game carries `result` ("1-0"/"0-1") and `ending`: **checkmate** (asserted to be the final ply) or **resignation** (non-mate games — the source must give an explicit decisive `result`, since chess.js can't know who resigned).
- Special moves are encoded explicitly so the runtime needs no chess logic: `castle` (king+rook sub-moves), `ep: "<square>"` (en passant — the captured pawn is on that square, *not* the destination, so occupancy alone misses it), and `promo: <2..5>` (promotion type N/B/R/Q; the pawn becomes that piece on arrival, with a gold flourish). `applyPlyTo`/`startAnim` in `chess-main.js` handle all four. Ordinary captures are still detected by destination occupancy.
- `tools/verify-games.mjs` is an end-to-end check: it replays the generated plies through the project's own `applyPlyTo` + `rank*8+file` encoding and confirms the final position matches an independent chess.js replay (and that overlay-slot pressure stays ≤ 8). It also has a synthetic ep+promotion unit test (no famous game in the set ends *by* promotion). Run after regenerating.
- The engine binds to one `activeGame` (default `GAMES[0]`); the `#g-select` dropdown (in the Watch panel) switches it via `selectGame()`, which resets to that game's start. `OPERA_GAME` is kept as a `GAMES[0]` alias for compatibility.
- **Resignation end-state** (when `activeGame.ending === "resignation"`): after the final move, `game.endClock` drives a tableau (in `computeResignOutputs` + the glass-dim in `drawFrame`) — the losing king **topples** (overlay tilt), its army **dims** (extra glass absorption on the losing side), and the winning king glows gold. It animates for `RESIGN.dur` then rests (orbitable). Checkmate games keep the existing per-ply mate flourish. The king tips over its base **rim** (not centre, so the foot stays on the board) along the **inward 45° diagonal** (`computeResignOutputs` picks the direction toward board centre) so it never clips off an edge; the shader yaws that direction to its canonical topple axis.
- **Overlay buffer is 3 vec4 per slot** (was 2): `(pos,code)·(emissive,scale)· (tilt, dirX, dirZ, 0)`. The tilt (radians) topples a piece about its base rim in the shader, toward the horizontal world direction `(dirX,dirZ)`. Keep these in lockstep: WGSL `overlay : array<vec4<f32>, 24>` + `overlay[3*k…]`, JS `overlayData`(96)/`overlayBuf`(96·4)/`pushOverlay`, and the Deno `wgpu-harness.mjs`/`perf-bench.mjs` `packOverlay`/buffer sizes.
- **Verify a shader/overlay change headlessly**: `TOPPLE=1 deno run -A --unstable-webgpu tools/wgpu-harness.mjs` renders a toppled + upright king to `topple-test*.png`; `FXAA=1 …` renders `fxaa-off/on.png` crops to A/B the edge AA (the Read tool can view them). Both are throwaway — delete after.

## Single-player mode (Play)
A **Watch / Play** toggle at the top of `#controls` switches between the scripted playthrough (Watch) and an interactive game vs a built-in AI (Play). Play mode reuses the board buffer, the overlay move-animation, the camera, and the checkmate/resignation end-states — driven from live moves instead of a ply list.
- **Rules**: the **vendored** `src/vendor/chess.js` (chess.js 1.4.0 ESM, BSD-2-Clause, no build step) is the authority. The `play` controller in `chess-main.js` holds a `Chess` instance that stays one move AHEAD of the animated `game.board` during a glide; `plyFromMove()` turns a chess.js move into the same ply shape the animator/ `applyPlyTo` use. `game.playMode` distinguishes it from the scripted playthrough; `startAnim(ply, whiteMoved, idx)` is shared by both. To re-vendor chess.js after a bump: `cp tools/node_modules/chess.js/dist/esm/chess.js src/vendor/chess.js` (CI fails if the two differ) and update the version in `README.md`.
- **AI**: `src/chess-ai.js` (`chooseMove(fen, difficulty)`: easy = 1-ply greedy, medium = αβ depth 3, hard = iterative deepening to depth 4 / ~2.5s; material + piece-square eval) runs in `src/chess-ai.worker.js` (a module Web Worker) so the raytrace view stays smooth. `tools/test-ai.mjs` unit-tests it under Node.
- **Input**: click-to-move. A left mouse press that doesn't drag (`dragMoved < 5`) is a pick; `pickSquare()` ray-casts the click through the y=0 plane to a square.
- **Camera**: New game animates the view to a traditional behind-your-pieces perspective (`tweenCameraTo(playView())` — White from −z/azimuth π, Black from +z/azimuth 0; eased shortest-path tween run from the frame loop). `R` re-centres there in Play mode.
- **Highlights**: a 4th storage buffer (`@binding(3)`, 64 cells) carries per-cell codes (1 selected · 2 legal move · 3 legal capture · 4 last move · 5 king in check); the board branch in `chess.wgsl` draws ring/dot/fill markers. **Lockstep** like the overlay: `chess-main.js` bind layout+group+`highlightData`, plus `wgpu-harness.mjs` + `perf-bench.mjs` (else their pipelines fail to build). Zero outside Play mode. Verify markers headlessly: `HIGHLIGHT=1 deno run -A --unstable-webgpu tools/wgpu-harness.mjs` -> `highlight-test.png`.
- **End-states** reuse the shared FX via `game.ending`/`game.result` (now set in BOTH modes): checkmate -> mate flourish; resign -> king topple; draw -> HUD only.

## Profile tool — `tools/profile-svg.mjs`
Ports the **exact** chess SDFs to JS and rasterizes their profiles: `node tools/profile-svg.mjs` → `profiles.png`/`.svg` (lineup, with measured heights/widths printed) and `knight-zoom.png` (two-view close-up: Z-Y profile + X-Y cross-section, for catching out-of-plane issues).
- **The tool must stay in sync with `shaders/chess.wgsl`.** When you change a piece SDF, change both.
- **Orientation convention**: the tool draws pieces facing **−z** (matching a left-facing reference, for easy comparison); the shader negates `z` so board pieces face their opponent. Same silhouette, mirrored — fine for shape checks.

## Editing piece profiles
`knight-editor.html` is an interactive editor: load a reference image with its file picker as a backdrop (none is bundled); drag/add/delete polygon points to trace an outline; it outputs a `[z, y]` array. Workflow: trace → copy array → it gets **uniformly scaled, centred, and seated** on the base, then pasted into both `KNIGHT_PTS` (tool) and `knightProfile` (shader, with z negated).

## Gotchas
- Keep `shaders/*.wgsl` struct layouts and the JS buffer packing in lock-step.
- `PIECE_MAX_H` in `chess.wgsl` must cover the tallest piece (king ≈ 1.08) — used to bound the march.
- `profiles.png`, `profiles.svg`, `knight-zoom.png` and the harness `debug-*`/`gpu-*` PNGs are generated (gitignored). Don't commit images unless you have the rights to publish them.
