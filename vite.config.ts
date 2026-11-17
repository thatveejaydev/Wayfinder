import { readdir } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { defineConfig, type Plugin } from "vite";

/**
 * Serves every Lucide icon as one module keyed by its canonical id. Importing Lucide's
 * per-icon files directly would make the dev server load ~2,000 modules each time a
 * window opens, and the package's `icons` export also repeats icons under old aliases.
 */
function lucideIcons(): Plugin {
  const id = "virtual:lucide-icons";
  const resolvedId = `\0${id}`;
  const directory = fileURLToPath(new URL("./node_modules/lucide/dist/esm/icons/", import.meta.url));
  let source: Promise<string> | undefined;
  const build = async () => {
    const files = (await readdir(directory)).filter((file) => file.endsWith(".mjs")).sort();
    const entries = await Promise.all(files.map(async (file) => {
      const module = await import(pathToFileURL(directory + file).href);
      return [file.slice(0, -".mjs".length), module.default] as const;
    }));
    return `export default ${JSON.stringify(Object.fromEntries(entries))};`;
  };
  return {
    name: "lucide-icons",
    resolveId: (source) => (source === id ? resolvedId : null),
    load(loadId) {
      if (loadId !== resolvedId) return null;
      source ??= build();
      return source;
    },
  };
}

export default defineConfig({
  clearScreen: false,
  plugins: [lucideIcons()],
  // The bundled Lucide icon set (~2,000 icons for the icon picker) is loaded from disk, not the network.
  build: { chunkSizeWarningLimit: 1000 },
  server: {
    host: "127.0.0.1",
    port: 1420,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/**"] },
  },
});
