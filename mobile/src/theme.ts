import * as Haptics from "expo-haptics";

/**
 * Phones have OLED panels, so the app sits on true black (desktop keeps #0a0a0a for LCDs).
 * Raised surfaces are the only non-black areas, and they stay dark enough to read as glass on black.
 */
export const PRESSED_ALPHA = 0.07;
export const colors = {
  black: "#000000",
  raised: "#121212",
  field: "#151515",
  selected: "#303030",
  line: "#2f2f2f",
  control: "#666666",
  text: "white",
  secondary: "#b3b3b3",
  muted: "#a3a2a3",
  faint: "#8a8a8a",
  accent: "#e6d3b1",
  accentInk: "#241b0e",
  menu: "rgba(29, 29, 29, 0.88)",
  scrim: "rgba(0, 0, 0, 0.7)",
  destructive: "#7a2323",
  error: "#ffb4b4",
};

export const fonts = { sans: "Stack Sans Text", serif: "Source Serif 4" };
export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 20, xxl: 24, section: 32 };
export const radius = { xs: 4, sm: 8, field: 10, md: 12, lg: 16, sheet: 28, pill: 999 };
export const textSize = { caption: 12, detail: 13, small: 14, body: 16, heading: 20, page: 38 };
export const sizes = { touch: 44, field: 48, icon: 20, menuIcon: 18 };
export const disabledOpacity = 0.5;
export const motion = {
  press: 110,
  release: { damping: 14, stiffness: 380, mass: 0.6 },
  sheetIn: { damping: 32, stiffness: 340, mass: 1, overshootClamping: true },
  sheetSettle: { damping: 22, stiffness: 300, mass: 0.8 },
  sheetOut: 200,
  sheetFlick: 180,
};

const ignore = () => {};
/** One vocabulary of touch feedback for the whole app. */
export const haptic = {
  /** Picking something from a list or menu. */
  select: () => void Haptics.selectionAsync().catch(ignore),
  /** An ordinary button. */
  tap: () => void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(ignore),
  /** A button that changes playback. */
  firm: () => void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(ignore),
  /** A hold that opened something, or a drag crossing its point of no return. */
  hold: () => void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Rigid).catch(ignore),
  success: () => void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(ignore),
  warning: () => void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(ignore),
  error: () => void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(ignore),
};
