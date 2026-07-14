import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { hashPlugin as effectHashPlugin } from "./experimental-hash-plugin-effect.ts";
import { hashPlugin as nodeHashPlugin } from "./experimental-hash-plugin.ts";

const hashPlugin =
  process.env.HASH_IMPL === "effect" ? effectHashPlugin : nodeHashPlugin;

export default defineConfig({
  build: {
    rolldownOptions: {
      external: ["cloudflare:workers"],
    },
  },
  plugins: [tanstackStart(), viteReact(), hashPlugin()],
});
