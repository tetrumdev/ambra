import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

export function cargoPath(path: string | undefined, cargoHome = join(homedir(), ".cargo")) {
  return [path, join(cargoHome, "bin")].filter(Boolean).join(delimiter);
}

export function tauriEnvironment(
  inherited: NodeJS.ProcessEnv,
  platform = process.platform,
  nvidiaLoaded = existsSync("/sys/module/nvidia"),
) {
  const environment = {
    ...inherited,
    PATH: cargoPath(inherited.PATH, inherited.CARGO_HOME || undefined),
  };
  if (platform === "linux" && inherited.WAYLAND_DISPLAY && inherited.GDK_BACKEND !== "x11" && nvidiaLoaded) {
    environment.__NV_DISABLE_EXPLICIT_SYNC ??= "1";
  }
  return environment;
}

/**
 * Wayland compositors find a window's icon through the desktop entry named after its app ID,
 * which for the unbundled development binary is its file name. The entry stays hidden from menus.
 */
export function developmentDesktopEntry(binary: string, icon: string) {
  return [
    "[Desktop Entry]",
    "Type=Application",
    "Name=AMBRA",
    `Exec="${binary}"`,
    `Icon=${icon}`,
    "StartupWMClass=AMBRA",
    "NoDisplay=true",
    "",
  ].join("\n");
}

function installDevelopmentDesktopEntry() {
  const dataHome = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  const sourceDirectory = fileURLToPath(new URL("../src-tauri/", import.meta.url));
  const iconDirectory = join(dataHome, "icons");
  const iconPath = join(iconDirectory, "ambra-dev.png");
  const applicationsDirectory = join(dataHome, "applications");
  const entryPath = join(applicationsDirectory, "AMBRA.desktop");
  const entry = developmentDesktopEntry(join(sourceDirectory, "target", "debug", "AMBRA"), iconPath);
  try {
    mkdirSync(iconDirectory, { recursive: true });
    mkdirSync(applicationsDirectory, { recursive: true });
    copyFileSync(join(sourceDirectory, "icons", "macIcon.png"), iconPath);
    let current = "";
    try { current = readFileSync(entryPath, "utf8"); } catch {}
    if (current !== entry) {
      writeFileSync(entryPath, entry);
      // Plasma reads desktop entries from a cache; other desktops rescan on their own.
      spawnSync("kbuildsycoca6", { stdio: "ignore" });
    }
  } catch (error) {
    console.warn(`Could not register the development window icon: ${error}`);
  }
}

if (import.meta.main) {
  if (process.platform === "linux" && process.argv[2] === "dev") installDevelopmentDesktopEntry();

  const child = Bun.spawn([
    process.execPath,
    fileURLToPath(import.meta.resolve("@tauri-apps/cli/tauri.js")),
    ...process.argv.slice(2),
  ], {
    env: tauriEnvironment(process.env),
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => child.kill(signal));
  }
  process.exitCode = await child.exited;
}
