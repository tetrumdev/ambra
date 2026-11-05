import { useLayoutEffect } from "react";
import { StyleSheet, Text, View } from "react-native";
import type { Track } from "./client";
import { Icon, type IconName } from "./Icons";
import { Sheet } from "./Sheet";
import { colors, fonts } from "./theme";
import { Touchable } from "./Touchable";
import { Artwork } from "./Artwork";

export type MenuAction = { label: string; icon: IconName; destructive?: boolean; disabled?: boolean; run: () => void };

/** A song's options, named and ordered as in desktop's menus (TrackPlaybackMenu, Queue). */
export function Menu({ track, title, subtitle, actions, onClose, onVisibilityChange }: {
  /** The song the menu is for; collection menus give a `title` instead. */
  track?: Track;
  title?: string;
  subtitle?: string;
  actions: MenuAction[];
  onClose: () => void;
  onVisibilityChange?: (visible: boolean) => void;
}) {
  useLayoutEffect(() => {
    onVisibilityChange?.(true);
    return () => onVisibilityChange?.(false);
  }, [onVisibilityChange]);
  return (
    <Sheet
      label={`Options for ${track?.name ?? title ?? ""}`}
      onClose={onClose}
      variant="menu"
      dragAnywhere
      grip={<View style={styles.heading}>
        {track && <Artwork track={track} size={40} />}
        <View style={styles.headingText}>
          <Text numberOfLines={1} style={styles.title}>{track?.name ?? title}</Text>
          {(track?.artist ?? subtitle) && <Text numberOfLines={1} style={styles.artist}>{track?.artist ?? subtitle}</Text>}
        </View>
      </View>}
    >
      {close => <View style={styles.actions}>
        {actions.map(action => (
          <Touchable
            key={action.label}
            accessibilityRole="button"
            highlight
            scale={0.98}
            haptic="select"
            disabled={action.disabled}
            onPress={() => { close(); action.run(); }}
            style={styles.action}
          >
            <View style={styles.icon}><Icon name={action.icon} size={18} color={action.destructive ? colors.error : "white"} /></View>
            <Text style={[styles.label, action.destructive && { color: colors.error }]}>{action.label}</Text>
          </Touchable>
        ))}
      </View>}
    </Sheet>
  );
}

const styles = StyleSheet.create({
  heading: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 15, paddingTop: 8, paddingBottom: 14, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: "#2f2f2f", backgroundColor: "rgba(29, 29, 29, 0.7)" },
  headingText: { flex: 1, gap: 4 },
  title: { color: "white", fontFamily: fonts.sans, fontSize: 14, fontWeight: "500" },
  artist: { color: colors.muted, fontFamily: fonts.sans, fontSize: 13 },
  actions: { paddingBottom: 4 },
  action: { flexDirection: "row", alignItems: "center", gap: 10, height: 45, paddingHorizontal: 15, backgroundColor: "rgba(29, 29, 29, 0.7)" },
  icon: { width: 22, alignItems: "center" },
  label: { color: "white", fontFamily: fonts.sans, fontSize: 14 },
});
