import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentRef,
} from "react";
import { StyleSheet, View, useWindowDimensions } from "react-native";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  command,
  currentTrack,
  sessionView,
  sessionViewAge,
  subscribe,
} from "./client";
import { Controls } from "./Controls";
import { AlbumCover } from "./AlbumCover";
import { Progress } from "./Progress";
import { SongText } from "./SongText";
import { Swirl, type CoverFrame } from "./Swirl";

const PAUSED_COVER_SCALE = 0.9;
const coverSpring = { damping: 16, stiffness: 140, mass: 1 };

/** Where the song is now: the last report carried forward while playing. */
function usePosition(playing: boolean, reported: number, duration: number) {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!playing) return;
    const timer = setInterval(() => tick((value) => value + 1), 250);
    return () => clearInterval(timer);
  }, [playing]);
  return Math.min(duration, reported + (playing ? sessionViewAge() : 0));
}

export function Player() {
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const skip = useRef({ direction: 1, at: 0 });
  const skipDirection = useCallback(
    () => (Date.now() - skip.current.at < 3000 ? skip.current.direction : 1),
    [],
  );
  const view = useSyncExternalStore(subscribe, sessionView);
  const track = currentTrack(view);
  // Shown at once, until the session moves on with the server's answer.
  const [wanted, setWanted] = useState<{
    playing: boolean;
    revision: number;
  } | null>(null);
  const revision = view?.revision ?? 0;
  const playing =
    wanted?.revision === revision ? wanted.playing : (view?.playing ?? false);
  const duration = view?.duration || track?.durationSeconds || 0;
  const position = usePosition(
    !!view?.playing && !view.buffering,
    view?.positionSeconds ?? 0,
    duration,
  );
  const disabled = !track || !view?.output;

  const send = (action: string, details?: Record<string, unknown>) => {
    if (action === "previous" || action === "next")
      skip.current = {
        direction: action === "previous" ? -1 : 1,
        at: Date.now(),
      };
    void command(action, details).catch(() => setWanted(null));
  };

  // Like Apple Music, the cover steps back while paused.
  const coverScale = useSharedValue(playing ? 1 : PAUSED_COVER_SCALE);
  useEffect(() => {
    coverScale.set(withSpring(playing ? 1 : PAUSED_COVER_SCALE, coverSpring));
  }, [playing, coverScale]);
  const coverStyle = useAnimatedStyle(() => ({
    transform: [{ scale: coverScale.value }],
  }));

  const coverView = useRef<ComponentRef<typeof View>>(null);
  const measured = useRef<CoverFrame | null>(null);
  const coverFrame = useRef<CoverFrame | null>(null);
  const placeCover = () => {
    const frame = measured.current;
    if (!frame) return;
    const size = frame.size * (playing ? 1 : PAUSED_COVER_SCALE);
    coverFrame.current = {
      x: frame.x + (frame.size - size) / 2,
      y: frame.y + (frame.size - size) / 2,
      size,
    };
  };
  useEffect(placeCover, [playing]);

  return (
    <View style={styles.screen}>
      {/* Darkened like the desktop lyrics view, and more behind the white controls. */}
      <Swirl track={track} playing={playing} cover={coverFrame} darkened />
      <View
        style={[
          styles.content,
          { paddingTop: insets.top + 44, paddingBottom: insets.bottom + 12 },
        ]}
      >
        <View
          ref={coverView}
          style={styles.coverSlot}
          onLayout={() =>
            coverView.current?.measureInWindow((x, y, width) => {
              measured.current = { x, y, size: width };
              placeCover();
            })
          }
        >
          <Animated.View
            style={[styles.cover, coverStyle, !track && styles.coverEmpty]}
          >
            <AlbumCover
              track={track}
              size={Math.max(1, width - 60)}
              direction={skipDirection}
            />
          </Animated.View>
        </View>

        <View style={styles.info}>
          <SongText style={styles.title} direction={skipDirection}>
            {track?.name ?? "Nothing playing"}
          </SongText>
          <SongText style={styles.artist} direction={skipDirection}>
            {track?.artist ??
              (view && !view.output ? "Choose an output in Ambra" : " ")}
          </SongText>
        </View>

        <View style={styles.progress}>
          <Progress
            position={position}
            duration={duration}
            revision={revision}
            disabled={disabled}
            onSeek={(seconds) => send("seek", { positionSeconds: seconds })}
          />
        </View>

        <View style={styles.controls}>
          <Controls
            playing={playing}
            disabled={disabled}
            onPrevious={() => send("previous")}
            onToggle={() => {
              setWanted({ playing: !playing, revision });
              send(playing ? "pause" : "play");
            }}
            onNext={() => send("next")}
          />
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  content: { flex: 1, paddingHorizontal: 30 },
  coverSlot: { width: "100%", aspectRatio: 1 },
  cover: { flex: 1 },
  coverEmpty: {
    shadowColor: "white",
    shadowOpacity: 0.18,
    shadowRadius: 30,
    shadowOffset: { width: 0, height: 0 },
  },
  info: { marginTop: 40 },
  title: {
    color: "white",
    fontSize: 20,
    fontWeight: "700",
    letterSpacing: -0.3,
  },
  artist: { color: "rgba(255, 255, 255, 0.8)", fontSize: 17, marginTop: 6 },
  progress: { marginTop: 28 },
  controls: { flex: 1, justifyContent: "center", paddingBottom: "30%" },
});
