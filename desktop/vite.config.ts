import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { keyboardHover } from "./keyboardHover";

const host = process.env.TAURI_DEV_HOST;

/**
 * Plain modules (api, hooks, utils) hold app-wide state: the session stream, the playback
 * clock, the server connection. Hot-swapping one leaves the old copy running beside the new,
 * so the player can follow a dead copy while audio keeps playing. Reload the page instead;
 * playback lives in the server and the native engine, so it carries on undisturbed.
 */
function reloadOnStatefulModuleChange(): Plugin {
  return {
    name: "ambra-reload-stateful-modules",
    apply: "serve",
    hotUpdate({ file }) {
      if (this.environment.name !== "client") return;
      if (!/\/src\/.*\.(ts|js|mjs)$/.test(file.replace(/\\/g, "/"))) return;
      this.environment.hot.send({ type: "full-reload", path: "*" });
      return [];
    },
  };
}

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react(), reloadOnStatefulModuleChange()],
  css: {
    postcss: { plugins: [keyboardHover()] },
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
