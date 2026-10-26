export const MINI_HEIGHT = 64;
export const NAVIGATION_HEIGHT = 48;
export const MINI_ART_SIZE = 44;

export function playerLayout(width: number, height: number, topInset: number, bottomInset: number) {
  const miniBottom = bottomInset + NAVIGATION_HEIGHT + 8;
  const miniTop = Math.max(0, height - miniBottom - MINI_HEIGHT);
  const coverSize = Math.max(1, Math.min(width - 60, height - topInset - bottomInset - 336));
  const coverTop = topInset + 44;
  const coverLeft = (width - coverSize) / 2;
  const infoTop = coverTop + coverSize + 40;
  const progressTop = infoTop + 78;
  const footerTop = height - bottomInset - 52;
  const controlsTop = progressTop + 56 + Math.max(0, (footerTop - progressTop - 106) * 0.4);
  const lyricsTop = coverTop + 78;
  const lyricsProgressTop = height - bottomInset - 184;
  const lyricsControlsTop = height - bottomInset - 124;
  const lyricsHeight = Math.max(80, lyricsProgressTop - lyricsTop - 18);
  return { width, height, miniBottom, miniTop, coverSize, coverTop, coverLeft, infoTop, progressTop, controlsTop, lyricsTop, lyricsProgressTop, lyricsControlsTop, lyricsHeight };
}

export type PlayerLayout = ReturnType<typeof playerLayout>;

function mix(from: number, to: number, amount: number) {
  "worklet";
  return from + (to - from) * amount;
}

function smooth(value: number) {
  "worklet";
  const t = Math.min(1, Math.max(0, value));
  return t * t * (3 - 2 * t);
}

/** One coordinate system for the surface, artwork and text throughout a reversible drag. */
export function playerFrame(layout: PlayerLayout, expansion: number, pausedScale = 1, lyrics = 0) {
  "worklet";
  const p = Math.min(1, Math.max(0, expansion));
  const l = Math.min(1, Math.max(0, lyrics));
  const width = mix(layout.width - 16, layout.width, p);
  const artSize = mix(MINI_ART_SIZE, mix(layout.coverSize * pausedScale, 56, l), p);
  const inset = layout.coverSize * (1 - pausedScale) / 2;
  const artLeft = mix(10, mix(layout.coverLeft + inset, 30, l), p);
  const artTop = mix(10, mix(layout.coverTop + inset, layout.coverTop, l), p);
  const slotBottom = mix(10 + MINI_ART_SIZE, layout.coverTop + layout.coverSize, p);
  // Change text placement and typography only while invisible, instead of orbiting the artwork.
  const textExpanded = p >= 0.35;
  const textHeader = textExpanded && l >= 0.5;
  const textLeft = textExpanded ? (textHeader ? 100 : 30) : 66;
  const textTop = textExpanded ? (textHeader ? layout.coverTop + 7 : slotBottom + 40 * p) : 14;
  const modeOpacity = l < 0.5 ? 1 - smooth(l / 0.4) : smooth((l - 0.6) / 0.4);
  const textOpacity = textExpanded ? smooth((p - 0.45) / 0.4) * modeOpacity : 1 - smooth(p / 0.22);
  return {
    expansion: p,
    left: mix(8, 0, p),
    top: mix(layout.miniTop, 0, p),
    width,
    height: mix(MINI_HEIGHT, layout.height, p),
    artLeft,
    artTop,
    artSize,
    artScale: artSize / layout.coverSize,
    artRadius: mix(6, mix(15, 8, l), p),
    textLeft,
    textTop,
    textExpanded,
    textHeader,
    textOpacity,
    textWidth: Math.max(1, width - textLeft - (textExpanded ? 30 : 96)),
  };
}
