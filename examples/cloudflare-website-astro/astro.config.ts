// Alchemy loads this config natively — no adapter or `output` needed here,
// the Cloudflare adapter is managed by `Cloudflare.Website.Astro`.
import react from "@astrojs/react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "astro/config";

export default defineConfig({
  integrations: [react()],
  vite: {
    plugins: [tailwindcss()],
  },
});
