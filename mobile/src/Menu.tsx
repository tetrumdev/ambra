import { useLayoutEffect } from "react";
import { StyleSheet, Text, View } from "react-native";
import type { Track } from "./client";
import { Icon, type IconName } from "./Icons";
import { Sheet } from "./Sheet";
import { colors, fonts, sizes, space, textSize } from "./theme";
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
            <View style={styles.icon}><Icon name={action.icon} size={sizes.menuIcon} color={action.destructive ? colors.error : colors.text} /></View>
            <Text style={[styles.label, action.destructive && { color: colors.error }]}>{action.label}</Text>
          </Touchable>
        ))}
      </View>}
    </Sheet>
  );
}

const styles = StyleSheet.create({
  heading: { flexDirection: "row", alignItems: "center", gap: space.md, padding: space.lg, paddingTop: space.sm, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  headingText: { flex: 1, gap: space.xs },
  title: { color: colors.text, fontFamily: fonts.sans, fontSize: textSize.small, fontWeight: "500" },
  artist: { color: colors.muted, fontFamily: fonts.sans, fontSize: textSize.detail },
  actions: { paddingBottom: space.xs },
  action: { flexDirection: "row", alignItems: "center", gap: space.md, minHeight: sizes.touch, paddingHorizontal: space.lg, paddingVertical: space.sm },
  icon: { width: sizes.icon, alignItems: "center" },
  label: { flex: 1, color: colors.text, fontFamily: fonts.sans, fontSize: textSize.small },
});
