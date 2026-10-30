import { useEffect, useRef, useState } from "react";
import {
  COLOR_TRANSITION_MS,
  MIN_FRAME_INTERVAL_MS,
  SWIRL_EASE_SECONDS,
  createNoiseTexture,
  createShader,
  easedProgress,
  fragmentShaderSource,
  mixPalette,
  paletteComponents,
  vertexShaderSource,
} from "../utils/swirlShader";
import { SURFACE_BLACK } from "../utils/surfaceBlack";
import { reducedMotion, subscribeReducedMotion } from "../utils/reducedMotion";

type FluidGradientBackgroundProps = {
  /** Already separated from the cover's edges (separatePaletteFromCover). */
  colors: string[];
  /** Each color's share of the cover; the swirl gives it a matching share of the field. */
  weights: number[];
  active: boolean;
  animate?: boolean;
  /** The swirl drifts to a stop while playback is paused and gathers pace again when it resumes. */
  playing?: boolean;
};

export function FluidGradientBackground({
  colors,
  weights,
  active,
  animate = true,
  playing = true,
}: FluidGradientBackgroundProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const paletteKey = [...colors.slice(0, 4), ...weights.slice(0, 4)].join(":");
  // Swirl time advances at `speed`, which eases rather than switching, so pausing never freezes a frame mid-motion.
  const journeyRef = useRef<{ seed: number; seconds: number; updatedAt: number; speed: number } | null>(null);
  if (journeyRef.current === null) {
    journeyRef.current = { seed: Math.random() * 64, seconds: 0, updatedAt: performance.now(), speed: animate && playing ? 1 : 0 };
  }
  const journey = journeyRef.current;
  const transitionRef = useRef({
    from: paletteComponents(colors, weights),
    to: paletteComponents(colors, weights),
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
    const target = paletteComponents(colors, weights);
    const current = mixPalette(previous.from, previous.to, progress);
    transitionRef.current = reducedMotionRef.current || !activeRef.current
      ? { from: target, to: target, startedAt: now }
      : { from: current, to: target, startedAt: now };
    if (drawRef.current && !animationFrameRef.current) {
      animationFrameRef.current = requestAnimationFrame(drawRef.current);
    }
  }, [paletteKey]);

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
    if (!buffer || !noiseTexture || position < 0 || !resolution || !time || !shaderNoise || !shaderColors) {
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

    reducedMotionRef.current = reducedMotion();
    // This soft color field has no fine detail. Bound fragment work separately
    // from display density, and measure layout only when the canvas changes size.
    let width = 1;
    let height = 1;
    let layoutDirty = true;
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
      reducedMotionRef.current = reducedMotion();
      scheduleDraw();
    };
    let lastDrawnAt = -Infinity;
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
        layoutDirty = false;
      }
      gl.viewport(0, 0, width, height);
      const transition = transitionRef.current;
      const progress = easedProgress(
        (now - transition.startedAt) / COLOR_TRANSITION_MS,
      );
      const palette = mixPalette(transition.from, transition.to, progress);
      gl.uniform3fv(shaderColors, palette.slice(0, 12));
      gl.uniform4fv(shaderBias, palette.slice(12, 16));
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
      if (activeRef.current && (journey.speed > 0 || swirlTarget > 0 || progress < 1)) {
        animationFrameRef.current = requestAnimationFrame(draw);
      }
    };
    drawRef.current = draw;
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(canvas);
    document.addEventListener("visibilitychange", scheduleDraw);
    const stopFollowingMotion = subscribeReducedMotion(motionChanged);
    resize();

    return () => {
      resizeObserver.disconnect();
      document.removeEventListener("visibilitychange", scheduleDraw);
      stopFollowingMotion();
      drawRef.current = null;
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
