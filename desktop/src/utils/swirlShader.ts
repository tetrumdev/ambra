import {
  COVER_EDGE_ZONES,
  type CoverSeparation,
} from "./backgroundPalette";
import { SWIRL_SHARPNESS, swirlBiases } from "./swirlProportions";
import { SURFACE_BLACK } from "./surfaceBlack";
import { perceptualColor, perceptualColorShader } from "./perceptualColor";

/**
 * The cover-colored swirl behind the player: its shaders and the palette it is drawn from.
 * Shared by the desktop bigscreen (components/FluidGradientBackground) and the phone remote
 * (mobile/), which draw it with WebGL and expo-gl respectively.
 */

/** WebGL 1 or 2: the browser's canvas or expo-gl's context. */
export type SwirlGL = WebGLRenderingContextBase & WebGLRenderingContextOverloads;

export const COLOR_TRANSITION_MS = 1800;
export const EDGE_COMPONENTS = COVER_EDGE_ZONES * 4;
/** Appended after the existing palette, luminance, direction and bias components. */
export const EDGE_COLORS_OFFSET = 16 + EDGE_COMPONENTS * 2;
export const NOISE_TEXTURE_SIZE = 256;
// The field drifts far too slowly for frames beyond 60 fps to differ, so
// high-refresh displays draw every other frame instead of doubling the work.
export const MIN_FRAME_INTERVAL_MS = 1000 / 60 - 2;
/** Time constant for the swirl easing between still and full speed. */
export const SWIRL_EASE_SECONDS = 0.9;

export const vertexShaderSource = `
attribute vec2 a_position;

void main() {
  gl_Position = vec4(a_position, 0.0, 1.0);
}
`;

export const fragmentShaderSource = `
precision highp float;

uniform vec2 u_resolution;
uniform float u_time;
uniform highp sampler2D u_noise;
uniform vec3 u_colors[4];
// Shifts each field so its color covers about its share of the cover (see swirlProportions.ts).
uniform vec4 u_bias;
uniform vec4 u_cover;
uniform float u_coverDim;
// Per zone along the cover's sides (top, right, bottom, left per entry).
uniform vec4 u_edgeLuma[${COVER_EDGE_ZONES}];
uniform vec4 u_edgeDirection[${COVER_EDGE_ZONES}];
// Edge colors and lightness arrive in Oklab, converted once when the palette changes.
uniform vec3 u_edgeColors[${COVER_EDGE_ZONES * 4}];

${perceptualColorShader}

float noise(vec2 point) {
  vec2 cell = floor(point);
  vec2 local = fract(point);
  vec2 smoothLocal = local * local * local * (local * (local * 6.0 - 15.0) + 10.0);

  // Shared lattice values stay identical across cell boundaries and GPU backends.
  // Fetch texel centres and interpolate in high precision: hardware filtering can
  // quantize slow movement, which repeated domain warps amplify into contour jumps.
  vec2 uv = (mod(cell, ${NOISE_TEXTURE_SIZE}.0) + 0.5) / ${NOISE_TEXTURE_SIZE}.0;
  vec2 texel = vec2(1.0 / ${NOISE_TEXTURE_SIZE}.0, 0.0);
  return mix(
    mix(texture2D(u_noise, uv).r, texture2D(u_noise, uv + texel.xy).r, smoothLocal.x),
    mix(texture2D(u_noise, uv + texel.yx).r, texture2D(u_noise, uv + texel.xx).r, smoothLocal.x),
    smoothLocal.y
  );
}

float fbm(vec2 point) {
  float value = 0.0;
  float amplitude = 0.5;
  mat2 turn = mat2(0.80, -0.60, 0.60, 0.80);
  for (int octave = 0; octave < 5; octave++) {
    value += amplitude * noise(point);
    point = turn * point * 2.03 + 7.13;
    amplitude *= 0.5;
  }
  return value;
}

// Lifts or deepens the field right around the cover wherever it would
// otherwise come close to the cover's own edge, so the art never sits flush. Each side
// is measured in zones and blended between zone centers, so the treatment
// follows the cover's edge rather than one average per side.
vec3 separateFromCover(vec3 color) {
  if (u_cover.z <= 0.0) return color;
  vec2 offset = gl_FragCoord.xy - u_cover.xy;
  vec2 outside = abs(offset) - u_cover.z;
  float gap = length(max(outside, 0.0));
  // A narrow strip ends close enough to the cover to read as a ring around it.
  // Keep full strength at the boundary, where the separation is read, then let
  // it thin out over a long, soft tail so it fades into the field unnoticed.
  float reach = min(u_cover.w, max(24.0, u_cover.z * 0.3));
  float nearby = 1.0 - smoothstep(0.0, reach, gap);
  nearby *= nearby;
  // The artwork covers the interior; only visible pixels outside its edge need this work.
  if (nearby <= 0.0 || max(outside.x, outside.y) < 0.0) return color;

  // Corners blend their two sides' edge measurements.
  // Use distances from the four edges, rather than rays from the cover's center.
  // The small overlap near corners makes the nearest two sides blend continuously.
  vec4 normal = vec4(offset.y, offset.x, -offset.y, -offset.x) - u_cover.z;
  vec4 side = smoothstep(vec4(-reach), vec4(0.0), normal)
    * exp(-max(normal, 0.0) * max(normal, 0.0) / (reach * reach));

  // Position along each side in zone units; top and bottom run left to right,
  // the sides top to bottom (cover image space, so GL's y is flipped).
  vec2 along = (vec2(offset.x, -offset.y) / u_cover.z + 1.0) * 0.5
    * ${COVER_EDGE_ZONES}.0 - 0.5;
  vec4 position = vec4(along, along);
  float correction = 0.0;
  vec4 total = vec4(0.0);
  // Compare what is seen: an overlay may darken the field but not the cover.
  vec3 visible = u_coverDim * clamp(color, 0.0, 1.0);
  vec3 linear = linearFromSrgb(visible);
  vec3 perceptual = perceptualFromLinear(linear);
  float luma = perceptual.x;
  float brightestChannel = max(max(linear.r, linear.g), linear.b);
  float lightnessLimit = luma > 0.0001
    ? luma * pow(linearFromSrgb(vec3(u_coverDim)).r / max(brightestChannel, 0.000001), 1.0 / 3.0)
    : pow(linearFromSrgb(vec3(u_coverDim)).r, 1.0 / 3.0);
  for (int zone = 0; zone < ${COVER_EDGE_ZONES}; zone++) {
    // Gaussian weights have no zone boundaries or flat joins. Test each real
    // sample first: interpolating black and cream must not invent a gray edge.
    vec4 distance = position - float(zone);
    vec4 weight = exp(-distance * distance / 0.85) * side;
    vec4 difference = vec4(luma) - u_edgeLuma[zone];
    vec4 colorDistance = vec4(
      length(perceptual.yz - u_edgeColors[zone * 4].yz),
      length(perceptual.yz - u_edgeColors[zone * 4 + 1].yz),
      length(perceptual.yz - u_edgeColors[zone * 4 + 2].yz),
      length(perceptual.yz - u_edgeColors[zone * 4 + 3].yz)
    );
    vec4 similar = (1.0 - smoothstep(vec4(0.07), vec4(0.12), abs(difference)))
      * (1.0 - smoothstep(vec4(0.025), vec4(0.065), colorDistance));
    // Follow the field's current contrast, not the palette's average brightness.
    // Only an almost identical shade needs the cover's preferred escape direction.
    // Keep that escape direction stable through a collision. Trying to brighten
    // saturated red just because the field is slightly lighter produces no separation.
    // At absolute black, a small perceptual delta can round back to a single
    // display level. Keep a modest visible floor for a genuinely matching edge.
    vec4 margin = max(vec4(0.07), 0.16 - u_edgeLuma[zone]);
    vec4 canLift = 1.0 - smoothstep(vec4(lightnessLimit - 0.002), vec4(lightnessLimit + 0.002), u_edgeLuma[zone] + margin);
    vec4 canDeepen = smoothstep(vec4(0.0), vec4(0.01), u_edgeLuma[zone] - margin);
    vec4 canFollow = mix(canDeepen, canLift, step(vec4(0.0), difference));
    vec4 direction = mix(sign(u_edgeDirection[zone]), sign(difference),
      smoothstep(vec4(0.012), vec4(0.04), abs(difference)) * canFollow);
    vec4 deficit = max(margin - direction * difference, 0.0);
    correction += dot(weight, similar * direction * deficit * abs(u_edgeDirection[zone]));
    total += weight;
  }

  // Keep existing contrast and gently separate similar colors. Bounded
  // adjustments preserve the moving field instead of forcing it to match
  // brightness targets from the stationary cover zones.
  // A lift is only needed when the edge nearly disappears into the field.
  // The wider shadow threshold must not leave a bright halo around distinct artwork.
  // Both lightening and darkening now require the same close color/luma match.
  float amount = nearby * correction / max(dot(total, vec4(1.0)), 0.0001);
  // Convert the visible correction back through the overlay, so the visible change matches the measured deficit.
  // A fixed five-level RGB limit was too weak for near-identical saturated colors.
  // Use the perceptual deficit instead, and scale linear RGB to retain the swirl's hue.
  if (abs(amount) < 0.000001) return color;
  // Retain part of the local field variation even at a matching edge, so the
  // needed separation does not replace the moving swirl with a flat fixed stripe.
  float lightness = clamp(luma + 0.85 * amount, 0.0, 1.0);
  vec3 separated = luma > 0.0001
    ? linear * pow(lightness / luma, 3.0)
    : vec3(lightness * lightness * lightness);
  return srgbFromLinear(separated) / max(u_coverDim, 0.05);
}

void main() {
  vec2 point = gl_FragCoord.xy / u_resolution.xy - 0.5;
  point.x *= u_resolution.x / max(u_resolution.y, 1.0);
  float time = u_time * 0.055;

  vec2 firstWarp = vec2(
    fbm(point * 1.15 + vec2(time, -time * 0.72)),
    fbm(point * 1.15 + vec2(4.3 - time * 0.61, 1.7 + time))
  );
  vec2 secondWarp = vec2(
    fbm(point * 1.8 + firstWarp * 1.7 + vec2(8.1, time * 0.46)),
    fbm(point * 1.8 + firstWarp * 1.7 + vec2(-2.4 - time * 0.4, 5.2))
  );
  vec2 fluidPoint = point + (firstWarp - 0.5) * 0.95 + (secondWarp - 0.5) * 0.4;

  vec4 fields = vec4(
    fbm(fluidPoint * 1.25 + vec2(0.0, time)),
    fbm(fluidPoint * 1.31 + vec2(5.7 + time * 0.7, -3.1)),
    fbm(fluidPoint * 1.18 + vec2(-4.2, 6.8 - time * 0.83)),
    fbm(fluidPoint * 1.38 + vec2(2.6 - time * 0.52, -7.4 + time * 0.35))
  );
  fields += u_bias;
  fields = exp((fields - max(max(fields.x, fields.y), max(fields.z, fields.w))) * ${SWIRL_SHARPNESS}.0);
  fields /= fields.x + fields.y + fields.z + fields.w;

  vec3 color = u_colors[0] * fields.x
    + u_colors[1] * fields.y
    + u_colors[2] * fields.z
    + u_colors[3] * fields.w;
  float luminance = dot(color, vec3(0.2126, 0.7152, 0.0722));
  color = mix(vec3(luminance), color, 1.18);
  color *= 0.84 + 0.22 * fbm(fluidPoint * 2.2 + secondWarp);
  // Fixed screen-space dithering breaks up 8-bit color contours without animated grain.
  float dither = texture2D(u_noise, gl_FragCoord.xy / ${NOISE_TEXTURE_SIZE}.0).r - 0.5;
  gl_FragColor = vec4(clamp(separateFromCover(color) + dither / 255.0, 0.0, 1.0), 1.0);
}
`;

export function createShader(
  gl: SwirlGL,
  type: number,
  source: string,
) {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (gl.getShaderParameter(shader, gl.COMPILE_STATUS)) return shader;
  console.warn("Could not compile fluid-gradient shader:", gl.getShaderInfoLog(shader));
  gl.deleteShader(shader);
  return null;
}

export function createNoiseTexture(gl: SwirlGL, seed: number) {
  const texture = gl.createTexture();
  if (!texture) return null;
  const pixels = new Uint8Array(NOISE_TEXTURE_SIZE * NOISE_TEXTURE_SIZE);
  let state = Math.floor(seed * 0x4000000) >>> 0;
  for (let index = 0; index < pixels.length; index++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    pixels[index] = state >>> 24;
  }
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, texture);
  // A power-of-two texture can repeat seamlessly in WebGL 1 without mipmaps.
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
  gl.texImage2D(
    gl.TEXTURE_2D, 0, gl.LUMINANCE, NOISE_TEXTURE_SIZE, NOISE_TEXTURE_SIZE,
    0, gl.LUMINANCE, gl.UNSIGNED_BYTE, pixels,
  );
  return texture;
}

function colorComponents(color: string) {
  const normalized = /^#[0-9a-f]{6}$/i.test(color) ? color.slice(1) : "000000";
  return [0, 2, 4].map(
    (offset) => Number.parseInt(normalized.slice(offset, offset + 2), 16) / 255,
  );
}

export function paletteComponents(
  colors: string[],
  weights: number[],
  separation: CoverSeparation,
) {
  const palette = colors.slice(0, 4);
  while (palette.length < 4) palette.push(palette[0] ?? SURFACE_BLACK);
  const edgeColors = separation.colors ?? separation.edges.flatMap(edge => [edge, edge, edge]);
  const perceptualEdges = Array.from({ length: EDGE_COMPONENTS }, (_, index) =>
    perceptualColor(edgeColors.slice(index * 3, index * 3 + 3)));
  // Transition colors, proportions and cover separation without changing the field's shape.
  return [
    ...palette.flatMap(colorComponents),
    ...perceptualEdges.map(edge => edge[0]),
    ...separation.directions,
    ...swirlBiases(weights),
    ...perceptualEdges.flat(),
  ];
}

export function mixPalette(from: number[], to: number[], progress: number) {
  return from.map((component, index) => (
    component + (to[index] - component) * progress
  ));
}

export function easedProgress(progress: number) {
  const clamped = Math.min(1, Math.max(0, progress));
  return clamped * clamped * (3 - 2 * clamped);
}
