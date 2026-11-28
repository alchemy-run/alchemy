import { plugin as htmlServer } from "@effect/ui/html/HtmlServerVite";
import { defineConfig } from "vite";

// Hybrid: the build prerenders `src/prerender.ts`'s pages and emits a server
// handler for every other request.
export default defineConfig({
  build: { outDir: "dist/client" },
  plugins: [htmlServer({ entry: "/src/entry.server.ts", serverOutDir: "dist/server" })],
});
