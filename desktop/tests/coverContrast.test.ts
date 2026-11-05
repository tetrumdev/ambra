import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  COVER_EDGE_ZONES, SWIRL_SATURATION, SWIRL_SHADE_MIN, SWIRL_SHADE_RANGE,
  coverEdgeSamples, separatePaletteFromCover, type CoverEdgeSamples,
} from "../src/utils/backgroundPalette";
import { fragmentShaderSource, paletteComponents, vertexShaderSource } from "../src/utils/swirlShader";
import { perceptualColor, srgbFromPerceptual } from "../src/utils/perceptualColor";

const rgb = (hex: string) => [1, 3, 5].map(offset => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255);
const lightness = (hex: string) => perceptualColor(rgb(hex))[0];
const edgesOf = (colors: number[][]): CoverEdgeSamples => ({
  colors: Array.from({ length: COVER_EDGE_ZONES * 4 }, (_, index) => colors[index % colors.length]).flat(),
});
/** The least perceptual distance, beyond what each edge needs, at every shade the swirl draws `hex`. */
function clearance(hex: string, edges: CoverEdgeSamples, dim = 1) {
  const color = rgb(hex);
  const gray = 0.2126 * color[0] + 0.7152 * color[1] + 0.0722 * color[2];
  const vivid = color.map(channel => gray + (channel - gray) * SWIRL_SATURATION);
  let least = Infinity;
  for (let step = 0; step <= 20; step++) {
    const shade = SWIRL_SHADE_MIN + SWIRL_SHADE_RANGE * step / 20;
    const field = perceptualColor(vivid.map(channel => dim * Math.min(1, Math.max(0, channel * shade))));
    for (let index = 0; index < COVER_EDGE_ZONES * 4; index++) {
      const edge = perceptualColor(edges.colors.slice(index * 3, index * 3 + 3));
      least = Math.min(least, Math.hypot(field[0] - edge[0], field[1] - edge[1], field[2] - edge[2]) - Math.max(0.07, 0.16 - edge[0]));
    }
  }
  return least;
}

test("perceptual color conversion preserves reference black, white, and saturated red, both ways", () => {
  const near = (actual: number[], expected: number[]) => actual.forEach((value, index) => expect(value).toBeCloseTo(expected[index], 5));
  near(perceptualColor([0, 0, 0]), [0, 0, 0]);
  near(perceptualColor([1, 1, 1]), [1, 0, 0]);
  near(perceptualColor([1, 0, 0]), [0.627955, 0.224863, 0.125846]);
  for (const color of [[0, 0, 0], [1, 1, 1], [1, 0, 0], [0.2, 0.5, 0.7], [0, 0.07, 0.1]]) {
    near(srgbFromPerceptual(perceptualColor(color)), color);
  }
});

test("contrast samples actual boundary colors instead of averaging unrelated interior pixels", () => {
  const size = 64;
  const pixels = new Uint8ClampedArray(size * size * 4).fill(128);
  for (let zone = 0; zone < COVER_EDGE_ZONES; zone++) {
    const x = Math.floor((zone + 0.5) * size / COVER_EDGE_ZONES);
    const value = zone % 2 ? 240 : 8;
    pixels.set([value, value, value, 255], x * 4);
  }
  const samples = coverEdgeSamples(pixels, size);
  for (let zone = 0; zone < COVER_EDGE_ZONES; zone++) {
    const value = (zone % 2 ? 240 : 8) / 255;
    expect(samples.colors.slice(zone * 12, zone * 12 + 3)).toEqual([value, value, value]);
  }
});

test("an unreadable edge never invents a contrast problem from the cover palette", () => {
  const colors = ["#101010", "#202020", "#303030", "#404040"];
  expect(separatePaletteFromCover(colors, null)).toBe(colors);
  expect(separatePaletteFromCover(colors, { colors: [0, 0, 0] })).toBe(colors);
});

test("colors that already contrast with every edge sample are left exactly as they are", () => {
  const colors = ["#5a6066", "#868a8f", "#c0392b", "#2e86c1"];
  expect(separatePaletteFromCover(colors, edgesOf([[0, 0.07, 0.1]]))).toEqual(colors);
  // A multi-colored edge: the same palette is still distinct from both of its colors.
  expect(separatePaletteFromCover(colors, edgesOf([[0, 0.07, 0.1], [0.98, 0.95, 0.9]]))).toEqual(colors);
});

test("a swirl color matching the cover's border moves just far enough, keeping its hue", () => {
  // Joy Division, Unknown Pleasures: the swirl's dominant color is the border itself.
  const edges = edgesOf([[0, 18 / 255, 25 / 255]]);
  const colors = ["#001219", "#5a6066", "#333b41", "#868a8f"];
  for (const dim of [1, 0.59]) {
    const separated = separatePaletteFromCover(colors, edges, dim);
    expect(clearance(colors[0], edges, dim)).toBeLessThan(0);
    // Checked at more shades than the solver samples; a sliver of tolerance between them.
    expect(clearance(separated[0], edges, dim)).toBeGreaterThan(-0.003);
    // Lifting above a dark border requires more source lightness under a dim overlay.
    expect(Math.abs(lightness(separated[0]) - lightness(colors[0]))).toBeLessThan(0.12 / dim);
    const [, a, b] = perceptualColor(rgb(separated[0]));
    const [, a0, b0] = perceptualColor(rgb(colors[0]));
    expect(Math.atan2(b, a)).toBeCloseTo(Math.atan2(b0, a0), 0);
    // Intermediate colors may also need lifting to preserve order under the overlay.
    expect(separated[3]).toBe(colors[3]);
  }
});

test("lighter swirl colors stay lighter, and a black border lifts a black swirl", () => {
  const edges = edgesOf([[0, 0, 0]]);
  const colors = ["#000000", "#050505", "#0a0a0a", "#808080"];
  const separated = separatePaletteFromCover(colors, edges);
  for (const color of separated) expect(clearance(color, edges)).toBeGreaterThan(-0.003);
  const order = (palette: string[]) => palette.map(lightness);
  const before = order(colors);
  const after = order(separated);
  for (let index = 1; index < colors.length; index++) {
    if (before[index] > before[index - 1]) expect(after[index]).toBeGreaterThan(after[index - 1]);
  }
  expect(separated[3]).toBe("#808080");
});

test("a near-black border keeps a near-black swirl dark instead of lifting it to gray", () => {
  // twenty one pilots, Blurryface: grainy near-black border, mostly near-black cover.
  const edges = edgesOf([[14 / 255, 14 / 255, 14 / 255], [20 / 255, 20 / 255, 20 / 255], [24 / 255, 24 / 255, 24 / 255]]);
  const colors = ["#0e0e0e", "#1c1c1c", "#b8412c", "#d8d8d8"];
  const separated = separatePaletteFromCover(colors, edges);
  for (const color of separated) expect(clearance(color, edges)).toBeGreaterThan(-0.003);
  expect(lightness(separated[0])).toBeLessThan(lightness(colors[0]));
  expect(separated.slice(2)).toEqual(colors.slice(2));
});

test("a saturated swirl color matching the border stays recognizably the cover's color", () => {
  const red = [226 / 255, 0, 1 / 255];
  const edges = edgesOf([red]);
  const separated = separatePaletteFromCover(["#e20001", "#202020", "#202020", "#202020"], edges);
  expect(Math.abs(lightness(separated[0]) - lightness("#e20001"))).toBeLessThanOrEqual(0.141);
  const [r, g, b] = rgb(separated[0]);
  expect(r).toBeGreaterThan(g * 4);
  expect(r).toBeGreaterThan(b * 4);
});

test("a vivid cover whose edges hold every palette color keeps a vivid swirl", () => {
  // twenty one pilots, Clancy: red and yellow run off every side of the cover.
  const edges = edgesOf([[0.89, 0.24, 0.22], [0.99, 0.9, 0.12], [0.145, 0.145, 0.137], [0.92, 0.48, 0.2]]);
  const colors = ["#de4036", "#fbdc21", "#2f2a29", "#ec8730"];
  const separated = separatePaletteFromCover(colors, edges);
  for (const index of [0, 1, 3]) {
    // Colorful colors only darken, never wash out toward coral or pastel.
    expect(lightness(separated[index])).toBeLessThanOrEqual(lightness(colors[index]) + 0.001);
    expect(Math.abs(lightness(separated[index]) - lightness(colors[index]))).toBeLessThanOrEqual(0.141);
    const [, a, b] = perceptualColor(rgb(separated[index]));
    const [, a0, b0] = perceptualColor(rgb(colors[index]));
    expect(Math.hypot(a, b)).toBeGreaterThan(Math.hypot(a0, b0) * 0.8);
  }
});

test("a grayscale cover whose border runs from black to white keeps its grays", () => {
  // Billy Joel, The Stranger: white wall at the top, black bedding at the bottom.
  const edges = { colors: [0.1765, 0.1725, 0.1647, 0.1216, 0.1137, 0.1176, 0.5176, 0.5176, 0.5137, 0.2, 0.1961, 0.1882, 0.149, 0.1451, 0.1412, 0.1765, 0.1725, 0.1647, 0.2392, 0.2353, 0.2353, 0.3569, 0.3569, 0.3569, 0.1569, 0.1529, 0.1451, 0.2667, 0.2667, 0.2588, 0.3922, 0.3882, 0.3882, 0.8235, 0.8235, 0.8235, 0.1373, 0.1333, 0.1294, 0.0941, 0.0863, 0.0902, 0.1843, 0.1804, 0.1725, 0.9216, 0.9216, 0.9216, 0.149, 0.1451, 0.1412, 0.5804, 0.5804, 0.5804, 0.1961, 0.1922, 0.1843, 0.9373, 0.9373, 0.9373, 0.149, 0.1451, 0.1373, 0.1137, 0.1059, 0.1098, 0.1451, 0.1412, 0.1333, 0.9451, 0.9451, 0.9451, 0.1412, 0.1373, 0.1333, 0.1137, 0.1059, 0.1059, 0.1373, 0.1294, 0.1294, 0.3333, 0.3294, 0.3255, 0.1529, 0.149, 0.1412, 0.1098, 0.102, 0.1059, 0.1137, 0.1059, 0.1059, 0.4863, 0.4863, 0.4863] };
  const colors = ["#1e1c1c", "#e7e7e7", "#909090", "#515150"];
  const separated = separatePaletteFromCover(colors, edges);
  // No gray can clear every edge, so none is crushed into black.
  expect(separated.slice(1)).toEqual(colors.slice(1));
  expect(lightness(separated[0])).toBeLessThanOrEqual(lightness(colors[0]));
});

// Set AMBRA_TEST_CHROME to a Chromium executable to run the production GLSL in a real WebGL context.
test.skipIf(!process.env.AMBRA_TEST_CHROME)("the swirl draws only its palette, with no treatment anywhere near the cover", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ambra-cover-contrast-"));
  try {
    const components = paletteComponents(["#808080"], [1]);
    const html = `<!doctype html><canvas width="256" height="256"></canvas><pre id="result"></pre><script>
try {
  const gl = document.querySelector('canvas').getContext('webgl', { antialias: false });
  if (!gl) throw new Error('WebGL unavailable');
  gl.disable(gl.DITHER);
  function compile(type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source); gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
    return shader;
  }
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl.VERTEX_SHADER, ${JSON.stringify(vertexShaderSource)}));
  gl.attachShader(p, compile(gl.FRAGMENT_SHADER, ${JSON.stringify(fragmentShaderSource)}));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  gl.useProgram(p);
  const buffer = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1,3,-1,-1,3]), gl.STATIC_DRAW);
  const position = gl.getAttribLocation(p, 'a_position');
  gl.enableVertexAttribArray(position); gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
  const texture = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, 1, 1, 0, gl.LUMINANCE, gl.UNSIGNED_BYTE, new Uint8Array([128]));
  const components = ${JSON.stringify(components)};
  gl.uniform3fv(gl.getUniformLocation(p, 'u_colors[0]'), components.slice(0, 12));
  gl.uniform4fv(gl.getUniformLocation(p, 'u_bias'), components.slice(12, 16));
  gl.uniform2f(gl.getUniformLocation(p, 'u_resolution'), 256, 256);
  gl.uniform1f(gl.getUniformLocation(p, 'u_time'), 3);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  const pixels = new Uint8Array(256*256*4); gl.readPixels(0,0,256,256,gl.RGBA,gl.UNSIGNED_BYTE,pixels);
  // A constant noise texture leaves one shade; it must be the palette's at the shader's own range.
  const low = Math.floor(128 * ${SWIRL_SHADE_MIN}) - 1, high = Math.ceil(128 * ${SWIRL_SHADE_MIN + SWIRL_SHADE_RANGE}) + 1;
  for (let index = 0; index < pixels.length; index += 4) {
    if (pixels[index] < low || pixels[index] > high || pixels[index] !== pixels[0]) throw new Error('Unexpected shade ' + pixels[index]);
  }
  document.getElementById('result').textContent = JSON.stringify({ ok: true, shade: pixels[0] });
} catch (error) { document.getElementById('result').textContent = JSON.stringify({ error: String(error) }); }
</script>`;
    const path = join(directory, "contrast.html");
    await writeFile(path, html);
    const child = Bun.spawn([
      process.env.AMBRA_TEST_CHROME!, "--headless", "--no-sandbox", "--use-gl=angle",
      "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--dump-dom", pathToFileURL(path).href,
    ], { stdout: "pipe", stderr: "pipe" });
    const output = await new Response(child.stdout).text();
    const diagnostics = await new Response(child.stderr).text();
    expect(await child.exited, diagnostics).toBe(0);
    const result = output.match(/<pre id="result">(.*?)<\/pre>/s)?.[1];
    expect(result).toBeDefined();
    expect(JSON.parse(result!)).toMatchObject({ ok: true });
  } finally {
    expect(dirname(directory)).toBe(tmpdir());
    expect(basename(directory).startsWith("ambra-cover-contrast-")).toBe(true);
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
