// Alchemy loads this config natively — no adapter or `output` needed here,
// the Archil sandbox adapter is managed by `Archil.Website.Astro`.
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "astro/config";

export default defineConfig({
  vite: {
    plugins: [tailwindcss()],
  },
});
