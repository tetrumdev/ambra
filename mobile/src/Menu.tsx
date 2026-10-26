import { StyleSheet, Text, View } from "react-native";
import type { Track } from "./client";
import { Icon, type IconName } from "./Icons";
import { Sheet } from "./Sheet";
import { colors, fonts } from "./theme";
import { Touchable } from "./Touchable";
import { Artwork } from "./Artwork";

export type MenuAction = { label: string; icon: IconName; destructive?: boolean; run: () => void };

/** A song's options, named and ordered as in desktop's menus (TrackPlaybackMenu, Queue). */
export function Menu({ track, actions, onClose }: { track: Track; actions: MenuAction[]; onClose: () => void }) {
  return (
    <Sheet
      label={`Options for ${track.name}`}
      onClose={onClose}
      dragAnywhere
      grip={<View style={styles.heading}>
        <Artwork track={track} size={52} />
        <View style={styles.headingText}>
          <Text numberOfLines={1} style={styles.title}>{track.name}</Text>
          <Text numberOfLines={1} style={styles.artist}>{track.artist}</Text>
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
  heading: { flexDirection: "row", alignItems: "center", gap: 14, paddingHorizontal: 8, paddingTop: 10, paddingBottom: 16, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line, marginBottom: 6 },
  headingText: { flex: 1, gap: 4 },
  title: { color: "white", fontFamily: fonts.sans, fontSize: 16, fontWeight: "600" },
  artist: { color: colors.muted, fontFamily: fonts.sans, fontSize: 13 },
  actions: { paddingBottom: 4 },
  action: { flexDirection: "row", alignItems: "center", gap: 16, height: 54, paddingHorizontal: 12, borderRadius: 14, borderCurve: "continuous" },
  icon: { width: 22, alignItems: "center" },
  label: { color: "white", fontFamily: fonts.sans, fontSize: 16 },
});
