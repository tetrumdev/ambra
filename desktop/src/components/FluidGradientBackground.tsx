import { useEffect, useRef, useState } from "react";
import {
  softenedPaletteWeights,
  type CoverSeparation,
} from "../utils/backgroundPalette";

type FluidGradientBackgroundProps = {
  colors: string[];
  weights: number[];
  separation: CoverSeparation;
  coverId: string;
  seed: string;
  active: boolean;
  animate?: boolean;
};

const COLOR_TRANSITION_MS = 1800;
// The field drifts far too slowly for frames beyond 60 fps to differ, so
// high-refresh displays draw every other frame instead of doubling the work.
const MIN_FRAME_INTERVAL_MS = 1000 / 60 - 2;

const vertexShaderSource = `
attribute vec2 a_position;

void main() {
  gl_Position = vec4(a_position, 0.0, 1.0);
}
`;

const fragmentShaderSource = `
precision mediump float;

uniform vec2 u_resolution;
uniform float u_time;
uniform float u_seed;
uniform vec3 u_colors[4];
uniform vec4 u_weights;
uniform vec4 u_cover;
uniform vec4 u_edgeLuma;
uniform vec4 u_edgeDirection;

// Arithmetic hash (Dave Hoskins, "Hash without Sine"): every pixel evaluates
// this ~180 times a frame, and sin() is far slower than multiply-adds on GPUs.
float hash(vec2 point) {
  vec3 p3 = fract(vec3(point.xyx + u_seed) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float noise(vec2 point) {
  vec2 cell = floor(point);
  vec2 local = fract(point);
  vec2 smoothLocal = local * local * (3.0 - 2.0 * local);

  return mix(
    mix(hash(cell), hash(cell + vec2(1.0, 0.0)), smoothLocal.x),
    mix(hash(cell + vec2(0.0, 1.0)), hash(cell + vec2(1.0)), smoothLocal.x),
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

// Quietly lifts or deepens the field right around the cover, mostly where it
// would otherwise match the cover's own edge, so the art never sits flush.
vec3 separateFromCover(vec3 color) {
  if (u_cover.z <= 0.0) return color;
  vec2 offset = gl_FragCoord.xy - u_cover.xy;
  vec2 outside = abs(offset) - u_cover.z;
  float gap = length(max(outside, 0.0));
  float nearby = exp(-(gap * gap) / (u_cover.w * u_cover.w));
  if (nearby < 0.004) return color;

  // Corners blend their two sides' edge measurements.
  vec4 side = max(vec4(offset.y, offset.x, -offset.y, -offset.x), 0.0)
    / max(length(offset), 1.0);
  side *= side;
  side *= side;
  side /= max(dot(side, vec4(1.0)), 0.0001);
  float edge = dot(side, u_edgeLuma);
  float direction = dot(side, u_edgeDirection);

  float luma = dot(color, vec3(0.2126, 0.7152, 0.0722));
  float similarity = 1.0 - smoothstep(0.03, 0.22, abs(luma - edge));
  float amount = nearby * (0.15 + 0.85 * similarity);
  vec3 deeper = color * (1.0 - 0.07 * amount);
  vec3 lifted = 1.0 - (1.0 - color) * (1.0 - 0.04 * amount);
  return mix(color, direction < 0.0 ? deeper : lifted, abs(direction));
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
  fields = exp((fields - max(max(fields.x, fields.y), max(fields.z, fields.w))) * 9.0);
  fields *= u_weights;
  fields /= fields.x + fields.y + fields.z + fields.w;

  vec3 color = u_colors[0] * fields.x
    + u_colors[1] * fields.y
    + u_colors[2] * fields.z
    + u_colors[3] * fields.w;
  float luminance = dot(color, vec3(0.2126, 0.7152, 0.0722));
  color = mix(vec3(luminance), color, 1.18);
  color *= 0.84 + 0.22 * fbm(fluidPoint * 2.2 + secondWarp);
  gl_FragColor = vec4(separateFromCover(color), 1.0);
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
  while (palette.length < 4) palette.push(palette[0] ?? "#000000");
  // Transition colors, their influence, and the cover separation together.
  return [
    ...palette.flatMap(colorComponents),
    ...softenedPaletteWeights(weights, colors.length),
    ...separation.edges,
    ...separation.directions,
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

function seedNumber(seed: string) {
  let value = 2166136261;
  for (const character of seed) {
    value ^= character.charCodeAt(0);
    value = Math.imul(value, 16777619);
  }
  return (value >>> 0) / 4294967295;
}

export function FluidGradientBackground({
  colors,
  weights,
  separation,
  coverId,
  seed,
  active,
  animate = true,
}: FluidGradientBackgroundProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const paletteKey = [
    ...colors.slice(0, 4),
    ...weights.slice(0, 4),
    ...separation.edges,
    ...separation.directions,
  ].join(":");
  const initialSeedRef = useRef(seed);
  const transitionRef = useRef({
    from: paletteComponents(colors, weights, separation),
    to: paletteComponents(colors, weights, separation),
    startedAt: 0,
  });
  const drawRef = useRef<((now: number) => void) | null>(null);
  const animationFrameRef = useRef(0);
  const activeRef = useRef(active);
  const animateRef = useRef(animate);
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
    if (reducedMotionRef.current || !activeRef.current) drawRef.current?.(now);
  }, [paletteKey]);

  useEffect(() => {
    activeRef.current = active;
    animateRef.current = animate;
    cancelAnimationFrame(animationFrameRef.current);
    animationFrameRef.current = 0;
    if (drawRef.current) {
      animationFrameRef.current = requestAnimationFrame(drawRef.current);
    }
  }, [active, animate]);

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
    const position = gl.getAttribLocation(program, "a_position");
    const resolution = gl.getUniformLocation(program, "u_resolution");
    const time = gl.getUniformLocation(program, "u_time");
    const shaderSeed = gl.getUniformLocation(program, "u_seed");
    const shaderColors = gl.getUniformLocation(program, "u_colors[0]");
    const shaderWeights = gl.getUniformLocation(program, "u_weights");
    const shaderCover = gl.getUniformLocation(program, "u_cover");
    const shaderEdgeLuma = gl.getUniformLocation(program, "u_edgeLuma");
    const shaderEdgeDirection = gl.getUniformLocation(program, "u_edgeDirection");
    if (
      !buffer || position < 0 || !resolution || !time || !shaderSeed || !shaderColors
      || !shaderWeights || !shaderCover || !shaderEdgeLuma || !shaderEdgeDirection
    ) {
      gl.deleteProgram(program);
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

    // The hash offsets lattice coordinates by the seed; a small range keeps
    // full precision even where mediump floats are 16-bit.
    gl.uniform1f(shaderSeed, seedNumber(initialSeedRef.current) * 64);

    const motionPreference = window.matchMedia("(prefers-reduced-motion: reduce)");
    reducedMotionRef.current = motionPreference.matches;
    const startedAt = performance.now();
    // This soft color field has no fine detail. Bound fragment work separately
    // from display density, and measure layout only when the canvas changes size.
    let width = 1;
    let height = 1;
    // The cover, in canvas pixels: center (GL y-up), half size, glow falloff.
    let cover = [0, 0, 0, 1];
    let observedCover: HTMLElement | null = null;
    const measureCover = () => {
      const element = document.getElementById(coverId);
      if (element && element !== observedCover) {
        observedCover = element;
        resizeObserver.observe(element);
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
      const cssWidth = canvas.clientWidth;
      const cssHeight = canvas.clientHeight;
      const scale = Math.min(1, 960 / Math.max(1, cssWidth, cssHeight));
      width = Math.max(1, Math.round(cssWidth * scale));
      height = Math.max(1, Math.round(cssHeight * scale));
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      measureCover();
      scheduleDraw();
    };
    const scheduleDraw = () => {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = document.hidden ? 0 : requestAnimationFrame(draw);
    };
    const motionChanged = () => {
      reducedMotionRef.current = motionPreference.matches;
      scheduleDraw();
    };
    let lastDrawnAt = -Infinity;
    const draw = (now: number) => {
      animationFrameRef.current = 0;
      if (document.hidden || gl.isContextLost()) return;
      if (
        now - lastDrawnAt < MIN_FRAME_INTERVAL_MS
        && animateRef.current
        && activeRef.current
      ) {
        animationFrameRef.current = requestAnimationFrame(draw);
        return;
      }
      lastDrawnAt = now;
      gl.viewport(0, 0, width, height);
      const transition = transitionRef.current;
      const progress = easedProgress(
        (now - transition.startedAt) / COLOR_TRANSITION_MS,
      );
      const palette = mixPalette(transition.from, transition.to, progress);
      gl.uniform3fv(shaderColors, palette.slice(0, 12));
      gl.uniform4fv(shaderWeights, palette.slice(12, 16));
      // The cover may mount after the canvas; keep looking until it appears.
      if (!observedCover) measureCover();
      gl.uniform4fv(shaderCover, cover);
      gl.uniform4fv(shaderEdgeLuma, palette.slice(16, 20));
      gl.uniform4fv(shaderEdgeDirection, palette.slice(20, 24));
      gl.uniform2f(resolution, width, height);
      // Swirl motion has its own app preference. Windows can disable UI
      // transitions without disabling this explicitly selected background.
      gl.uniform1f(time, animateRef.current ? (now - startedAt) / 1000 : 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      if (animateRef.current && activeRef.current) {
        animationFrameRef.current = requestAnimationFrame(draw);
      }
    };
    drawRef.current = draw;
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
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = 0;
      gl.deleteBuffer(buffer);
      gl.deleteProgram(program);
      gl.deleteShader(vertexShader);
      gl.deleteShader(fragmentShader);
    };
  }, [contextVersion, coverId]);

  return (
    <canvas
      id="backgroundFXCanvas"
      ref={canvasRef}
      style={{ backgroundColor: "#000000" }}
    />
  );
}
