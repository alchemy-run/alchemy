import { plugin as htmlServer } from "@effect/ui/html/HtmlServerVite";
import { defineConfig } from "vite";

// SSG: no `serverOutDir`, so the build keeps only the prerendered pages.
export default defineConfig({
  plugins: [htmlServer({ entry: "/src/entry.server.ts" })],
});
