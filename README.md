# GlassChess

**A WebGPU ray tracing tech demo: a coloured-glass chess set rendered in real
time in the browser.**

**[▶ Try the live demo](https://henderjj.github.io/glass-chess/)**

GlassChess is an experiment in how far real-time ray tracing can go in a web
page, using nothing but a WebGPU fragment shader. It recreates the look of
90s POV-Ray renders (glass refraction, mirror reflections, soft shadows and
Beer's-law colour absorption) without hardware ray tracing cores, a game engine,
or a build step.

The chess is there to give the renderer something interesting to draw: famous
games play themselves out on the board, or you can play a casual game against
a simple built-in AI.

> **Status: tech demo.** This is an experiment, not a finished game. Expect
> rough edges, developer debug keys, and performance that varies a lot with
> your GPU. It was built as an exploration with the help of Claude.

## Requirements

- A browser with **WebGPU** enabled. Developed and tested on desktop
  **Chrome and Edge** (113 or later). Other WebGPU browsers may work but are
  untested.
- A reasonably capable GPU. The target was 1080p in real time on an RTX 3080;
  integrated graphics will run, but slowly. Use `-` / `=` to change the render
  resolution.

## How the renderer works

The whole scene is traced per pixel in a single fullscreen fragment shader
([`shaders/chess.wgsl`](shaders/chess.wgsl)).

- **Whitted-style ray tracing.** Each pixel fires one primary ray, then follows
  reflection, refraction and shadow rays. This is classic recursive ray tracing
  rather than Monte Carlo path tracing: there is no random sampling and no
  noise, so moving and still frames look identical.
- **No recursion, so an explicit ray stack.** WGSL has no recursive functions,
  so tracing is an iterative loop over a small stack of ray segments. A glass
  hit pushes both a reflected and a refracted branch, weighted by Schlick's
  Fresnel approximation, and branches that contribute too little are culled.
- **Analytic board, ray-marched pieces.** The board is an analytic plane. The
  pieces are **signed distance fields** (solids of revolution plus a few boolean
  operations) that are sphere-traced. A 3×3 per-cell broad phase skips the
  expensive piece SDFs for empty parts of the board.
- **Coloured glass.** Amber and violet glass use Beer's-law absorption, so
  thicker glass reads as deeper colour. Rays starting inside a piece march by
  `abs(distance)` to find the exit surface.
- **Anti-aliasing without temporal tricks.** The board's checker pattern is
  analytically box-filtered over each pixel's footprint, and an FXAA post-pass
  ([`shaders/fxaa.wgsl`](shaders/fxaa.wgsl)) smooths silhouette edges.
- **Render on demand.** Frames are only drawn while something changes, so a
  still scene costs almost no GPU time.

Why not hardware ray tracing? RT cores accelerate ray-versus-triangle tests,
but this scene has no triangles: it is made of analytic shapes and distance
fields, the same way 90s ray tracers worked. Browsers do not expose RT cores
anyway.

## Using the demo

The panel at the top right switches between **Watch** and **Play**.

- **Watch** replays famous games. Pick one from the list and press
  **▶ Play game**. Step with ⏮ / ⏭, restart with ↺, and change speed with the
  ×1 / ×2 / ×3 button (or `F`).
- **Play** starts a game against the built-in AI. Choose your side and a
  difficulty, click a piece to see its legal moves, then click a square to move.

**Settings** (in the panel) has live controls for the glass colours, shadow
softness and move glow.

| Input | Action |
|---|---|
| Drag / mouse wheel | Orbit / zoom |
| Arrow keys | Pan the camera |
| `A` | Auto-rotate |
| `I` | Inspect mode (one of each piece, side on) |
| `G` | Play / pause the Watch game |
| `Space` | Pause rendering |
| `-` / `=` | Lower / raise render resolution |
| `R` | Reset camera |
| `6` | Toggle FXAA |
| `` ` `` | Show the performance overlay (fps, GPU time) |
| `1` / `2` / `3` | Toggle shadows / reflections / refraction (for profiling) |
| `4` / `5` | Debug views: primary-hit colours / march-step heatmap |
| `D` | Dump the current render state to the console (see [DEBUGGING.md](DEBUGGING.md)) |

## Running locally

There is no build step. The app is plain ES modules plus WGSL shaders loaded
with `fetch`, so it must be served over HTTP rather than opened as a file.

```sh
git clone https://github.com/henderjj/glass-chess.git
cd glass-chess
python -m http.server 8000    # or: npx serve .   (Windows: serve.bat)
```

Then open <http://localhost:8000/>.

## Deployment

The site is hosted on **GitHub Pages** and deployed by GitHub Actions
([`.github/workflows/pages.yml`](.github/workflows/pages.yml)):

- Every pull request runs the checks: a dependency audit, a JavaScript syntax
  check, a check that the vendored chess.js and the generated game data are up
  to date, and the unit tests.
- Every push to `main` runs the same checks, then copies only the runtime files
  (`index.html`, `src/`, `shaders/`) into the Pages artifact and deploys it.
  Docs, dev tools and debug helpers are never published.

To deploy a fork, enable Pages under **Settings → Pages** and set the source to
**GitHub Actions**.

## Project layout

```
index.html             the app: canvas, HUD and controls
src/chess-main.js      engine: WebGPU setup, camera, render loop, input, Watch and Play modes
src/chess-scene.js     starting position and scene parameters
src/chess-game.js      GENERATED move data for Watch mode (from tools/gen-games.mjs)
src/chess-ai.js        the Play-mode AI, run in src/chess-ai.worker.js
src/vendor/chess.js    vendored chess.js rules engine (imported directly, no bundler)
shaders/chess.wgsl     the ray tracer: piece SDFs, board, glass, highlights
shaders/fxaa.wgsl      FXAA anti-aliasing post-pass
knight-editor.html     dev tool for tracing the knight's 2D profile
tools/                 Node and Deno dev tooling (not deployed)
```

## Development tools

The tools in `tools/` are for development only. Install their one dependency
first:

```sh
cd tools
npm ci
npm test               # AI unit tests + replay check of the Watch games
```

| Script | Runtime | Purpose |
|---|---|---|
| `gen-games.mjs` | Node | Regenerates `src/chess-game.js` from SAN move lists, validating every move with chess.js (`npm run gen-games`). |
| `verify-games.mjs` | Node | Replays the generated games through the app's own move logic and checks the final positions against chess.js. |
| `test-ai.mjs` | Node | Unit tests for the Play-mode AI. |
| `profile-svg.mjs` | Node | Renders the piece SDF profiles to PNG/SVG for checking shapes without a browser (`npm run profiles`). |
| `debug-render.mjs` | Node | CPU reference renderer for primary-hit debugging. |
| `wgpu-harness.mjs` | [Deno](https://deno.com/) | Runs the real WGSL shader headlessly on the GPU and writes PNGs. |
| `perf-bench.mjs` | Deno | Headless GPU benchmark of shader variants. |

The Deno tools run with `deno run -A --unstable-webgpu tools/<script>.mjs`.
[DEBUGGING.md](DEBUGGING.md) describes the capture-and-replay workflow they
support, and [CLAUDE.md](CLAUDE.md) holds detailed architecture notes.

## License

GlassChess is released under the [MIT License](LICENSE).
© 2026 John Henderson.

### Third-party components

- **[chess.js](https://github.com/jhlywa/chess.js)** 1.4.0 by Jeff Hlywa is
  vendored at `src/vendor/chess.js` and is also a dev dependency of `tools/`.
  It is licensed under the BSD 2-Clause License, and its copyright and license
  notice is kept in the vendored file.
- The games replayed in Watch mode are historical chess games. Move lists are
  facts and are not subject to copyright.
