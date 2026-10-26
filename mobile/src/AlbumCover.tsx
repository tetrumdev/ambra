import { Image, type ImageRef } from "expo-image";
import { useCallback, useEffect, useRef, useState } from "react";
import { PixelRatio, StyleSheet, View } from "react-native";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import type { Track } from "./client";
import {
  COVER_SCALE,
  COVER_TRAVEL,
  coverFadeTiming,
  playerTiming,
  type SkipDirection,
} from "./playerMotion";

const placeholder = require("../assets/ambra.png");
const COVER_WAIT_MS = 500;
type Layer = {
  id: number;
  source: ImageRef | number;
  uri: string;
  album: string;
  label: string;
  motion: "none" | "fade" | "slide";
  direction: number;
  leaving: boolean;
};

function CoverLayer({
  layer,
  size,
  drop,
}: {
  layer: Layer;
  size: number;
  drop: (id: number) => void;
}) {
  const { id, motion, direction, leaving } = layer;
  const sliding = motion === "slide";
  const opacity = useSharedValue(motion === "none" ? 1 : 0);
  const x = useSharedValue(sliding ? direction * size * COVER_TRAVEL : 0);
  const scale = useSharedValue(sliding ? COVER_SCALE : 1);
  useEffect(() => {
    const timing = sliding ? playerTiming : coverFadeTiming;
    // Keep the old copy underneath a quality upgrade until the sharper one covers it.
    opacity.set(
      withTiming(leaving && sliding ? 0 : 1, timing, (finished) => {
        if (finished && leaving) scheduleOnRN(drop, id);
      }),
    );
    x.set(
      withTiming(
        leaving && sliding ? -direction * size * COVER_TRAVEL : 0,
        timing,
      ),
    );
    scale.set(withTiming(leaving && sliding ? COVER_SCALE : 1, timing));
  }, [id, sliding, direction, leaving, size, drop, opacity, x, scale]);
  const style = useAnimatedStyle(() => ({
    opacity: opacity.value,
    transform: [{ translateX: x.value }, { scale: scale.value }],
  }));
  return (
    <Animated.View
      style={[StyleSheet.absoluteFill, styles.shadow, style]}
      accessibilityElementsHidden={leaving}
      importantForAccessibility={leaving ? "no-hide-descendants" : "auto"}
    >
      <View style={styles.clip}>
        <Image
          source={layer.source}
          style={StyleSheet.absoluteFill}
          contentFit={layer.uri ? "cover" : "contain"}
          transition={0}
          accessibilityLabel={layer.label}
        />
      </View>
    </Animated.View>
  );
}

/** The bigscreen cover swap: directional slide for albums, fade for sharper copies. */
export function AlbumCover({
  track,
  size,
  direction,
}: {
  track: Track | null;
  size: number;
  direction: SkipDirection;
}) {
  const [layers, setLayers] = useState<Layer[]>([
    {
      id: 0,
      source: placeholder,
      uri: "",
      album: "",
      label: "Ambra",
      motion: "none",
      direction: 1,
      leaving: false,
    },
  ]);
  const nextId = useRef(1);
  const show = useCallback(
    (
      source: ImageRef | number,
      uri: string,
      album: string,
      label: string,
      step: number,
    ) => {
      const id = nextId.current++;
      setLayers((current) => {
        const top = current[current.length - 1];
        if (top?.uri === uri) return current;
        const motion =
          !top?.uri || !uri || top.album === album ? "fade" : "slide";
        return [
          ...current
            .filter((layer) => !layer.leaving)
            .slice(-1)
            .map(
              (layer) =>
                ({ ...layer, leaving: true, motion, direction: step }) as Layer,
            ),
          {
            id,
            source,
            uri,
            album,
            label,
            motion,
            direction: step,
            leaving: false,
          },
        ];
      });
    },
    [],
  );
  const drop = useCallback(
    (id: number) =>
      setLayers((current) =>
        current.filter((layer) => layer.id !== id || !layer.leaving),
      ),
    [],
  );
  const provider = track?.provider;
  const album = track?.album;
  const nativeCover = track?.nativeCover;
  const thumbnail = track?.cover;
  const full = track?.fullCover;
  useEffect(() => {
    const step = direction();
    if (!thumbnail && !full) {
      show(placeholder, "", "", "Ambra", step);
      return;
    }
    let cancelled = false;
    let fullReady = false;
    const key = JSON.stringify([provider, album, nativeCover ?? thumbnail]);
    const options = {
      maxWidth: Math.ceil(size * PixelRatio.get()),
      maxHeight: Math.ceil(size * PixelRatio.get()),
    };
    const reveal = (source: ImageRef, uri: string) => {
      if (!cancelled) show(source, uri, key, `${album} album cover`, step);
    };
    const unavailable = () => {
      if (!cancelled && !fullReady)
        show(placeholder, "", key, "Artwork unavailable", step);
    };
    const fallback = async () => {
      if (!thumbnail || thumbnail === full) {
        unavailable();
        return;
      }
      try {
        const source = await Image.loadAsync(thumbnail, options);
        if (!fullReady) reveal(source, thumbnail);
      } catch {
        unavailable();
      }
    };
    // Keep the old cover while decoding; use the thumbnail if the full cover takes too long.
    const timer = setTimeout(() => {
      if (full && thumbnail && thumbnail !== full) void fallback();
    }, COVER_WAIT_MS);
    void Image.loadAsync(full || thumbnail!, options)
      .then((source) => {
        fullReady = true;
        clearTimeout(timer);
        reveal(source, full || thumbnail!);
      })
      .catch(() => {
        clearTimeout(timer);
        if (!cancelled) void fallback();
      });
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [provider, album, nativeCover, thumbnail, full, size, direction, show]);

  return layers.map((layer) => (
    <CoverLayer key={layer.id} layer={layer} size={size} drop={drop} />
  ));
}

const styles = StyleSheet.create({
  shadow: {
    shadowColor: "black",
    shadowOpacity: 0.35,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 12 },
  },
  clip: {
    flex: 1,
    overflow: "hidden",
    borderRadius: 15,
    backgroundColor: "rgba(255, 255, 255, 0.06)",
  },
});
