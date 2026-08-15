import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // During `alchemy dev` the backend Lambda serves /api/* from the local
    // emulator at the stack's `serverUrl` output — point VITE_API_PROXY at
    // it to exercise the API through the Vite dev server.
    proxy: process.env.VITE_API_PROXY
      ? {
          "/api": {
            target: process.env.VITE_API_PROXY,
            changeOrigin: true,
          },
        }
      : undefined,
  },
});
