import { swirlShares } from "../../desktop/src/utils/swirlProportions";

/**
 * Black laid over the swirl, top to bottom, so the white title, progress bar and controls read
 * against any cover. Stay within the desktop lyrics backdrop's 24–48% black range
 * (#lyricsPage in desktop/src/components/LyricsView.css), with a little more shade under
 * the controls. Bright covers get gentle extra dimming within that same range.
 */
const BANDS = [
  { at: 0, ceiling: 0.45, least: 0.24 },
  { at: 0.4, ceiling: 0.36, least: 0.28 },
  { at: 0.55, ceiling: 0.3, least: 0.34 },
  { at: 1, ceiling: 0.24, least: 0.4 },
] as const;
const MOST = 0.48;
/** Colors covering less of the swirl than this are passing glints, not what sits under text. */
const NOTICEABLE_SHARE = 0.08;
/** The shader's own lift: saturation, then up to this much brightening by its texture. */
const SHADER_BRIGHTEST = 1.06;

const linear = (channel: number) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
function luminance(hex: string) {
  if (!/^#[0-9a-f]{6}$/i.test(hex)) return 0;
  const [red, green, blue] = [1, 3, 5].map(offset => linear(Math.min(1, (Number.parseInt(hex.slice(offset, offset + 2), 16) / 255) * SHADER_BRIGHTEST)));
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

/** How dark each band must be for the brightest color that covers a noticeable part of the swirl. */
export function backdropAlphas(colors: string[], weights: number[]) {
  const shares = swirlShares(weights.slice(0, colors.length));
  const brightest = Math.max(0, ...colors.map((color, index) => (shares[index] ?? 0) >= NOTICEABLE_SHARE ? luminance(color) : 0));
  // Blending happens on display values, which reach light about as their 2.2th power.
  return BANDS.map(band => brightest <= band.ceiling
    ? band.least
    : Math.min(MOST, Math.max(band.least, 1 - (band.ceiling / brightest) ** (1 / 2.2))));
}

/** Applied in the swirl's draw, so darkness and palette always share the same transition. */
export const backdropShader = `
uniform vec4 u_backdrop;
void main() {
  swirlMain();
  float y = 1.0 - gl_FragCoord.y / u_resolution.y;
  float alpha;
  if (y < ${BANDS[1].at}) {
    alpha = mix(u_backdrop.x, u_backdrop.y, clamp(y / ${BANDS[1].at}, 0.0, 1.0));
  } else if (y < ${BANDS[2].at}) {
    alpha = mix(u_backdrop.y, u_backdrop.z, (y - ${BANDS[1].at}) / ${BANDS[2].at - BANDS[1].at});
  } else {
    alpha = mix(u_backdrop.z, u_backdrop.w, clamp((y - ${BANDS[2].at}) / ${BANDS[3].at - BANDS[2].at}, 0.0, 1.0));
  }
  gl_FragColor.rgb *= 1.0 - alpha;
}
`;
