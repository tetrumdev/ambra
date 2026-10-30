import { GLView, type ExpoWebGLRenderingContext } from "expo-gl";
import { useEffect, useMemo, useRef, useState } from "react";
import { AccessibilityInfo, AppState, PixelRatio, StyleSheet, View, useWindowDimensions } from "react-native";
import { swirlPalette } from "../../desktop/src/utils/artworkPalette";
import { colors as theme } from "./theme";
import {
  COLOR_TRANSITION_MS,
  MIN_FRAME_INTERVAL_MS,
  SWIRL_EASE_SECONDS,
  SWIRL_NOISE_SEED,
  createNoiseTexture,
  createShader,
  easedProgress,
  fragmentShaderSource,
  mixPalette,
  paletteComponents,
  vertexShaderSource,
  type SwirlGL,
} from "../../desktop/src/utils/swirlShader";
import { backdropShader, backdropAlphas } from "./Backdrop";
import { coverPalette, type Palette, type Track } from "./client";

// The field is soft and slow; drawing it this many pixels tall and letting the compositor scale
// it up looks the same as full resolution for a fraction of the GPU time.
const RENDER_HEIGHT = 720;
const black = { colors: [theme.black, theme.black, theme.black, theme.black], weights: [1, 0, 0, 0] };
const mobileFragmentShader = fragmentShaderSource.replace("void main()", "void swirlMain()") + backdropShader;

/** The desktop bigscreen's swirl (desktop/src/utils/swirlShader.ts), colored from the cover. */
export function Swirl({ track, playing, darkened = false }: {
  track: Track | null;
  playing: boolean;
  /** Lays the backdrop over the field, so white controls read against any cover. */
  darkened?: boolean;
}) {
  const { width, height } = useWindowDimensions();
  const scale = Math.max(1, (height * PixelRatio.get()) / RENDER_HEIGHT);

  const [palette, setPalette] = useState<Palette>(black);
  const provider = track?.provider;
  const nativeCover = track?.nativeCover;
  const artwork = track?.cover;
  const trackId = track?.globalId;
  useEffect(() => {
    if (!provider) return;
    let cancelled = false;
    void coverPalette(provider, nativeCover ?? null, artwork).then(next => {
      if (!cancelled) setPalette(next ? swirlPalette(next) : black);
    });
    return () => { cancelled = true; };
  }, [provider, nativeCover, artwork, trackId]);

  const colors = provider ? palette : black;
  const alphas = useMemo(() => darkened ? backdropAlphas(colors.colors, colors.weights) : [0, 0, 0, 0], [colors, darkened]);
  const target = useMemo(() => [...paletteComponents(colors.colors, colors.weights), ...alphas], [colors, alphas]);
  const transition = useRef({ from: target, to: target, startedAt: 0 });
  const motion = useRef({ playing: playing && !!track, reduced: false, wake: () => {} });
  useEffect(() => {
    const now = performance.now();
    const previous = transition.current;
    const current = mixPalette(previous.from, previous.to, easedProgress((now - previous.startedAt) / COLOR_TRANSITION_MS));
    transition.current = { from: current, to: target, startedAt: now };
    motion.current.wake();
  }, [target]);
  useEffect(() => {
    motion.current.playing = playing && !!track;
    motion.current.wake();
  }, [playing, track, darkened]);

  const frame = useRef(0);
  const stop = useRef(() => {});
  const journey = useRef({ seed: null as number | null, seconds: 0, speed: playing && track ? 1 : 0, updatedAt: 0 });
  useEffect(() => () => stop.current(), []);

  const onContextCreate = (gl: ExpoWebGLRenderingContext) => {
    stop.current();
    const context = gl as unknown as SwirlGL;
    // Match the browser renderer's fixed shader dithering across GPU backends.
    gl.disable(gl.DITHER);
    const vertex = createShader(context, gl.VERTEX_SHADER, vertexShaderSource);
    const fragment = createShader(context, gl.FRAGMENT_SHADER, mobileFragmentShader);
    const program = gl.createProgram();
    if (!vertex || !fragment || !program) return;
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      console.warn("Could not link the swirl shader:", gl.getProgramInfoLog(program));
      return;
    }
    gl.useProgram(program);
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const position = gl.getAttribLocation(program, "a_position");
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
    journey.current.seed ??= SWIRL_NOISE_SEED;
    createNoiseTexture(context, journey.current.seed);
    const uniform = (name: string) => gl.getUniformLocation(program, name);
    const u = {
      resolution: uniform("u_resolution"),
      time: uniform("u_time"),
      noise: uniform("u_noise"),
      colors: uniform("u_colors[0]"),
      bias: uniform("u_bias"),
      backdrop: uniform("u_backdrop"),
    };
    gl.uniform1i(u.noise, 0);

    const bufferWidth = gl.drawingBufferWidth;
    const bufferHeight = gl.drawingBufferHeight;
    const travel = journey.current;
    travel.updatedAt = performance.now();
    let disposed = false;
    let lastDrawnAt = -Infinity;

    const draw = () => {
      frame.current = 0;
      // iOS forbids submitting GPU work while the app is inactive or locked.
      if (disposed || AppState.currentState !== "active") return;
      const now = performance.now();
      const swirlTarget = motion.current.playing ? 1 : 0;
      const moving = travel.speed > 0 || swirlTarget > 0;
      if (moving && now - lastDrawnAt < MIN_FRAME_INTERVAL_MS) {
        frame.current = requestAnimationFrame(draw);
        return;
      }
      lastDrawnAt = now;

      const { from, to, startedAt } = transition.current;
      const progress = easedProgress((now - startedAt) / COLOR_TRANSITION_MS);
      const palette = mixPalette(from, to, progress);
      gl.viewport(0, 0, bufferWidth, bufferHeight);
      gl.uniform3fv(u.colors, new Float32Array(palette.slice(0, 12)));
      gl.uniform4fv(u.bias, new Float32Array(palette.slice(12, 16)));
      gl.uniform2f(u.resolution, bufferWidth, bufferHeight);
      gl.uniform4fv(u.backdrop, new Float32Array(palette.slice(-4)));

      // The swirl drifts to a stop on pause and gathers pace again on play, never freezing mid-motion.
      const elapsed = Math.min(0.1, Math.max(0, (now - travel.updatedAt) / 1000));
      travel.updatedAt = now;
      if (motion.current.reduced) travel.speed = swirlTarget;
      else {
        travel.speed += (swirlTarget - travel.speed) * (1 - Math.exp(-elapsed / SWIRL_EASE_SECONDS));
        if (Math.abs(swirlTarget - travel.speed) < 0.002) travel.speed = swirlTarget;
      }
      travel.seconds += elapsed * travel.speed;
      gl.uniform1f(u.time, travel.seconds);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.endFrameEXP();

      if (AppState.currentState === "active" && (travel.speed > 0 || swirlTarget > 0 || progress < 1)) {
        frame.current = requestAnimationFrame(draw);
      }
    };
    motion.current.wake = () => {
      if (disposed || frame.current) return;
      travel.updatedAt = performance.now();
      frame.current = requestAnimationFrame(draw);
    };
    stop.current = () => {
      disposed = true;
      cancelAnimationFrame(frame.current);
      frame.current = 0;
    };
    motion.current.wake();
  };

  useEffect(() => {
    void AccessibilityInfo.isReduceMotionEnabled().then(reduced => { motion.current.reduced = reduced; });
    const reduceMotion = AccessibilityInfo.addEventListener("reduceMotionChanged", reduced => { motion.current.reduced = reduced; });
    const appState = AppState.addEventListener("change", state => {
      if (state === "active") motion.current.wake();
      else { cancelAnimationFrame(frame.current); frame.current = 0; }
    });
    return () => {
      reduceMotion.remove();
      appState.remove();
    };
  }, []);

  return (
    <View collapsable={false} style={[StyleSheet.absoluteFill, { backgroundColor: theme.black }]} pointerEvents="none">
      <GLView
        key={`${width}x${height}`}
        msaaSamples={0}
        onContextCreate={onContextCreate}
        style={{
          position: "absolute",
          width: width / scale,
          height: height / scale,
          left: (width - width / scale) / 2,
          top: (height - height / scale) / 2,
          transform: [{ scale }],
        }}
      />
    </View>
  );
}
