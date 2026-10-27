import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  COVER_EDGE_ZONES, coverEdgeSamples, coverSeparation, neutralCoverSeparation,
} from "../src/utils/backgroundPalette";
import { EDGE_COLORS_OFFSET, EDGE_COMPONENTS, fragmentShaderSource, paletteComponents, vertexShaderSource } from "../src/utils/swirlShader";
import { perceptualColor } from "../src/utils/perceptualColor";

test("perceptual color conversion preserves reference black, white, and saturated red", () => {
  const near = (rgb: number[], expected: number[]) => perceptualColor(rgb).forEach((value, index) => expect(value).toBeCloseTo(expected[index], 5));
  near([0, 0, 0], [0, 0, 0]);
  near([1, 1, 1], [1, 0, 0]);
  near([1, 0, 0], [0.627955, 0.224863, 0.125846]);
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
    expect(samples.luminances[zone * 4]).toBeCloseTo(value);
    expect(samples.colors.slice(zone * 12, zone * 12 + 3)).toEqual([value, value, value]);
  }
});

test("an unreadable edge never invents a contrast problem from the cover palette", () => {
  for (const dim of [1, 0.25]) {
    expect(coverSeparation(null, ["#101010"], [1], dim)).toBe(neutralCoverSeparation);
  }
});

test("RGB samples follow palette transitions without moving the mobile renderer's existing uniform offsets", () => {
  const samples = coverEdgeSamples(new Uint8Array(16 * 16 * 4).fill(64), 16);
  const separation = coverSeparation(samples, ["#101010"], [1]);
  const components = paletteComponents(["#101010"], [1], separation);
  const perceptual = Array.from({ length: EDGE_COMPONENTS }, (_, index) => perceptualColor(samples.colors.slice(index * 3, index * 3 + 3)));
  expect(components.slice(12, 12 + EDGE_COMPONENTS)).toEqual(perceptual.map(color => color[0]));
  expect(components.slice(12 + EDGE_COMPONENTS, 12 + EDGE_COMPONENTS * 2)).toEqual(separation.directions);
  expect(components.slice(EDGE_COLORS_OFFSET)).toEqual(perceptual.flat());
  expect(paletteComponents(["#101010"], [1], neutralCoverSeparation).length).toBe(components.length);
});

// Set AMBRA_TEST_CHROME to a Chromium executable to run the production GLSL in
// a real WebGL context. No JavaScript replica of the contrast algorithm is used.
test.skipIf(!process.env.AMBRA_TEST_CHROME)("rendered contrast has no invented bands, respects color contrast, and stays smooth and local", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ambra-cover-contrast-"));
  try {
    const fixtureColors = [[0,0,0], [.03,.03,.03], [.85,.85,.85], [.12,.26,.08], [.3,.3,.3], [.08,.08,.08], [226/255,0,1/255]];
    const metrics = Object.fromEntries(fixtureColors.map(rgb => {
      const edges = { colors: Array.from({ length: EDGE_COMPONENTS }, () => rgb).flat(), luminances: Array(EDGE_COMPONENTS).fill(rgb[0]*.2126+rgb[1]*.7152+rgb[2]*.0722) };
      const hex = "#" + rgb.map(channel => Math.round(channel * 255).toString(16).padStart(2, "0")).join("");
      return [JSON.stringify(rgb), {
        color: perceptualColor(rgb),
        directions: Object.fromEntries([1, .1].map(dim => [dim, coverSeparation(edges, [hex], [1], dim).directions[0]])),
      }];
    }));
    const shader = fragmentShaderSource.slice(0, fragmentShaderSource.indexOf("void main()")) + `
uniform vec3 u_testColor;
void main() {
  gl_FragColor = vec4(clamp(u_coverDim * separateFromCover(u_testColor), 0.0, 1.0), 1.0);
}`;
    const html = `<!doctype html><canvas width="512" height="512"></canvas><pre id="result"></pre><script>
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
  function program(fragment) {
    const result = gl.createProgram();
    gl.attachShader(result, compile(gl.VERTEX_SHADER, ${JSON.stringify(vertexShaderSource)}));
    gl.attachShader(result, compile(gl.FRAGMENT_SHADER, fragment));
    gl.linkProgram(result);
    if (!gl.getProgramParameter(result, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(result));
    return result;
  }
  // Compile the complete animated shader too, including its WebGL 1 uniform arrays.
  program(${JSON.stringify(fragmentShaderSource)});
  const p = program(${JSON.stringify(shader)});
  gl.useProgram(p);
  const buffer = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1,3,-1,-1,3]), gl.STATIC_DRAW);
  const position = gl.getAttribLocation(p, 'a_position');
  gl.enableVertexAttribArray(position); gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
  const uniform = name => gl.getUniformLocation(p, name);
  gl.uniform4fv(uniform('u_cover'), [256,256,128,46.08]);
  const metrics = ${JSON.stringify(metrics)};
  function render(background, samples, dim = 1, enabled = true) {
    gl.uniform3fv(uniform('u_testColor'), background);
    gl.uniform1f(uniform('u_coverDim'), dim);
    const edges = samples.map(color => metrics[JSON.stringify(color)]);
    gl.uniform3fv(uniform('u_edgeColors[0]'), edges.flatMap(edge => edge.color));
    gl.uniform4fv(uniform('u_edgeLuma[0]'), edges.map(edge => edge.color[0]));
    gl.uniform4fv(uniform('u_edgeDirection[0]'), edges.map(edge => enabled ? edge.directions[dim] : 0));
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    const pixels = new Uint8Array(512*512*4); gl.readPixels(0,0,512,512,gl.RGBA,gl.UNSIGNED_BYTE,pixels);
    if (gl.getError() !== gl.NO_ERROR) throw new Error('WebGL draw failed');
    return pixels;
  }
  const constant = color => Array.from({ length: ${EDGE_COMPONENTS} }, () => color);
  const at = (pixels, x, y, channel = 0) => pixels[(y*512+x)*4+channel];
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  function unchanged(background, samples, message) {
    const actual = render(background, samples);
    const original = render(background, samples, 1, false);
    for (let y = 0; y < 512; y++) for (let x = 0; x < 512; x++) {
      if (x >= 128 && x < 384 && y >= 128 && y < 384) continue;
      for (let c = 0; c < 3; c++) assert(at(actual,x,y,c) === at(original,x,y,c), message);
    }
  }
  unchanged([.25,.25,.25], Array.from({length:${EDGE_COMPONENTS}}, (_, i) => i < 16 ? [.03,.03,.03] : [.85,.85,.85]),
    'Interpolated bright/dark samples invented an unnecessary contrast band');
  unchanged([.42,.1708,.08], constant([.12,.26,.08]), 'Different hues with the same brightness were altered');
  unchanged([.08,.08,.08], constant([.3,.3,.3]), 'A distinct dark background was altered');
  const black = render([0,0,0], constant([0,0,0]));
  assert(at(black,385,256) >= 8 && at(black,385,256) <= 16, 'Black-on-black boundary still has no visible separation');
  // Screenshot regression: the cover is #e20001 and the adjacent swirl is
  // nearly the same saturated red. Adding a few white levels cannot separate it.
  const redEdge = constant([226/255,0,1/255]);
  unchanged([.42,0,0], redEdge, 'An already distinct darker red was altered');
  unchanged([0,.45,0], redEdge, 'A distinct green background was altered beside a red edge');
  const correctedReds = [];
  for (const background of [[227/255,2/255,3/255], [235/255,2/255,3/255]]) {
    const red = render(background, redEdge);
    correctedReds.push(at(red,385,256));
    assert(at(red,385,256) <= 206, 'Saturated red still disappears into the matching swirl');
    assert(at(red,385,256,1) <= 3 && at(red,385,256,2) <= 4, 'Red contrast correction introduced a pink halo');
  }
  assert(correctedReds[1] > correctedReds[0], 'Contrast correction flattened the moving red field into a fixed stripe');
  const edge = constant([.08,.08,.08]);
  const match = render([.08,.08,.08], edge);
  const original = render([.08,.08,.08], edge, 1, false);
  const near = at(match,385,256) - at(original,385,256);
  assert(near >= 10 && near <= 25, 'Missing or excessive correction at an indistinguishable dark edge');
  for (let x = 384; x < 450; x++) {
    assert(Math.abs(at(match,x+1,256)-at(match,x,256)) <= 3, 'Hard boundary in the radial fade');
  }
  assert(at(match,420,256) === at(original,420,256), 'Correction spread beyond the edge strip');
  const shaded = render([.8,.8,.8], edge, .1);
  assert(at(shaded,385,256) < at(original,385,256) - 8, 'Overlay left too little headroom to lift, but the field did not darken instead');
  const mixed = render([.08,.08,.08], Array.from({length:${EDGE_COMPONENTS}}, (_, i) => Math.floor(i/4)%2 ? [.85,.85,.85] : [.08,.08,.08]));
  for (let y = 110; y < 404; y++) {
    assert(Math.abs(at(mixed,385,y+1)-at(mixed,385,y)) <= 2, 'Hard band between edge samples');
  }
  document.getElementById('result').textContent = JSON.stringify({ok:true, nearCorrectionLevels:near});
} catch (error) { document.getElementById('result').textContent = JSON.stringify({error:String(error)}); }
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
