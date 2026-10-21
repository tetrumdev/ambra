// Builds the server for the target Tauri is building and places it where Tauri bundles it
// beside the app: desktop/src-tauri/binaries/ambra-server-<target-triple>[.exe].
// Tauri runs this before every dev and release build (desktop/src-tauri/tauri.conf.json).
import { copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const manifest = join(root, "server", "Cargo.toml");
const binaries = join(root, "desktop", "src-tauri", "binaries");
// Development builds compile much faster and are still quick enough to serve one listener.
const release = process.env.TAURI_ENV_DEBUG !== "true";
const profile = release ? "release" : "debug";

function run(command: string[]) {
  const result = Bun.spawnSync(command, { stdio: ["inherit", "inherit", "inherit"] });
  if (result.exitCode !== 0) process.exit(result.exitCode ?? 1);
}

function hostTriple() {
  const output = Bun.spawnSync(["rustc", "-vV"]).stdout.toString();
  const host = output.match(/^host: (.+)$/m)?.[1];
  if (!host) throw new Error("Could not read the Rust host target from `rustc -vV`.");
  return host;
}

function build(triple: string) {
  run(["cargo", "build", "--manifest-path", manifest, "--target", triple, ...(release ? ["--release"] : [])]);
  const suffix = triple.includes("windows") ? ".exe" : "";
  return join(root, "server", "target", triple, profile, `ambra-server${suffix}`);
}

const triple = process.env.TAURI_ENV_TARGET_TRIPLE || hostTriple();
mkdirSync(binaries, { recursive: true });

if (triple === "universal-apple-darwin") {
  // One binary that runs on both Apple Silicon and Intel, matching the universal app.
  const slices = ["aarch64-apple-darwin", "x86_64-apple-darwin"].map(build);
  run(["lipo", "-create", "-output", join(binaries, `ambra-server-${triple}`), ...slices]);
} else {
  const suffix = triple.includes("windows") ? ".exe" : "";
  copyFileSync(build(triple), join(binaries, `ambra-server-${triple}${suffix}`));
}
console.log(`Bundled the Ambra server for ${triple} (${profile})`);
