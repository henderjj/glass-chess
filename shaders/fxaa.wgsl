// ============================================================================
//  FXAA 3.11-style luma edge anti-aliasing, run as a fullscreen post-pass over the
//  scene texture. Applied EVERY frame (moving or still) so the image is consistent
//  — it smooths piece silhouettes / high-contrast edges the 1-spp trace leaves
//  jagged. (The board checker is filtered analytically in chess.wgsl instead, since
//  FXAA can't fix sub-pixel pattern aliasing.)
// ============================================================================

@group(0) @binding(0) var sceneTex : texture_2d<f32>;
@group(0) @binding(1) var samp     : sampler;

@vertex
fn vs(@builtin(vertex_index) vi : u32) -> @builtin(position) vec4<f32> {
  var p = array<vec2<f32>, 3>(
    vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0),
  );
  return vec4<f32>(p[vi], 0.0, 1.0);
}

fn luma(c : vec3<f32>) -> f32 { return dot(c, vec3<f32>(0.299, 0.587, 0.114)); }

// Tuning: skip pixels whose local contrast is below the threshold (leaves flat
// areas untouched), then blend along the detected edge direction.
const EDGE_THRESHOLD     : f32 = 0.125;    // relative contrast to treat as an edge
const EDGE_THRESHOLD_MIN : f32 = 0.0625;   // absolute floor (dark regions)
const SPAN_MAX           : f32 = 8.0;      // max blur reach (texels)
const REDUCE_MUL         : f32 = 0.125;    // 1/8
const REDUCE_MIN         : f32 = 0.0078125; // 1/128

@fragment
fn fs(@builtin(position) fragCoord : vec4<f32>) -> @location(0) vec4<f32> {
  let inv = 1.0 / vec2<f32>(textureDimensions(sceneTex));
  let uv  = fragCoord.xy * inv;

  let rgbM  = textureSampleLevel(sceneTex, samp, uv, 0.0).rgb;
  let rgbNW = textureSampleLevel(sceneTex, samp, uv + vec2<f32>(-1.0, -1.0) * inv, 0.0).rgb;
  let rgbNE = textureSampleLevel(sceneTex, samp, uv + vec2<f32>( 1.0, -1.0) * inv, 0.0).rgb;
  let rgbSW = textureSampleLevel(sceneTex, samp, uv + vec2<f32>(-1.0,  1.0) * inv, 0.0).rgb;
  let rgbSE = textureSampleLevel(sceneTex, samp, uv + vec2<f32>( 1.0,  1.0) * inv, 0.0).rgb;

  let lM  = luma(rgbM);
  let lNW = luma(rgbNW);
  let lNE = luma(rgbNE);
  let lSW = luma(rgbSW);
  let lSE = luma(rgbSE);
  let lMin = min(lM, min(min(lNW, lNE), min(lSW, lSE)));
  let lMax = max(lM, max(max(lNW, lNE), max(lSW, lSE)));

  // Flat enough -> leave the pixel exactly as it is (no softening of detail).
  if ((lMax - lMin) < max(EDGE_THRESHOLD_MIN, lMax * EDGE_THRESHOLD)) {
    return vec4<f32>(rgbM, 1.0);
  }

  // Edge direction from the corner luma gradient.
  var dir = vec2<f32>(
    -((lNW + lNE) - (lSW + lSE)),
     ((lNW + lSW) - (lNE + lSE)),
  );
  let dirReduce = max((lNW + lNE + lSW + lSE) * 0.25 * REDUCE_MUL, REDUCE_MIN);
  let rcpDirMin = 1.0 / (min(abs(dir.x), abs(dir.y)) + dirReduce);
  dir = clamp(dir * rcpDirMin, vec2<f32>(-SPAN_MAX), vec2<f32>(SPAN_MAX)) * inv;

  // Two-tap (rgbA) and four-tap (rgbB) blends along the edge; rgbB is sharper but
  // is rejected (fall back to rgbA) if it strays outside the local luma range.
  let rgbA = 0.5 * (
    textureSampleLevel(sceneTex, samp, uv + dir * (1.0 / 3.0 - 0.5), 0.0).rgb +
    textureSampleLevel(sceneTex, samp, uv + dir * (2.0 / 3.0 - 0.5), 0.0).rgb);
  let rgbB = rgbA * 0.5 + 0.25 * (
    textureSampleLevel(sceneTex, samp, uv + dir * -0.5, 0.0).rgb +
    textureSampleLevel(sceneTex, samp, uv + dir *  0.5, 0.0).rgb);

  let lB = luma(rgbB);
  if (lB < lMin || lB > lMax) { return vec4<f32>(rgbA, 1.0); }
  return vec4<f32>(rgbB, 1.0);
}
