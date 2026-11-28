import { plugin as htmlServer } from "@effect/ui/html/HtmlServerVite";
import { defineConfig } from "vite";

// SSR: every page renders on request; nothing is prerendered.
export default defineConfig({
  build: { outDir: "dist/client" },
  plugins: [htmlServer({ entry: "/src/entry.server.ts", serverOutDir: "dist/server" })],
});
