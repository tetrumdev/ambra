import { HStack, Image, ProgressView, Spacer, Text, VStack } from "@expo/ui/swift-ui";
import { activityBackgroundTint, cornerRadius, font, foregroundStyle, frame, lineLimit, monospacedDigit, padding, resizable, tint } from "@expo/ui/swift-ui/modifiers";
import { createLiveActivity, type LiveActivityEnvironment } from "expo-widgets";
import type { ActivitySnapshot } from "./activitySession";

const NowPlayingActivity = (props: ActivitySnapshot, environment: LiveActivityEnvironment) => {
  "widget";
  const running = props.playing && !environment.isStale;
  const interval = { lower: new Date(props.startAt), upper: new Date(props.endAt) };
  const title = <Text modifiers={[font({ size: 16, weight: "semibold" }), lineLimit(1), foregroundStyle("#ffffff")]}>{props.title}</Text>;
  const artist = <Text modifiers={[font({ size: 13 }), lineLimit(1), foregroundStyle("#cccccc")]}>{props.artist}</Text>;
  const cover = props.artwork
    ? <Image uiImage={props.artwork} modifiers={[resizable(), frame({ width: 56, height: 56 }), cornerRadius(5)]} />
    : <Image systemName="music.note" size={30} color="#ffffff" modifiers={[frame({ width: 56, height: 56 })]} />;
  const progress = running && props.duration > 0
    ? <ProgressView timerInterval={interval} countsDown={false} modifiers={[tint("#ffffff")]} />
    : <ProgressView value={props.duration > 0 ? props.position / props.duration : 0} modifiers={[tint("#ffffff")]} />;
  const output = <Text modifiers={[font({ size: 11 }), foregroundStyle("#aaaaaa"), lineLimit(1)]}>
    {environment.isStale ? "Open Ambra to reconnect" : `${props.playing ? "Playing" : "Paused"} on ${props.output}`}
  </Text>;
  return {
    banner: (
      <VStack spacing={10} modifiers={[padding({ all: 16 }), activityBackgroundTint("#151515")]}>
        <HStack spacing={12}>
          {cover}
          <VStack alignment="leading" spacing={4} modifiers={[frame({ maxWidth: 10000, alignment: "leading" })]}>{title}{artist}{output}</VStack>
          <Image systemName={running ? "waveform" : "pause.fill"} color="#ffffff" size={20} />
        </HStack>
        {progress}
        <HStack>
          <Text timerInterval={interval} countsDown={false} pauseTime={running ? undefined : new Date(props.updatedAt)} modifiers={[font({ size: 11 }), monospacedDigit(), foregroundStyle("#cccccc")]} />
          <Spacer />
          <Text modifiers={[font({ size: 11 }), monospacedDigit(), foregroundStyle("#cccccc")]}>{`${Math.floor(props.duration / 60)}:${String(Math.floor(props.duration % 60)).padStart(2, "0")}`}</Text>
        </HStack>
      </VStack>
    ),
    compactLeading: props.artwork
      ? <Image uiImage={props.artwork} modifiers={[resizable(), frame({ width: 22, height: 22 }), cornerRadius(3)]} />
      : <Image systemName="music.note" size={18} color="#ffffff" />,
    compactTrailing: <Image systemName={running ? "waveform" : "pause.fill"} size={18} color="#ffffff" />,
    minimal: <Image systemName={running ? "music.note" : "pause.fill"} size={16} color="#ffffff" />,
    expandedLeading: cover,
    expandedCenter: <VStack alignment="leading" spacing={4}>{title}{artist}</VStack>,
    expandedTrailing: <Image systemName={running ? "waveform" : "pause.fill"} size={22} color="#ffffff" />,
    expandedBottom: <VStack spacing={8} modifiers={[padding({ top: 10 })]}>{progress}{output}</VStack>,
  };
};

export default createLiveActivity("AmbraNowPlaying", NowPlayingActivity);
