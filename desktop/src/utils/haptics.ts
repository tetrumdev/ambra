import { invoke, isTauri } from "@tauri-apps/api/core";

const MAC = isTauri() && navigator.userAgent.includes("Mac");

/**
 * macOS's three trackpad taps. Strength can't be set, only the pattern: `levelChange` is the
 * firmest, `alignment` the lightest, for small repeated ticks.
 */
export type HapticPattern = "generic" | "alignment" | "levelChange";

/** One tap on a Force Touch trackpad, felt only while a finger is on it; nothing elsewhere. */
export function haptic(pattern: HapticPattern = "alignment") {
  if (MAC) void invoke("trackpad_haptic", { pattern }).catch(() => {});
}
