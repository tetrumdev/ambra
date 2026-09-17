import { useEffect, useRef, useState } from "react";

type FluidGradientBackgroundProps = {
  colors: string[];
  seed: string;
  active: boolean;
};

const COLOR_TRANSITION_MS = 1800;

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

float hash(vec2 point) {
  return fract(sin(dot(point, vec2(127.1, 311.7)) + u_seed) * 43758.5453);
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
  fields /= fields.x + fields.y + fields.z + fields.w;

  vec3 color = u_colors[0] * fields.x
    + u_colors[1] * fields.y
    + u_colors[2] * fields.z
    + u_colors[3] * fields.w;
  float luminance = dot(color, vec3(0.2126, 0.7152, 0.0722));
  color = mix(vec3(luminance), color, 1.18);
  color *= 0.84 + 0.22 * fbm(fluidPoint * 2.2 + secondWarp);
  gl_FragColor = vec4(color, 1.0);
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

function paletteComponents(colors: string[]) {
  const palette = colors.slice(0, 4);
  while (palette.length < 4) palette.push(palette[0] ?? "#000000");
  return palette.flatMap(colorComponents);
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
  seed,
  active,
}: FluidGradientBackgroundProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const paletteKey = colors.slice(0, 4).join(":");
  const initialSeedRef = useRef(seed);
  const transitionRef = useRef({
    from: paletteComponents(colors),
    to: paletteComponents(colors),
    startedAt: 0,
  });
  const drawRef = useRef<((now: number) => void) | null>(null);
  const animationFrameRef = useRef(0);
  const activeRef = useRef(active);
  const reducedMotionRef = useRef(false);
  const [contextVersion, setContextVersion] = useState(0);

  useEffect(() => {
    const now = performance.now();
    const previous = transitionRef.current;
    const progress = easedProgress((now - previous.startedAt) / COLOR_TRANSITION_MS);
    const target = paletteComponents(colors);
    const current = mixPalette(previous.from, previous.to, progress);
    transitionRef.current = reducedMotionRef.current || !activeRef.current
      ? { from: target, to: target, startedAt: now }
      : { from: current, to: target, startedAt: now };
    if (reducedMotionRef.current || !activeRef.current) drawRef.current?.(now);
  }, [paletteKey]);

  useEffect(() => {
    activeRef.current = active;
    cancelAnimationFrame(animationFrameRef.current);
    animationFrameRef.current = 0;
    if (drawRef.current) {
      animationFrameRef.current = requestAnimationFrame(drawRef.current);
    }
  }, [active]);

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
    if (!buffer || position < 0 || !resolution || !time || !shaderSeed || !shaderColors) {
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

    gl.uniform1f(shaderSeed, seedNumber(initialSeedRef.current) * 1000);

    const motionPreference = window.matchMedia("(prefers-reduced-motion: reduce)");
    reducedMotionRef.current = motionPreference.matches;
    const startedAt = performance.now();
    // This soft color field has no fine detail. Bound fragment work separately
    // from display density, and measure layout only when the canvas changes size.
    let width = 1;
    let height = 1;
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
    const draw = (now: number) => {
      animationFrameRef.current = 0;
      if (document.hidden || gl.isContextLost()) return;
      gl.viewport(0, 0, width, height);
      const transition = transitionRef.current;
      const progress = easedProgress(
        (now - transition.startedAt) / COLOR_TRANSITION_MS,
      );
      gl.uniform3fv(
        shaderColors,
        mixPalette(transition.from, transition.to, progress),
      );
      gl.uniform2f(resolution, width, height);
      gl.uniform1f(time, reducedMotionRef.current ? 0 : (now - startedAt) / 1000);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      if (!reducedMotionRef.current && activeRef.current) {
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
  }, [contextVersion]);

  return (
    <canvas
      id="backgroundFXCanvas"
      ref={canvasRef}
      style={{ backgroundColor: "#000000" }}
    />
  );
}
