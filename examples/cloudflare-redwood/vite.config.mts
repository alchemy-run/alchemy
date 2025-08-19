import alchemy from "alchemy/cloudflare/redwood";
import { defineConfig, type PluginOption } from "vite";

export default defineConfig({
  plugins: [alchemy() as PluginOption],
});
