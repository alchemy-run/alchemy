import type { PluginConfig } from "@cloudflare/vite-plugin";
import alchemyVite from "../vite/plugin.ts";

export default function alchemy(options: PluginConfig = {}) {
  return alchemyVite({
    viteEnvironment: { name: "ssr" },
    ...options,
  });
}
