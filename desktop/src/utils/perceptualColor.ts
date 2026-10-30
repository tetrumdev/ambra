// Oklab's linear-sRGB matrices, published by Björn Ottosson:
// https://bottosson.github.io/posts/oklab/#converting-from-linear-srgb-to-oklab
const rgbToLms = [
  [0.4122214708, 0.5363325363, 0.0514459929],
  [0.2119034982, 0.6806995451, 0.1073969566],
  [0.0883024619, 0.2817188376, 0.6299787005],
];
const lmsToLab = [
  [0.2104542553, 0.7936177850, -0.0040720468],
  [1.9779984951, -2.4285922050, 0.4505937099],
  [0.0259040371, 0.7827717662, -0.8086757660],
];
// The inverse, from the same source.
const labToLms = [
  [1, 0.3963377774, 0.2158037573],
  [1, -0.1055613458, -0.0638541728],
  [1, -0.0894841775, -1.2914855480],
];
const lmsToRgb = [
  [4.0767416621, -3.3077115913, 0.2309699292],
  [-1.2684380046, 2.6097574011, -0.3413193965],
  [-0.0041960863, -0.7034186147, 1.7076147010],
];
const dot = (left: number[], right: number[]) => left.reduce((sum, value, index) => sum + value * right[index], 0);

export const linearChannel = (value: number) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
const srgbChannel = (value: number) => value <= 0.0031308 ? 12.92 * value : 1.055 * value ** (1 / 2.4) - 0.055;

/** Display sRGB to perceptual lightness and two opponent color coordinates. */
export function perceptualColor(rgb: number[]): number[] {
  const linear = rgb.map(linearChannel);
  const lms = rgbToLms.map(row => Math.cbrt(dot(row, linear)));
  return lmsToLab.map(row => dot(row, lms));
}

/** The inverse of perceptualColor, clamped into display sRGB. */
export function srgbFromPerceptual(lab: number[]): number[] {
  const lms = labToLms.map(row => dot(row, lab) ** 3);
  return lmsToRgb.map(row => Math.min(1, Math.max(0, srgbChannel(Math.max(0, dot(row, lms))))));
}
