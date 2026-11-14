import { foldkit } from "@foldkit/vite-plugin";
import { defineConfig } from "vite";

// Alchemy injects its own Cloudflare plugin and sets this flag before the
// config loads, so a config guarding its own `cloudflare()` on it skips it.
if (process.env.ALCHEMY_CLOUDFLARE_VITE_INJECTED !== "1") {
  throw new Error("ALCHEMY_CLOUDFLARE_VITE_INJECTED is not set");
}

export default defineConfig({
  plugins: [foldkit()],
  optimizeDeps: {
    entries: ["src/entry.ts"],
  },
});
