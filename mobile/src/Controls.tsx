import * as Haptics from "expo-haptics";
import { useEffect, useState, type ReactNode } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import Animated, {
  Easing,
  useAnimatedProps,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import Svg, { G, Path } from "react-native-svg";
import { playerTiming } from "./playerMotion";

const AnimatedPath = Animated.createAnimatedComponent(Path);

// The desktop's controls (desktop/src/components/PlayerControls.tsx), drawn natively.
type Point = [number, number];
// Play is split down the middle into two halves that fold into the pause bars,
// so every corner has a partner and the icon morphs instead of swapping.
const PLAY: Point[][] = [
  [
    [5, 3],
    [13.2, 7.73],
    [13.2, 16.27],
    [5, 21],
  ],
  [
    [12.8, 7.5],
    [20.6, 12],
    [20.6, 12],
    [12.8, 16.5],
  ],
];
const PAUSE: Point[][] = [
  [
    [5.5, 3],
    [9.75, 3],
    [9.75, 21],
    [5.5, 21],
  ],
  [
    [14.25, 3],
    [18.5, 3],
    [18.5, 21],
    [14.25, 21],
  ],
];

function morph(half: number, progress: number) {
  "worklet";
  return (
    PLAY[half]
      .map(([x, y], index) => {
        const [toX, toY] = PAUSE[half][index];
        return `${index ? "L" : "M"}${x + (toX - x) * progress} ${y + (toY - y) * progress}`;
      })
      .join("") + "Z"
  );
}

function PlayPauseIcon({ playing, size }: { playing: boolean; size: number }) {
  const progress = useSharedValue(playing ? 1 : 0);
  useEffect(() => {
    progress.set(
      withTiming(playing ? 1 : 0, {
        duration: 320,
        easing: Easing.inOut(Easing.poly(4)),
      }),
    );
  }, [playing, progress]);
  const left = useAnimatedProps(() => ({ d: morph(0, progress.value) }));
  const right = useAnimatedProps(() => ({ d: morph(1, progress.value) }));
  return (
    <Svg width={size} height={size} viewBox="3 3 18 18">
      <AnimatedPath animatedProps={left} fill="white" />
      <AnimatedPath animatedProps={right} fill="white" />
    </Svg>
  );
}

// Three triangles roll through two visible positions: the one behind grows in as the
// front one shrinks away. Each skip restarts the roll.
const STEP = 191.25;
function triangle(left: number, scale: number) {
  "worklet";
  const centerX = left + 119.375;
  const x = (value: number) => centerX + (value - centerX) * scale;
  const y = (value: number) => 138 + (value - 138) * scale;
  return `M${x(left)} ${y(0)}L${x(left + 238.75)} ${y(138)}L${x(left)} ${y(276)}Z`;
}

function SkipIcon({
  backwards = false,
  activation,
  width,
}: {
  backwards?: boolean;
  activation: number;
  width: number;
}) {
  const roll = useSharedValue(1);
  useEffect(() => {
    if (activation === 0) return;
    roll.set(0);
    roll.set(
      withTiming(1, playerTiming),
    );
  }, [activation, roll]);
  // At rest (roll 1) the shapes match the starting arrangement, so the next roll begins without a jump.
  const entering = useAnimatedProps(() => {
    const t = roll.value % 1;
    return { d: triangle(-STEP + STEP * t, t), opacity: t };
  });
  const middle = useAnimatedProps(() => ({
    d: triangle(STEP * (roll.value % 1), 1),
  }));
  const leaving = useAnimatedProps(() => {
    const t = roll.value % 1;
    return { d: triangle(STEP + STEP * t, 1 - t), opacity: 1 - t };
  });
  return (
    <Svg width={width} height={(width * 276) / 430} viewBox="0 0 430 276">
      <G
        transform={backwards ? "translate(430 276) rotate(180)" : undefined}
        fill="white"
      >
        <AnimatedPath animatedProps={entering} />
        <AnimatedPath animatedProps={middle} />
        <AnimatedPath animatedProps={leaving} />
      </G>
    </Svg>
  );
}

const press = { damping: 15, stiffness: 400, mass: 0.6 };

function ControlButton({
  label,
  onPress,
  haptic,
  disabled,
  children,
}: {
  label: string;
  onPress: () => void;
  haptic: Haptics.ImpactFeedbackStyle;
  disabled: boolean;
  children: ReactNode;
}) {
  const down = useSharedValue(0);
  const icon = useAnimatedStyle(() => ({
    transform: [{ scale: 1 - 0.18 * down.value }],
  }));
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      hitSlop={8}
      onPressIn={() => {
        down.set(withTiming(1, { duration: 90 }));
        void Haptics.impactAsync(haptic);
      }}
      onPressOut={() => down.set(withSpring(0, press))}
      onPress={onPress}
      style={[styles.button, disabled && styles.disabled]}
    >
      <Animated.View style={icon}>{children}</Animated.View>
    </Pressable>
  );
}

export function Controls({
  playing,
  disabled,
  onPrevious,
  onToggle,
  onNext,
}: {
  playing: boolean;
  disabled: boolean;
  onPrevious: () => void;
  onToggle: () => void;
  onNext: () => void;
}) {
  const [activations, setActivations] = useState({ previous: 0, next: 0 });
  return (
    <View style={styles.row}>
      <ControlButton
        label="Previous"
        disabled={disabled}
        haptic={Haptics.ImpactFeedbackStyle.Light}
        onPress={() => {
          setActivations((current) => ({
            ...current,
            previous: current.previous + 1,
          }));
          onPrevious();
        }}
      >
        <SkipIcon backwards activation={activations.previous} width={38} />
      </ControlButton>
      <ControlButton
        label={playing ? "Pause" : "Play"}
        disabled={disabled}
        haptic={Haptics.ImpactFeedbackStyle.Medium}
        onPress={onToggle}
      >
        <PlayPauseIcon playing={playing} size={36} />
      </ControlButton>
      <ControlButton
        label="Next"
        disabled={disabled}
        haptic={Haptics.ImpactFeedbackStyle.Light}
        onPress={() => {
          setActivations((current) => ({ ...current, next: current.next + 1 }));
          onNext();
        }}
      >
        <SkipIcon activation={activations.next} width={38} />
      </ControlButton>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    justifyContent: "center",
    alignItems: "center",
    gap: 36,
  },
  button: {
    width: 50,
    height: 50,
    alignItems: "center",
    justifyContent: "center",
  },
  disabled: { opacity: 0.35 },
});
