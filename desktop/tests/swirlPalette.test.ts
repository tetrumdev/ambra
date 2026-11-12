import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { swirlPalette } from "../src/utils/artworkPalette";
import {
  SWIRL_SHADE_MIN, SWIRL_SHADE_RANGE, fragmentShaderSource, paletteComponents, vertexShaderSource,
} from "../src/utils/swirlShader";

// Real server palettes, edge samples included, that the old edge-contrast solver crushed or muddied.
const covers = {
  clancy: ["#de4036", "#fbdc21", "#2f2a29", "#ec8730"],
  coldSpringHarbor: ["#1b1b1b", "#eff0f1", "#979797", "#515151"],
  theStranger: ["#1e1c1c", "#e7e7e7", "#909090", "#515150"],
  wildHoney: ["#463939", "#ece4e2", "#deac59", "#a94245"],
  okComputer: ["#f0ede9", "#634636", "#71929a", "#8e6a54"],
};
const edges = Array.from({ length: 96 }, (_, index) => [0.9, 0.2, 0.1, 0.95][index % 4]);

test("the swirl is drawn from the cover's own colors, whatever its edges look like", () => {
  for (const colors of Object.values(covers)) {
    const weights = [0.4, 0.3, 0.2, 0.1];
    expect(swirlPalette({ colors, weights, edgeColors: edges }).colors).toEqual(colors);
    expect(swirlPalette({ colors, weights }).weights).toEqual(weights);
  }
});

test("a cover too uniform to swirl still gets its shades spread apart", () => {
  const colors = ["#202020", "#222222", "#242424", "#262626"];
  const spread = swirlPalette({ colors, weights: [0.25, 0.25, 0.25, 0.25] }).colors;
  expect(spread).not.toEqual(colors);
  expect(new Set(spread).size).toBe(4);
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
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([128, 128, 128, 128]));
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
