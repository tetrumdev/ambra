import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The phone remote, served by the server at /remote/ (server/src/remote.rs).
export default defineConfig({
  plugins: [react()],
  root: "remote",
  base: "/remote/",
  publicDir: "../public",
  clearScreen: false,
  build: {
    outDir: "../dist-remote",
    emptyOutDir: true,
  },
});
