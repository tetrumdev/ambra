export type DesktopPlatform = "windows" | "other";

export function canUseWindowDragRegion(
  platform: DesktopPlatform,
  isFullscreen: boolean | null,
) {
  return platform !== "windows" && isFullscreen === false;
}
