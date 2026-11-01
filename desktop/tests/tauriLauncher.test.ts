import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cargoPath, developmentDesktopEntry, tauriEnvironment } from "../scripts/tauri";

test("Tauri can find Rust installed by rustup outside the inherited PATH", () => {
  const inheritedPath = join(homedir(), "existing-tools");
  expect(cargoPath(inheritedPath).split(delimiter)).toEqual([
    inheritedPath,
    join(homedir(), ".cargo", "bin"),
  ]);
});

test("Tauri respects CARGO_HOME without overriding inherited tools", () => {
  const inheritedPath = ["first-tools", "second-tools"].join(delimiter);
  const cargoHome = join(homedir(), "custom-rust");
  expect(cargoPath(inheritedPath, cargoHome).split(delimiter)).toEqual([
    "first-tools",
    "second-tools",
    join(cargoHome, "bin"),
  ]);
});

test("Tauri handles an absent PATH without adding the current directory", () => {
  const expectedPath = join(homedir(), ".cargo", "bin");
  expect(cargoPath(undefined)).toBe(expectedPath);
  expect(cargoPath("")).toBe(expectedPath);
});

test("NVIDIA Wayland startup disables explicit sync without disabling GPU rendering", () => {
  const inherited = { PATH: "/usr/bin", WAYLAND_DISPLAY: "wayland-1", CARGO_HOME: "/custom/rust" };
  const environment = tauriEnvironment(inherited, "linux", true);
  expect(environment.__NV_DISABLE_EXPLICIT_SYNC).toBe("1");
  expect(environment.PATH).toBe(["/usr/bin", "/custom/rust/bin"].join(delimiter));
  expect(environment.WAYLAND_DISPLAY).toBe("wayland-1");
  expect(environment.GDK_BACKEND).toBeUndefined();
  expect(environment.WEBKIT_DISABLE_DMABUF_RENDERER).toBeUndefined();
  expect(environment.WEBKIT_DISABLE_COMPOSITING_MODE).toBeUndefined();
  expect(inherited).not.toHaveProperty("__NV_DISABLE_EXPLICIT_SYNC");
});

test("NVIDIA startup preserves explicit user overrides", () => {
  for (const override of ["0", "1", ""]) {
    const environment = tauriEnvironment({
      WAYLAND_DISPLAY: "wayland-1",
      __NV_DISABLE_EXPLICIT_SYNC: override,
      WEBKIT_DISABLE_DMABUF_RENDERER: "1",
    }, "linux", true);
    expect(environment.__NV_DISABLE_EXPLICIT_SYNC).toBe(override);
    expect(environment.WEBKIT_DISABLE_DMABUF_RENDERER).toBe("1");
  }
});

test("Startup leaves non-NVIDIA and X11 rendering unchanged", () => {
  expect(tauriEnvironment({ WAYLAND_DISPLAY: "wayland-1" }, "linux", false).__NV_DISABLE_EXPLICIT_SYNC).toBeUndefined();
  expect(tauriEnvironment({ DISPLAY: ":0" }, "linux", true).__NV_DISABLE_EXPLICIT_SYNC).toBeUndefined();
  expect(tauriEnvironment({ WAYLAND_DISPLAY: "wayland-1", GDK_BACKEND: "x11" }, "linux", true).__NV_DISABLE_EXPLICIT_SYNC).toBeUndefined();
});

test("Startup leaves non-Linux platforms unchanged", () => {
  for (const platform of ["darwin", "win32"] as const) {
    expect(tauriEnvironment({ WAYLAND_DISPLAY: "wayland-1" }, platform, true).__NV_DISABLE_EXPLICIT_SYNC).toBeUndefined();
  }
});

test("Tauri launcher forwards arguments in a non-login environment", () => {
  const result = Bun.spawnSync([
    process.execPath,
    fileURLToPath(new URL("../scripts/tauri.ts", import.meta.url)),
    "--help",
  ], { env: { ...process.env, PATH: "" } });
  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).toContain("Usage:");
});

test("Tauri launcher preserves CLI failures", () => {
  const result = Bun.spawnSync([
    process.execPath,
    fileURLToPath(new URL("../scripts/tauri.ts", import.meta.url)),
    "ambra-invalid-command",
  ]);
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr.toString()).toContain("ambra-invalid-command");
});

test("Development desktop entry matches the Wayland app ID and stays out of menus", () => {
  const entry = developmentDesktopEntry("/repo/target/debug/AMBRA", "/user data/icons/ambra-dev.png");
  expect(entry).toContain("StartupWMClass=AMBRA");
  expect(entry).toContain("Icon=/user data/icons/ambra-dev.png\n");
  expect(entry).not.toContain("Icon=ambra\n");
  expect(entry).toContain("NoDisplay=true");
  expect(entry).toContain('Exec="/repo/target/debug/AMBRA"');
});

test.skipIf(process.platform !== "linux")("Linux launcher installs a directly loadable PNG and refreshes desktop metadata", () => {
  const directory = mkdtempSync(join(tmpdir(), "ambra icon test "));
  const dataHome = join(directory, "data");
  const toolDirectory = join(directory, "bin");
  const refreshMarker = join(directory, "refreshed");
  try {
    mkdirSync(toolDirectory);
    writeFileSync(join(toolDirectory, "kbuildsycoca6"), '#!/bin/sh\nprintf refreshed > "$AMBRA_TEST_REFRESH"\n', { mode: 0o755 });
    const result = Bun.spawnSync([
      process.execPath,
      fileURLToPath(new URL("../scripts/tauri.ts", import.meta.url)),
      "dev",
      "--help",
    ], {
      env: {
        ...process.env,
        XDG_DATA_HOME: dataHome,
        PATH: [toolDirectory, process.env.PATH].filter(Boolean).join(delimiter),
        AMBRA_TEST_REFRESH: refreshMarker,
      },
    });
    expect(result.exitCode).toBe(0);
    const iconPath = join(dataHome, "icons", "ambra-dev.png");
    expect(readFileSync(join(dataHome, "applications", "AMBRA.desktop"), "utf8")).toContain(`Icon=${iconPath}\n`);
    expect(readFileSync(iconPath)).toEqual(readFileSync(new URL("../src-tauri/icons/macIcon.png", import.meta.url)));
    expect(readFileSync(refreshMarker, "utf8")).toBe("refreshed");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
