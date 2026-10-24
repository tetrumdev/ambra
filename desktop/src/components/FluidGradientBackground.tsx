import { useEffect, useRef, useState } from "react";
import {
  COVER_EDGE_ZONES,
  type CoverSeparation,
} from "../utils/backgroundPalette";
import { SWIRL_SHARPNESS, swirlBiases } from "../utils/swirlProportions";
import { SURFACE_BLACK } from "../utils/surfaceBlack";

type FluidGradientBackgroundProps = {
  colors: string[];
  /** Each color's share of the cover; the swirl gives it a matching share of the field. */
  weights: number[];
  separation: CoverSeparation;
  coverId: string;
  /** Visible share of the field beside the cover after page overlays; 1 = none. */
  coverDim?: number;
  /** How long a change in coverDim eases. */
  coverDimMs?: number;
  active: boolean;
  animate?: boolean;
  /** The swirl drifts to a stop while playback is paused and gathers pace again when it resumes. */
  playing?: boolean;
};

const COLOR_TRANSITION_MS = 1800;
/** Matches the lyrics backdrop fade by default, so the separation eases with what is visible beside the cover. */
const COVER_DIM_TRANSITION_MS = 700;
const EDGE_COMPONENTS = COVER_EDGE_ZONES * 4;
const NOISE_TEXTURE_SIZE = 256;
// The field drifts far too slowly for frames beyond 60 fps to differ, so
// high-refresh displays draw every other frame instead of doubling the work.
const MIN_FRAME_INTERVAL_MS = 1000 / 60 - 2;
/** Time constant for the swirl easing between still and full speed. */
const SWIRL_EASE_SECONDS = 0.9;

const vertexShaderSource = `
attribute vec2 a_position;

void main() {
  gl_Position = vec4(a_position, 0.0, 1.0);
}
`;

const fragmentShaderSource = `
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
  float nearby = exp(-(gap * gap) / (u_cover.w * u_cover.w));

  // Corners blend their two sides' edge measurements.
  vec4 side = max(vec4(offset.y, offset.x, -offset.y, -offset.x), 0.0)
    / max(length(offset), 1.0);
  side *= side;
  side *= side;
  side /= max(dot(side, vec4(1.0)), 0.0001);

  // Position along each side in zone units; top and bottom run left to right,
  // the sides top to bottom (cover image space, so GL's y is flipped).
  vec2 along = clamp((vec2(offset.x, -offset.y) / u_cover.z + 1.0) * 0.5, 0.0, 1.0)
    * ${COVER_EDGE_ZONES}.0 - 0.5;
  vec4 position = vec4(along, along);
  vec4 zoneLuma = vec4(0.0);
  vec4 zoneDirection = vec4(0.0);
  vec4 total = vec4(0.0);
  for (int zone = 0; zone < ${COVER_EDGE_ZONES}; zone++) {
    vec4 weight = max(1.0 - abs(position - float(zone)), 0.0);
    weight = weight * weight * (3.0 - 2.0 * weight);
    zoneLuma += u_edgeLuma[zone] * weight;
    zoneDirection += u_edgeDirection[zone] * weight;
    total += weight;
  }
  float edge = dot(side, zoneLuma / total);
  float direction = dot(side, zoneDirection / total);

  // Keep existing contrast and gently separate similar colors. Bounded
  // adjustments preserve the moving field instead of forcing it to match
  // brightness targets from the stationary cover zones.
  // Compare what is seen: an overlay may darken the field but not the cover.
  float luma = u_coverDim * dot(color, vec3(0.2126, 0.7152, 0.0722));
  float similarity = 1.0 - smoothstep(0.03, 0.22, abs(luma - edge));
  float amount = nearby * similarity * abs(direction);
  vec3 deeper = color * (1.0 - 0.07 * amount);
  // Lift toward what shows as white through the overlay, so the visible change matches.
  vec3 lifted = mix(color, vec3(1.0 / u_coverDim), 0.04 * amount);
  return direction < 0.0 ? deeper : lifted;
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

function createShader(
  gl: WebGLRenderingContext,
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

function createNoiseTexture(gl: WebGLRenderingContext, seed: number) {
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

function paletteComponents(
  colors: string[],
  weights: number[],
  separation: CoverSeparation,
) {
  const palette = colors.slice(0, 4);
  while (palette.length < 4) palette.push(palette[0] ?? SURFACE_BLACK);
  // Transition colors, proportions and cover separation without changing the field's shape.
  return [
    ...palette.flatMap(colorComponents),
    ...separation.edges,
    ...separation.directions,
    ...swirlBiases(weights),
  ];
}

function mixPalette(from: number[], to: number[], progress: number) {
  return from.map((component, index) => (
    component + (to[index] - component) * progress
  ));
}

function easedProgress(progress: number) {
  const clamped = Math.min(1, Math.max(0, progress));
  return clamped * clamped * (3 - 2 * clamped);
}

export function FluidGradientBackground({
  colors,
  weights,
  separation,
  coverId,
  coverDim = 1,
  coverDimMs = COVER_DIM_TRANSITION_MS,
  active,
  animate = true,
  playing = true,
}: FluidGradientBackgroundProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const paletteKey = [
    ...colors.slice(0, 4),
    ...weights.slice(0, 4),
    ...separation.edges,
    ...separation.directions,
  ].join(":");
  // Swirl time advances at `speed`, which eases rather than switching, so pausing never freezes a frame mid-motion.
  const journeyRef = useRef<{ seed: number; seconds: number; updatedAt: number; speed: number } | null>(null);
  if (journeyRef.current === null) {
    journeyRef.current = { seed: Math.random() * 64, seconds: 0, updatedAt: performance.now(), speed: animate && playing ? 1 : 0 };
  }
  const journey = journeyRef.current;
  const coverIdRef = useRef(coverId);
  const clampedDim = Math.min(1, Math.max(0.05, coverDim));
  const coverDimRef = useRef({ from: clampedDim, to: clampedDim, startedAt: 0, duration: coverDimMs });
  const resizeRef = useRef<(() => void) | null>(null);
  const transitionRef = useRef({
    from: paletteComponents(colors, weights, separation),
    to: paletteComponents(colors, weights, separation),
    startedAt: 0,
  });
  const drawRef = useRef<((now: number) => void) | null>(null);
  const animationFrameRef = useRef(0);
  const activeRef = useRef(active);
  const animateRef = useRef(animate);
  const playingRef = useRef(playing);
  const reducedMotionRef = useRef(false);
  const [contextVersion, setContextVersion] = useState(0);

  useEffect(() => {
    const now = performance.now();
    const previous = transitionRef.current;
    const progress = easedProgress((now - previous.startedAt) / COLOR_TRANSITION_MS);
    const target = paletteComponents(colors, weights, separation);
    const current = mixPalette(previous.from, previous.to, progress);
    transitionRef.current = reducedMotionRef.current || !activeRef.current
      ? { from: target, to: target, startedAt: now }
      : { from: current, to: target, startedAt: now };
    if (drawRef.current && !animationFrameRef.current) {
      animationFrameRef.current = requestAnimationFrame(drawRef.current);
    }
  }, [paletteKey]);

  useEffect(() => {
    coverIdRef.current = coverId;
    const now = performance.now();
    const previous = coverDimRef.current;
    const current = previous.from + (previous.to - previous.from) * easedProgress((now - previous.startedAt) / previous.duration);
    coverDimRef.current = reducedMotionRef.current || !activeRef.current
      ? { from: clampedDim, to: clampedDim, startedAt: now, duration: coverDimMs }
      : { from: current, to: clampedDim, startedAt: now, duration: coverDimMs };
    resizeRef.current?.();
  }, [coverId, clampedDim]);

  useEffect(() => {
    // Hidden time does not count; the swirl resumes from where it was drawn.
    if (!activeRef.current && active) journey.updatedAt = performance.now();
    activeRef.current = active;
    animateRef.current = animate;
    playingRef.current = playing;
    cancelAnimationFrame(animationFrameRef.current);
    animationFrameRef.current = 0;
    if (drawRef.current) {
      animationFrameRef.current = requestAnimationFrame(drawRef.current);
    }
  }, [active, animate, playing]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const handleContextLost = (event: Event) => {
      event.preventDefault();
      drawRef.current = null;
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = 0;
    };
    const handleContextRestored = () => {
      setContextVersion((version) => version + 1);
    };

    canvas.addEventListener("webglcontextlost", handleContextLost);
    canvas.addEventListener("webglcontextrestored", handleContextRestored);
    return () => {
      canvas.removeEventListener("webglcontextlost", handleContextLost);
      canvas.removeEventListener("webglcontextrestored", handleContextRestored);
    };
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const gl = canvas.getContext("webgl", {
      alpha: false,
      antialias: false,
      depth: false,
      powerPreference: "low-power",
    });
    if (!gl) return;
    // The shader provides fixed dithering; avoid backend-dependent framebuffer dithering.
    gl.disable(gl.DITHER);

    const vertexShader = createShader(gl, gl.VERTEX_SHADER, vertexShaderSource);
    const fragmentShader = createShader(
      gl,
      gl.FRAGMENT_SHADER,
      fragmentShaderSource,
    );
    if (!vertexShader || !fragmentShader) return;

    const program = gl.createProgram();
    if (!program) return;
    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      console.warn("Could not link fluid-gradient shader:", gl.getProgramInfoLog(program));
      gl.deleteProgram(program);
      return;
    }

    const buffer = gl.createBuffer();
    const noiseTexture = createNoiseTexture(gl, journey.seed);
    const position = gl.getAttribLocation(program, "a_position");
    const resolution = gl.getUniformLocation(program, "u_resolution");
    const time = gl.getUniformLocation(program, "u_time");
    const shaderNoise = gl.getUniformLocation(program, "u_noise");
    const shaderColors = gl.getUniformLocation(program, "u_colors[0]");
    const shaderBias = gl.getUniformLocation(program, "u_bias");
    const shaderCover = gl.getUniformLocation(program, "u_cover");
    const shaderCoverDim = gl.getUniformLocation(program, "u_coverDim");
    const shaderEdgeLuma = gl.getUniformLocation(program, "u_edgeLuma[0]");
    const shaderEdgeDirection = gl.getUniformLocation(program, "u_edgeDirection[0]");
    if (
      !buffer || !noiseTexture || position < 0 || !resolution || !time || !shaderNoise || !shaderColors
      || !shaderCover || !shaderEdgeLuma || !shaderEdgeDirection
    ) {
      gl.deleteTexture(noiseTexture);
      gl.deleteBuffer(buffer);
      gl.deleteProgram(program);
      gl.deleteShader(vertexShader);
      gl.deleteShader(fragmentShader);
      return;
    }

    gl.useProgram(program);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 3, -1, -1, 3]),
      gl.STATIC_DRAW,
    );
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);

    gl.uniform1i(shaderNoise, 0);

    const motionPreference = window.matchMedia("(prefers-reduced-motion: reduce)");
    reducedMotionRef.current = motionPreference.matches;
    // This soft color field has no fine detail. Bound fragment work separately
    // from display density, and measure layout only when the canvas changes size.
    let width = 1;
    let height = 1;
    let layoutDirty = true;
    // The cover, in canvas pixels: center (GL y-up), half size, glow falloff.
    let cover = [0, 0, 0, 1];
    let observedCover: HTMLElement | null = null;
    const measureCover = () => {
      const element = document.getElementById(coverIdRef.current);
      if (element !== observedCover) {
        if (observedCover) resizeObserver.unobserve(observedCover);
        observedCover = element;
        if (element) resizeObserver.observe(element);
      }
      const bounds = canvas.getBoundingClientRect();
      const rect = element?.getBoundingClientRect();
      if (!rect || rect.width <= 0 || bounds.width <= 0 || bounds.height <= 0) {
        cover = [0, 0, 0, 1];
        return;
      }
      const scaleX = width / bounds.width;
      const scaleY = height / bounds.height;
      const halfSize = (rect.width / 2) * scaleX;
      cover = [
        (rect.left + rect.width / 2 - bounds.left) * scaleX,
        height - (rect.top + rect.height / 2 - bounds.top) * scaleY,
        halfSize,
        Math.max(1, halfSize * 0.36),
      ];
    };
    const resize = () => {
      layoutDirty = true;
      scheduleDraw();
    };
    const scheduleDraw = () => {
      if (!document.hidden && !animationFrameRef.current) {
        animationFrameRef.current = requestAnimationFrame(draw);
      }
    };
    const motionChanged = () => {
      reducedMotionRef.current = motionPreference.matches;
      scheduleDraw();
    };
    let lastDrawnAt = -Infinity;
    let coverWasFlying = false;
    const draw = (now: number) => {
      animationFrameRef.current = 0;
      if (document.hidden || gl.isContextLost()) return;
      const swirlTarget = animateRef.current && playingRef.current ? 1 : 0;
      const moving = journey.speed > 0 || swirlTarget > 0;
      if (
        now - lastDrawnAt < MIN_FRAME_INTERVAL_MS
        && !layoutDirty
        && moving
        && activeRef.current
      ) {
        animationFrameRef.current = requestAnimationFrame(draw);
        return;
      }
      lastDrawnAt = now;
      if (layoutDirty) {
        const cssWidth = canvas.clientWidth;
        const cssHeight = canvas.clientHeight;
        const scale = Math.min(1, 960 / Math.max(1, cssWidth, cssHeight));
        width = Math.max(1, Math.round(cssWidth * scale));
        height = Math.max(1, Math.round(cssHeight * scale));
        // Resizing clears WebGL's buffer. Redraw in this callback so a blank
        // buffer cannot reach the compositor, even when animation is paused.
        if (canvas.width !== width) canvas.width = width;
        if (canvas.height !== height) canvas.height = height;
        measureCover();
        layoutDirty = false;
      }
      gl.viewport(0, 0, width, height);
      const transition = transitionRef.current;
      const progress = easedProgress(
        (now - transition.startedAt) / COLOR_TRANSITION_MS,
      );
      const palette = mixPalette(transition.from, transition.to, progress);
      gl.uniform3fv(shaderColors, palette.slice(0, 12));
      // The cover may mount after the canvas; keep looking until it appears. While it moves
      // (opening, closing, or gliding beside the lyrics) the glow follows it every frame, and
      // once more after it lands, since the last moving frame is a little short of its place.
      const flying = !!observedCover?.getAnimations().length;
      if (!observedCover || !observedCover.isConnected || flying || coverWasFlying) measureCover();
      coverWasFlying = flying;
      gl.uniform4fv(shaderCover, cover);
      const dim = coverDimRef.current;
      const dimProgress = easedProgress((now - dim.startedAt) / dim.duration);
      gl.uniform1f(shaderCoverDim, dim.from + (dim.to - dim.from) * dimProgress);
      gl.uniform4fv(shaderEdgeLuma, palette.slice(12, 12 + EDGE_COMPONENTS));
      gl.uniform4fv(shaderEdgeDirection, palette.slice(12 + EDGE_COMPONENTS, 12 + EDGE_COMPONENTS * 2));
      gl.uniform4fv(shaderBias, palette.slice(12 + EDGE_COMPONENTS * 2, 16 + EDGE_COMPONENTS * 2));
      gl.uniform2f(resolution, width, height);
      // Swirl motion has its own app preference. Windows can disable UI
      // transitions without disabling this explicitly selected background.
      const elapsed = Math.min(0.1, Math.max(0, (now - journey.updatedAt) / 1000));
      journey.updatedAt = now;
      if (reducedMotionRef.current) journey.speed = swirlTarget;
      else {
        journey.speed += (swirlTarget - journey.speed) * (1 - Math.exp(-elapsed / SWIRL_EASE_SECONDS));
        if (Math.abs(swirlTarget - journey.speed) < 0.002) journey.speed = swirlTarget;
      }
      journey.seconds += elapsed * journey.speed;
      gl.uniform1f(time, journey.seconds);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      if (activeRef.current && (journey.speed > 0 || swirlTarget > 0 || progress < 1 || dimProgress < 1 || flying)) {
        animationFrameRef.current = requestAnimationFrame(draw);
      }
    };
    drawRef.current = draw;
    resizeRef.current = resize;
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(canvas);
    document.addEventListener("visibilitychange", scheduleDraw);
    motionPreference.addEventListener("change", motionChanged);
    resize();

    return () => {
      resizeObserver.disconnect();
      document.removeEventListener("visibilitychange", scheduleDraw);
      motionPreference.removeEventListener("change", motionChanged);
      drawRef.current = null;
      resizeRef.current = null;
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = 0;
      gl.deleteBuffer(buffer);
      gl.deleteTexture(noiseTexture);
      gl.deleteProgram(program);
      gl.deleteShader(vertexShader);
      gl.deleteShader(fragmentShader);
    };
  }, [contextVersion]);

  return (
    <canvas
      id="backgroundFXCanvas"
      ref={canvasRef}
      style={{ backgroundColor: SURFACE_BLACK }}
    />
  );
}
