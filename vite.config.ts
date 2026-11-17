import { defineConfig } from "vite";

export default defineConfig({
  clearScreen: false,
  // The bundled Lucide icon set (~2,000 icons for the icon picker) is loaded from disk, not the network.
  build: { chunkSizeWarningLimit: 1000 },
  server: {
    host: "127.0.0.1",
    port: 1420,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/**"] },
  },
});
