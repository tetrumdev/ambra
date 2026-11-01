export type DesktopPlatform = "windows" | "linux" | "other";

export function desktopPlatform(userAgent = navigator.userAgent): DesktopPlatform {
  if (userAgent.includes("Windows")) return "windows";
  if (userAgent.includes("Linux") && !userAgent.includes("Android")) return "linux";
  return "other";
}

/** Only macOS draws the window's title bar inside the page; Windows and Linux keep their native one. */
export function canUseWindowDragRegion(
  platform: DesktopPlatform,
  isFullscreen: boolean | null,
) {
  return platform === "other" && isFullscreen === false;
}
