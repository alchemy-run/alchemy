import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    cloudflare({
      persistState: process.env.ALCHEMY_CLOUDFLARE_PERSIST_PATH
        ? {
            path: process.env.ALCHEMY_CLOUDFLARE_PERSIST_PATH,
          }
        : undefined,
    }),
  ],
});
