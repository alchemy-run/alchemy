import { defineConfig } from "vite";

export default defineConfig({
  optimizeDeps: {
    entries: ["src/entry.ts"],
    // Pre-bundle the Effect barrels, so dev serves one copy of Effect.
    include: ["effect", "effect/Function", "effect/http", "@effect/ui", "@effect/ui/html"],
  },
});
