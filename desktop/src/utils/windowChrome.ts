export type DesktopPlatform = "windows" | "linux" | "other";

export function desktopPlatform(userAgent = navigator.userAgent): DesktopPlatform {
  if (userAgent.includes("Windows")) return "windows";
  if (userAgent.includes("Linux") && !userAgent.includes("Android")) return "linux";
  return "other";
}

/**
 * On Windows the window's focus event is the page itself gaining focus, so handing focus
 * back to the page there makes WebView2 cycle focus and report it again, in a loop that
 * starves the window's thread (dragging the window stops working).
 */
export function pageNeedsFocusOnActivation(platform = desktopPlatform()) {
  return platform !== "windows";
}

/** Only macOS draws the window's title bar inside the page; Windows and Linux keep their native one. */
export function canUseWindowDragRegion(
  platform: DesktopPlatform,
  isFullscreen: boolean | null,
) {
  return platform === "other" && isFullscreen === false;
}
