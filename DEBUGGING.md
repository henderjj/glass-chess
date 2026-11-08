# Debugging the WebGPU renderer

Notes from chasing the chess-animation "pieces drop out / only heads visible" bug. Read alongside [CLAUDE.md](CLAUDE.md) ("How to verify changes"). The headline lesson: **WGSL can't be compiled or rendered in the agent shell, but you do NOT have to debug it blind — build a CPU reference renderer and a headless GPU harness, then capture and replay the exact failing state.**

## The tools (all in `tools/`)

| Tool | What it is | Run |
|------|------------|-----|
| `debug-render.mjs` | **CPU (f64) reference renderer.** Ports `sdfScene` + `marchPieces` + the overlay to plain JS and rasterises the primary-hit colours (green = piece, blue = board, red = sky/miss). Renders the start position, several real plies, low-angle views, and (if present) replays `state-dump.json`. | `node tools/debug-render.mjs` → `debug-*.png` |
| `wgpu-harness.mjs` | **Deno headless WebGPU runner.** Loads the *real* `shaders/chess.wgsl`, builds the same pipeline/buffers as the browser, renders to PNGs. Replays `state-dump.json` exactly (camera + board + overlay) and can vary resolution / camera / overlay count. This runs the actual shader on the GPU. | `deno run -A --unstable-webgpu tools/wgpu-harness.mjs` → `gpu-*.png` |
| `profile-svg.mjs` | Piece-SDF profile rasteriser (shape review, pre-existing). | `node tools/profile-svg.mjs` |

The GPU tools need [Deno](https://deno.com/) (it has WebGPU built in and renders headlessly on the GPU, with no canvas or surface). Install it from <https://docs.deno.com/runtime/getting_started/installation/>, e.g. `winget install DenoLand.Deno` on Windows. The Node tools need `npm ci` in `tools/` first.

### In-browser debug aids (kept in the shader / engine)
- **`d`** — dumps the exact current state to the console as `STATE_DUMP {...}` (camera az/el/dist/target, the board + overlay buffers actually uploaded, ply, overlay count).
- **`4`** — primary-hit false-colour view: green = piece, blue = board, red = sky.
- **`5`** — march-iteration heatmap (red brightness = steps used on a miss).

These are toggled via debug bits in `options.z` (bits 8 and 16). Bits 1/2/4 still disable shadows/reflections/refraction for GPU-ms profiling.

## The capture-and-replay loop (this is what cracked it)

1. In the browser, reproduce the bug, then press **`d`**.
2. Copy the console's `STATE_DUMP {...}` JSON into `tools/state-dump.json`.
3. `deno run -A --unstable-webgpu tools/wgpu-harness.mjs` → it replays *those exact bytes* through the real shader on the GPU and writes `gpu-dump-*.png`.
4. View the PNGs, change ONE thing in the shader, re-run, compare. No more screenshot round-trips with the user.

Run the same dump through `debug-render.mjs` (CPU/f64) to compare against the GPU (f32) output — divergence between them localises the problem class.

## Postmortem: the "only heads" piece-dropout bug

**Symptom:** during the animation, piece *bodies* vanished (you saw the board behind them) while the *heads* stayed; worse at some camera angles, and obvious in the single-sample debug/heatmap views.

**Actual root cause:** **under-sampling / aliasing.** At the default camera distance the slim lower piece bodies shrink toward sub-pixel size on screen; a single march ray per pixel slips *between* the thin body and the board and falls through → the body renders as board. Heads survive because they're fatter (exact spheres).

**The fix (one line, in `marchPieces`):** cone-trace the hit threshold — `eps = max(0.0009, 0.0014*t, 2*fovScale*t / resolution.y)`. The pixel-footprint term catches sub-pixel features at any resolution, stays crisp up close and at high res, costs nothing, and also helps grazing angles (large `t` → large footprint).

**Dead ends (do not repeat these):**
- Lowering the march under-scale factor (0.9 → 0.6 → 0.5) — just moved the artifact (tops → stems → ring stripes) and tanked perf to 30–50 ms.
- Raising the iteration budget (96 → 160 → 256 → 384).
- Widening the broad-phase reject boxes and the march AABB.
- Disabling the broad-phase reject entirely.
- An adaptive slope-limited (probe-ahead) march — still cut pieces, and slow.
- Reducing `smin` blend radii — the smin field is already conservative; not the cause.

**Why it took so long / the trap:** the CPU **f64** reference renderer *always* showed full pieces, which made it look like a "GPU f32 precision bug." f64 is simply too forgiving to exhibit the aliasing. The real diagnosis came from replaying the **same** state through the GPU harness at **low vs high resolution**: low dropped the bodies, high was full ⇒ resolution-dependent ⇒ sampling/aliasing, not precision.

## Lessons for next time

- **Reproduce before fixing.** A bug you can't reproduce in a tool, you're fixing blind. Build the reproduction (CPU renderer, GPU harness) *first*.
- **Capture the exact state, don't guess it.** The `d`-dump → `state-dump.json` → harness replay removed all guessing about camera/board/overlay.
- **Change one variable at a time** and re-render; let the image decide, not a theory.
- **A CPU f64 reference proves the *logic*, not precision/aliasing/GPU behaviour.** When CPU is clean but the GPU isn't, suspect f32, the compiler, *or sampling* — and test at multiple resolutions.
- The **iteration heatmap** distinguishes "ran out of budget" (bright) from "concluded empty fast / sampling miss" (dark).
- WGSL surfaces compile errors on the page (`getCompilationInfo`) and in the Deno harness (which prints `Ln: message` and exits) — use the harness to catch shader syntax errors without a browser.
