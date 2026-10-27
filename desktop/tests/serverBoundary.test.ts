import { expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";

const root = resolve(import.meta.dir, "../..");
const read = (path: string) => readFileSync(join(root, path), "utf8");

test("desktop and mobile build hooks never build, package, or launch server rendering", () => {
  const files = [
    "desktop/package.json", "desktop/src-tauri/Cargo.toml", "desktop/src-tauri/build.rs",
    "desktop/src-tauri/tauri.conf.json", "desktop/src-tauri/tauri.updater.conf.json",
    "mobile/package.json", "mobile/scripts/build-network.sh", "mobile/scripts/build-sidestore.sh",
    "crates/ambra-mobile-bridge/Cargo.toml", "crates/ambra-net/Cargo.toml",
  ];
  for (const file of files) {
    expect(read(file), file).not.toMatch(/ambra[-_]server|soloist|librespot|externalBin|(?:\.\.\/)+server(?:\/|\b)|build-server|start-server|sidecar\s*\(/i);
  }
});

function sourceFiles(directory: string): string[] {
  return readdirSync(join(root, directory), { withFileTypes: true }).flatMap(entry => {
    const path = `${directory}/${entry.name}`;
    return entry.isDirectory() ? sourceFiles(path) : /\.(rs|tsx?|swift|kt)$/.test(path) ? [path] : [];
  });
}

test("clients contain no server host or Spotify capture implementation", () => {
  for (const file of [...sourceFiles("desktop/src-tauri/src"), ...sourceFiles("mobile/modules"), ...sourceFiles("desktop/src/api")]) {
    expect(read(file), file).not.toMatch(/ActivateAudioInterfaceAsync|AudioHardwareCreateProcessTap|module-pipe-sink|librespot::|librespot[-_](?:core|audio|playback)|soloist\/(?:install|pair|reset|sign-out)|start_local_server|Command::new\([^\n]*ambra-server|sidecar\s*\(/);
  }
  const api = read("desktop/src/api/spotifyPlayback.ts");
  expect(api).not.toContain("POST");
  expect(api).not.toContain("/api/local/");
  expect(api).toContain("/api/spotify/playback/status");
});
