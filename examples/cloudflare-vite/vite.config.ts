import react from "@vitejs/plugin-react";
import { alchemyVitePlugin } from "alchemy/cloudflare/vite-plugin";
import { defineConfig } from "vite";

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), alchemyVitePlugin()],
});
