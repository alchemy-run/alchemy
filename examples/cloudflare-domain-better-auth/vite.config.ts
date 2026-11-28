import { defineConfig } from "vite";

export default defineConfig({
  optimizeDeps: {
    entries: ["src/web/entry.ts"],
    include: ["effect", "effect/Function", "effect/http", "@effect/ui", "@effect/ui/html"],
  },
});
