// Oklab's linear-sRGB matrices, published by Björn Ottosson:
// https://bottosson.github.io/posts/oklab/#converting-from-linear-srgb-to-oklab
// Keep the CPU edge samples and the fragment shader on the same coefficients.
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
const dot = (left: number[], right: number[]) => left.reduce((sum, value, index) => sum + value * right[index], 0);

export const linearChannel = (value: number) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;

/** Display sRGB to perceptual lightness and two opponent color coordinates. */
export function perceptualColor(rgb: number[]): number[] {
  const linear = rgb.map(linearChannel);
  const lms = rgbToLms.map(row => Math.cbrt(dot(row, linear)));
  return lmsToLab.map(row => dot(row, lms));
}

const glslDots = (matrix: number[][], input: string) => matrix.map(row => `dot(${input}, vec3(${row.join(", ")}))`).join(",\n    ");

export const perceptualColorShader = `
vec3 linearFromSrgb(vec3 color) {
  return mix(color / 12.92, pow((color + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), color));
}
vec3 srgbFromLinear(vec3 color) {
  color = max(color, 0.0);
  return mix(12.92 * color, 1.055 * pow(color, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), color));
}
vec3 perceptualFromLinear(vec3 linear) {
  vec3 lms = pow(max(vec3(
    ${glslDots(rgbToLms, "linear")}
  ), 0.0), vec3(1.0 / 3.0));
  return vec3(
    ${glslDots(lmsToLab, "lms")}
  );
}
`;
