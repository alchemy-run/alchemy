import react from "@vitejs/plugin-react";
import alchemy from "alchemy/cloudflare/vite";
import { defineConfig, type PluginOption } from "vite";

// https://vite.dev/config/
export default defineConfig({
  // the type coercion is necessary because of linker: isolated combined with the project reference
  plugins: [alchemy() as PluginOption, react()],
});
