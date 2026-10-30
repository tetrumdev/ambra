import { SWIRL_SATURATION, SWIRL_SHADE_MIN, SWIRL_SHADE_RANGE } from "./backgroundPalette";
import { SWIRL_SHARPNESS, swirlBiases } from "./swirlProportions";
import { SURFACE_BLACK } from "./surfaceBlack";

/**
 * The cover-colored swirl behind the player: its shaders and the palette it is drawn from.
 * Shared by the desktop bigscreen (components/FluidGradientBackground) and the phone remote
 * (mobile/), which draw it with WebGL and expo-gl respectively.
 */

/** WebGL 1 or 2: the browser's canvas or expo-gl's context. */
export type SwirlGL = WebGLRenderingContextBase & WebGLRenderingContextOverloads;

export const COLOR_TRANSITION_MS = 1800;
export const NOISE_TEXTURE_SIZE = 256;
// The field drifts far too slowly for frames beyond 60 fps to differ, so
// high-refresh displays draw every other frame instead of doubling the work.
export const MIN_FRAME_INTERVAL_MS = 1000 / 60 - 2;
/** Time constant for the swirl easing between still and full speed. */
export const SWIRL_EASE_SECONDS = 0.9;
/** One noise lattice for every renderer, including clients opened later. */
export const SWIRL_NOISE_SEED = 42;

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
  // The palette is separated from the cover at exactly this saturation and shade range (backgroundPalette.ts).
  color = mix(vec3(luminance), color, ${SWIRL_SATURATION.toFixed(4)});
  color *= ${SWIRL_SHADE_MIN.toFixed(4)} + ${SWIRL_SHADE_RANGE.toFixed(4)} * fbm(fluidPoint * 2.2 + secondWarp);
  // Fixed screen-space dithering breaks up 8-bit color contours without animated grain.
  float dither = texture2D(u_noise, gl_FragCoord.xy / ${NOISE_TEXTURE_SIZE}.0).r - 0.5;
  gl_FragColor = vec4(clamp(color + dither / 255.0, 0.0, 1.0), 1.0);
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

/** The four colors (12 components), then their four field biases. */
export function paletteComponents(colors: string[], weights: number[]) {
  const palette = colors.slice(0, 4);
  while (palette.length < 4) palette.push(palette[0] ?? SURFACE_BLACK);
  // Transition colors and proportions without changing the field's shape.
  return [...palette.flatMap(colorComponents), ...swirlBiases(weights)];
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
