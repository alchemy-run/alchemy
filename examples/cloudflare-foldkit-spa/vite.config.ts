import { defineConfig } from "vite";

import { foldkit } from "@foldkit/vite-plugin";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [tailwindcss(), foldkit()],
  optimizeDeps: {
    entries: ["src/entry.ts"],
  },
});
