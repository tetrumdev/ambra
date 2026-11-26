import { useEffect, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { BlurView } from "expo-blur";
import Animated, { FadeIn, FadeOut } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Touchable } from "./Touchable";
import { colors, fonts, textSize } from "./theme";

/** Said when the dot is tapped; the bridge's own states read as one plain sentence. */
function explain(message: string | null, offline: boolean) {
  if (offline) return "Can't reach your server. Songs downloaded to this phone still play.";
  if (!message || /^Server (connecting|authenticating|reconnecting|starting)/i.test(message)) return "Connecting to your server…";
  return message;
}

/**
 * The connection's state, kept out of the way: a small dot in the top corner of the pages
 * (never over the open player). Tapped, it says what's going on.
 */
export function StatusDot({ message, offline, hidden }: { message: string | null; offline: boolean; hidden: boolean }) {
  const insets = useSafeAreaInsets();
  const [opened, setOpen] = useState(false);
  const shown = !hidden && (offline || !!message);
  // Hidden (the player opened, or all is well), it shows closed; it closes itself after a while.
  const open = opened && shown;
  useEffect(() => {
    if (!opened) return;
    const timer = setTimeout(() => setOpen(false), 6000);
    return () => clearTimeout(timer);
  }, [opened]);
  if (!shown) return null;
  const text = explain(message, offline);
  return <>
    <Animated.View entering={FadeIn.duration(240)} exiting={FadeOut.duration(160)} style={[styles.anchor, { top: insets.top }]}>
      <Touchable accessibilityRole="button" accessibilityLabel={text} haptic="select" scale={0.8} onPress={() => setOpen(value => !value)} style={styles.hit}>
        <View style={[styles.dot, offline && styles.offline]} />
      </Touchable>
    </Animated.View>
    {open && <Animated.View entering={FadeIn.duration(180)} exiting={FadeOut.duration(140)} style={[styles.panel, { top: insets.top + 34 }]}>
      <Touchable accessibilityRole="button" accessibilityLabel="Dismiss" scale={0.98} onPress={() => setOpen(false)}>
        <BlurView tint="dark" intensity={40} style={StyleSheet.absoluteFill} />
        <Text style={styles.text}>{text}</Text>
      </Touchable>
    </Animated.View>}
  </>;
}

const styles = StyleSheet.create({
  anchor: { position: "absolute", right: 6, zIndex: 20 },
  hit: { width: 32, height: 32, alignItems: "center", justifyContent: "center" },
  dot: { width: 7, height: 7, borderRadius: 4, backgroundColor: "rgba(255, 255, 255, 0.4)" },
  offline: { backgroundColor: "rgba(232, 176, 104, 0.7)" },
  panel: {
    position: "absolute", right: 12, maxWidth: 260, zIndex: 20, overflow: "hidden", borderRadius: 14, borderCurve: "continuous",
    backgroundColor: "rgba(28, 28, 28, 0.6)", borderWidth: StyleSheet.hairlineWidth, borderColor: "rgba(255, 255, 255, 0.12)",
  },
  text: { paddingHorizontal: 14, paddingVertical: 11, color: colors.secondary, fontFamily: fonts.sans, fontSize: textSize.detail, lineHeight: 19 },
});
