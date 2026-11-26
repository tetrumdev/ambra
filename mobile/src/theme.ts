import * as Haptics from "expo-haptics";
import { interactionTiming } from "../../desktop/src/utils/interactionTiming";

/**
 * AMOLED: phones have OLED panels, where black pixels are off. Everything sits on true black,
 * surfaces are only a breath above it, and edges come from hairlines rather than gray fills,
 * so the screen stays dark around the artwork (desktop keeps #0a0a0a for LCDs).
 */
export const PRESSED_ALPHA = 0.08;
export const colors = {
  black: "#000000",
  raised: "#0a0a0a",
  field: "#0c0c0c",
  selected: "#1f1f1f",
  line: "#242424",
  control: "#4a4a4a",
  text: "white",
  secondary: "#b3b3b3",
  muted: "#9a999a",
  faint: "#7a7a7a",
  accent: "#e6d3b1",
  accentInk: "#241b0e",
  menu: "rgba(12, 12, 12, 0.9)",
  scrim: "rgba(0, 0, 0, 0.75)",
  destructive: "#5e1a1a",
  error: "#ffb4b4",
};

export const fonts = { sans: "Stack Sans Text", serif: "Source Serif 4" };
export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 20, xxl: 24, section: 32 };
export const radius = { xs: 4, sm: 8, field: 10, md: 12, lg: 16, sheet: 28, pill: 999 };
export const textSize = { caption: 12, detail: 13, small: 14, body: 16, heading: 20, page: 38 };
export const sizes = { touch: 44, field: 48, icon: 20, menuIcon: 18 };
export const disabledOpacity = 0.5;
export const motion = {
  ...interactionTiming,
  sheetIn: { damping: 32, stiffness: 340, mass: 1, overshootClamping: true },
  sheetSettle: { damping: 22, stiffness: 300, mass: 0.8 },
  sheetOut: 200,
  sheetFlick: 180,
};

/**
 * Springs for things under a finger. Velocity carries over from the gesture, so a flick keeps
 * its momentum and a slow release settles gently. All are close to critically damped: things
 * flow to rest like a fluid rather than wobbling like a spring.
 */
export const springs = {
  /** Tabs, pages and rows coming to rest. */
  settle: { damping: 36, stiffness: 320, mass: 1 },
  /** Small things moving into place: lenses, toggles, icons. */
  snappy: { damping: 32, stiffness: 420, mass: 0.7 },
  /** Things that grow: an armed swipe action, a toggle filling. The faintest overshoot. */
  bouncy: { damping: 26, stiffness: 340, mass: 0.7 },
  /** Released drags and presses returning to rest. */
  release: { damping: 30, stiffness: 360, mass: 0.7 },
};

/** Past an end, a drag gives less and less: the further you pull, the harder it resists. */
export function rubberBand(distance: number, dimension: number, resistance = 0.55) {
  "worklet";
  const sign = distance < 0 ? -1 : 1;
  const magnitude = Math.abs(distance);
  return sign * (1 - 1 / (magnitude * resistance / Math.max(1, dimension) + 1)) * dimension;
}

/**
 * Desktop's frosted glass, kept nearly black for OLED: blur gives depth, a hairline the edge.
 * (Only the feel of Apple's Liquid Glass is borrowed, through motion, not its material.)
 */
export const glass = {
  panel: "rgba(10, 10, 10, 0.78)",
  dock: "rgba(0, 0, 0, 0.62)",
  /** The pill behind the chosen tab, segment or option. */
  lens: "rgba(255, 255, 255, 0.11)",
  border: "rgba(255, 255, 255, 0.08)",
};

const ignore = () => {};
/** One vocabulary of touch feedback for the whole app. */
export const haptic = {
  /** A detent: crossing a tab, a row slot, a threshold you can still go back from. */
  tick: () => void Haptics.selectionAsync().catch(ignore),
  /** Something lifting off under the finger (a held row, a squeezed card). */
  soft: () => void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Soft).catch(ignore),
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
