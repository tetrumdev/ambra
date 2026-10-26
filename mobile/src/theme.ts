import * as Haptics from "expo-haptics";

/**
 * Phones have OLED panels, so the app sits on true black (desktop keeps #0a0a0a for LCDs).
 * Raised surfaces are the only non-black areas, and they stay dark enough to read as glass on black.
 */
export const PRESSED_ALPHA = 0.07;
export const colors = {
  black: "#000000",
  raised: "#121212",
  line: "#232323",
  text: "white",
  secondary: "#b3b3b3",
  muted: "rgba(255, 255, 255, 0.55)",
  faint: "rgba(255, 255, 255, 0.35)",
  // --error-text in desktop/src/App.css.
  error: "#ffb4b4",
};

export const fonts = { sans: "Stack Sans Text", serif: "Source Serif 4" };

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
